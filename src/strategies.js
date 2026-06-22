// Scheduled-strategy engine. A strategy is stored config (set once via chat) that,
// when its trigger fires, PREPARES transaction(s) — each lands in the Bron app to
// sign. Preparing is standing authorisation; signing always stays on the phone
// (MPC). Firing NEVER acts on stored numbers: it re-reads the live balance/price
// each run and decides fresh.
//
// Only three types, all built on existing tools (no derivatives/lending — no
// primitive exists):
//   dca           — time schedule  → swap a fixed amount A->B (bron_tx_swap)
//   idle_to_stake — idle balance   → stake the excess over a threshold (bron_tx_staking)
//   de_risk       — price drop     → swap a volatile holding to a stable (bron_tx_swap)

import Decimal from "decimal.js";
import { swapTool } from "./tools/intents.js";
import { stakingTxTool } from "./tools/writes.js";
import { fetchUsdPriceMap } from "./util/prices.js";

export const STRATEGY_TYPES = ["dca", "idle_to_stake", "de_risk"];

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
      const price = await readPrice(ctx, p.assetId); // live
      const trigger = dec(p.triggerPrice);
      if (price.gt(trigger)) {
        return { fired: false, reason: `price ${price} > triggerPrice ${trigger}`, conditionValue: price.toString(), prepared: [] };
      }
      let amount = p.amount;
      if (amount == null || amount === "") {
        const held = await readHeld(ctx, p.accountId, p.assetId); // live
        amount = held.times(dec(p.percent)).div(100).toString();
      }
      const description = rationale(s, `price ${price} <= triggerPrice ${trigger}; de-risking ${amount} of ${p.assetId} -> ${p.toAssetId}`);
      const prepared = [await prepareSwap(ctx, { accountId: p.accountId, fromAssetId: p.assetId, toAssetId: p.toAssetId, fromAmount: String(amount), description })];
      return { fired: true, reason: `price ${price} <= triggerPrice ${trigger}`, conditionValue: price.toString(), prepared };
    }
    default:
      throw new Error(`Unknown strategy type: ${s.type}`);
  }
}
