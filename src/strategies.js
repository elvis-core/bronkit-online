// Scheduled-strategy engine. A strategy is stored config (set once via chat) that,
// when its trigger fires, PREPARES transaction(s) — each lands in the Bron app to
// sign. Preparing is standing authorisation; signing always stays on the phone
// (MPC). Firing NEVER acts on stored numbers: it re-reads the live balance/price
// each run and decides fresh.
//
// Types, all built on existing tools (no derivatives/lending — no primitive exists):
//   dca           — time schedule  → swap a fixed amount A->B (bron_tx_swap)
//   idle_to_stake — idle balance   → stake the excess over a threshold (bron_tx_staking)
//   de_risk       — price crosses down to/below a level → swap a holding to a stable
//   price_target  — price crosses to/through a target (above|below) → swap
//
// Price triggers (de_risk, price_target) fire on a CROSSING, once per cross:
//  - they store the price observed at the previous run (lastObservedPrice);
//  - fire only when the price moved from the wrong side of the target to the right
//    side (so a strategy created already past its target does NOT fire — a cross is
//    required after creation);
//  - after firing they disarm (armed=false) so coarse (e.g. hourly) ticks don't
//    prepare duplicates; they re-arm when the price crosses back to the wrong side,
//    or when the user re-enables the strategy;
//  - always read the LIVE price at evaluation time, never a stored number.

import Decimal from "decimal.js";
import { swapTool } from "./tools/intents.js";
import { stakingTxTool } from "./tools/writes.js";
import { fetchUsdPriceMap } from "./util/prices.js";

export const STRATEGY_TYPES = ["dca", "idle_to_stake", "de_risk", "price_target"];

const ws = (ctx) => `/workspaces/${ctx.workspaceId}`;
const nowIso = () => new Date().toISOString();

function dec(v) {
  try {
    return new Decimal(v == null || v === "" ? 0 : v);
  } catch {
    return new Decimal(0);
  }
}

// ---- validation -----------------------------------------------------------

function req(p, keys) {
  for (const k of keys) {
    if (p == null || p[k] == null || p[k] === "") throw new Error(`Missing required param: ${k}`);
  }
}
function posAmount(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
}
function nonNeg(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number >= 0`);
}

// Validate params for a type and derive the trigger descriptor. Returns { trigger }.
export function validateStrategy(type, params = {}) {
  switch (type) {
    case "dca":
      // accountId added beyond the bare spec: bron_tx_swap requires a source account.
      req(params, ["accountId", "fromAssetId", "toAssetId", "amount", "schedule"]);
      posAmount(params.amount, "amount");
      return { trigger: { kind: "schedule", schedule: String(params.schedule) } };
    case "idle_to_stake":
      req(params, ["accountId", "assetId", "threshold"]);
      nonNeg(params.threshold, "threshold");
      return { trigger: { kind: "idle_above", assetId: params.assetId, threshold: String(params.threshold) } };
    case "de_risk": {
      req(params, ["accountId", "assetId", "triggerPrice", "toAssetId"]);
      posAmount(params.triggerPrice, "triggerPrice");
      const hasAmt = params.amount != null && params.amount !== "";
      const hasPct = params.percent != null && params.percent !== "";
      if (hasAmt === hasPct) throw new Error("de_risk needs exactly one of amount or percent");
      if (hasAmt) posAmount(params.amount, "amount");
      if (hasPct) {
        const n = Number(params.percent);
        if (!(n > 0 && n <= 100)) throw new Error("percent must be in (0, 100]");
      }
      return { trigger: { kind: "price_below", assetId: params.assetId, triggerPrice: String(params.triggerPrice) } };
    }
    case "price_target": {
      // "sell/buy when price hits N". accountId added: the swap needs a source account.
      req(params, ["accountId", "assetId", "direction", "targetPrice", "fromAssetId", "toAssetId", "amount"]);
      if (params.direction !== "above" && params.direction !== "below") {
        throw new Error("direction must be 'above' or 'below'");
      }
      posAmount(params.targetPrice, "targetPrice");
      posAmount(params.amount, "amount");
      return { trigger: { kind: "price_cross", assetId: params.assetId, direction: params.direction, targetPrice: String(params.targetPrice) } };
    }
    default:
      throw new Error(`Unknown strategy type: ${type}. Allowed: ${STRATEGY_TYPES.join(", ")}`);
  }
}

// ---- live condition reads (never use stored numbers) ----------------------

async function readBalanceField(ctx, accountId, assetId, field) {
  const data = await ctx.client.get(`${ws(ctx)}/balances`, { nonEmpty: true });
  const rows = (data && Array.isArray(data.balances) && data.balances) || [];
  let total = new Decimal(0);
  for (const b of rows) {
    if (b && b.accountId === accountId && b.assetId === assetId) total = total.plus(dec(b[field]));
  }
  return total;
}
const readIdle = (ctx, accountId, assetId) => readBalanceField(ctx, accountId, assetId, "withdrawableBalance");
const readHeld = (ctx, accountId, assetId) => readBalanceField(ctx, accountId, assetId, "totalBalance");

async function readPrice(ctx, assetId) {
  const map = await fetchUsdPriceMap(ctx.client, [assetId]);
  const p = map.get(assetId);
  if (!p || !p.price) throw new Error(`no live price available for asset ${assetId}`);
  return new Decimal(p.price);
}

// ---- preparing (via the existing tools, each independent) ------------------

function rationale(s, detail) {
  return `[bronkit strategy ${s.id} · ${s.type}] ${detail} — fired ${nowIso()}`;
}

async function prepareSwap(ctx, { accountId, fromAssetId, toAssetId, fromAmount, description }) {
  try {
    const result = await swapTool.handler(ctx, {
      action: "create",
      accountId,
      fromAssetId,
      toAssetId,
      fromAmount,
      description,
      maxWaitSeconds: 60,
    });
    return { ok: !result.signableTransactionError, kind: "swap", description, result };
  } catch (e) {
    return { ok: false, kind: "swap", description, error: e.message };
  }
}

async function prepareStake(ctx, { accountId, assetId, amount, description }) {
  try {
    const result = await stakingTxTool.handler(ctx, {
      action: "delegate",
      accountId,
      assetId,
      amount,
      description,
      dryRun: false,
    });
    return { ok: true, kind: "stake", description, result };
  } catch (e) {
    return { ok: false, kind: "stake", description, error: e.message };
  }
}

// ---- price-crossing evaluation (de_risk, price_target) --------------------

// Shared crossing/fire-once engine. Reads the LIVE price, compares against the
// price at the previous run, and prepares only on a genuine cross from the wrong
// side of the target to the right side. Persists lastObservedPrice + armed so the
// decision survives across (coarse) ticks. `isRightSide(price)` returns true when
// the price is on the "target reached" side; `prepareFn({ price })` builds the tx.
async function evaluatePriceTrigger(ctx, s, { assetId, target, isRightSide, prepareFn }) {
  const now = await readPrice(ctx, assetId); // LIVE, every run
  const prev = s.lastObservedPrice == null || s.lastObservedPrice === "" ? null : dec(s.lastObservedPrice);
  const armed = s.armed !== false; // default armed
  const rightNow = isRightSide(now);

  let fired = false;
  let reason;
  let prepared = [];
  let newArmed = armed;

  if (prev == null) {
    // First run after creation: establish the baseline, never fire. A cross is
    // required after creation — even if already past target, this run won't fire.
    reason = `baseline set at ${now} (target ${target}); a cross is required before firing`;
  } else if (!armed) {
    // Already fired this cross. Re-arm only when price returns to the wrong side.
    if (!rightNow) {
      newArmed = true;
      reason = `re-armed: price ${now} back on the wrong side of ${target}`;
    } else {
      reason = `already fired; price ${now} still past target ${target} — waiting to re-arm`;
    }
  } else if (!isRightSide(prev) && rightNow) {
    // Armed + crossed from wrong side to right side (handles skipping past the
    // exact target between coarse ticks — we compare sides, not equality).
    fired = true;
    newArmed = false;
    reason = `crossed: price ${prev} -> ${now}, target ${target}`;
    prepared = await prepareFn({ price: now });
  } else {
    reason = rightNow
      ? `no cross: price ${now} already on the target side of ${target}`
      : `no cross: price ${now} on the wrong side of ${target}`;
  }

  // Persist the observed price + armed state for the next tick.
  ctx.store.updateStrategy(ctx.userId, s.id, { lastObservedPrice: now.toString(), armed: newArmed });
  return { fired, reason, conditionValue: now.toString(), prepared };
}

// ---- firing ---------------------------------------------------------------

// Evaluate ONE strategy against live data and prepare transaction(s) if tripped.
// Returns { fired, reason, conditionValue, prepared:[...] }. Each prepared entry
// is independent — a failure in one does not abort the others, and none assumes a
// prior one settled.
export async function fireStrategy(ctx, s) {
  const p = s.params || {};
  switch (s.type) {
    case "dca": {
      // Time trigger: the scheduler (Cowork clock) decides WHEN; we prepare the swap.
      const description = rationale(s, `scheduled DCA: swap ${p.amount} of ${p.fromAssetId} -> ${p.toAssetId}`);
      const prepared = [await prepareSwap(ctx, { accountId: p.accountId, fromAssetId: p.fromAssetId, toAssetId: p.toAssetId, fromAmount: String(p.amount), description })];
      return { fired: true, reason: "scheduled", conditionValue: null, prepared };
    }
    case "idle_to_stake": {
      const idle = await readIdle(ctx, p.accountId, p.assetId); // live
      const threshold = dec(p.threshold);
      if (idle.lte(threshold)) {
        return { fired: false, reason: `idle ${idle} <= threshold ${threshold}`, conditionValue: idle.toString(), prepared: [] };
      }
      const excess = idle.minus(threshold).toString();
      const description = rationale(s, `idle ${idle} > threshold ${threshold}; staking excess ${excess} of ${p.assetId}`);
      const prepared = [await prepareStake(ctx, { accountId: p.accountId, assetId: p.assetId, amount: excess, description })];
      return { fired: true, reason: `idle ${idle} > threshold ${threshold}`, conditionValue: idle.toString(), prepared };
    }
    case "de_risk": {
      // Price crosses DOWN to/below triggerPrice → swap to the stable. Fire-once.
      const target = dec(p.triggerPrice);
      return evaluatePriceTrigger(ctx, s, {
        assetId: p.assetId,
        target,
        isRightSide: (price) => price.lte(target),
        prepareFn: async ({ price }) => {
          let amount = p.amount;
          if (amount == null || amount === "") {
            const held = await readHeld(ctx, p.accountId, p.assetId); // live
            amount = held.times(dec(p.percent)).div(100).toString();
          }
          const description = rationale(
            s,
            `de_risk: ${p.assetId} price ${price} crossed <= target ${target} — swapping ${amount} ${p.assetId} -> ${p.toAssetId}`
          );
          return [await prepareSwap(ctx, { accountId: p.accountId, fromAssetId: p.assetId, toAssetId: p.toAssetId, fromAmount: String(amount), description })];
        },
      });
    }
    case "price_target": {
      // Price crosses to/through targetPrice in `direction` → swap. Fire-once.
      const target = dec(p.targetPrice);
      const isRightSide = p.direction === "above" ? (price) => price.gte(target) : (price) => price.lte(target);
      return evaluatePriceTrigger(ctx, s, {
        assetId: p.assetId,
        target,
        isRightSide,
        prepareFn: async ({ price }) => {
          const description = rationale(
            s,
            `price_target: ${p.assetId} hit ${price}, target ${target} (${p.direction}) — swapping ${p.amount} ${p.fromAssetId} -> ${p.toAssetId}`
          );
          return [await prepareSwap(ctx, { accountId: p.accountId, fromAssetId: p.fromAssetId, toAssetId: p.toAssetId, fromAmount: String(p.amount), description })];
        },
      });
    }
    default:
      throw new Error(`Unknown strategy type: ${s.type}`);
  }
}
