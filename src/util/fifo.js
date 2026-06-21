// FIFO cost-basis core — faithful port of the bron-cost-basis skill's
// stage-2 (event preprocessing, jq) + stage-3 (FIFO, Python Decimal).
//
// Pure functions, no I/O — unit-testable with synthetic events. Money math uses
// decimal.js to match the skill's Python `Decimal` (no float drift in summation
// or partial-lot proportional basis).

import Decimal from "decimal.js";

const REWARD_TYPES = new Set([
  "stake-earn-reward",
  "stake-take-reward",
  "canton-reward",
  "loyalty-reward",
]);

function num(x) {
  if (x instanceof Decimal) return x;
  try {
    return new Decimal(x == null || x === "" ? 0 : x);
  } catch {
    return new Decimal(0);
  }
}

// An `in` event is an internal transfer if it originated from a workspace
// account (extra.in[].fromAccountId set); an `out` if it targets one
// (extra.out[].toAccountId set). Both legs are skipped.
function isInternalIn(e) {
  const arr = e && e.extra && e.extra.in;
  return Array.isArray(arr) && arr.some((x) => x && x.fromAccountId != null);
}
function isInternalOut(e) {
  const arr = e && e.extra && e.extra.out;
  return Array.isArray(arr) && arr.some((x) => x && x.toAccountId != null);
}

/**
 * Turn raw transactions (each with `_embedded.events[]`) into a chronologically
 * sorted, internal-transfer-stripped, fee-folded stream of {type, asset, …}.
 */
export function preprocessEvents(transactions) {
  const byTx = new Map();
  for (const t of transactions || []) {
    const events = (t && t._embedded && t._embedded.events) || [];
    for (const e of events) {
      const id = e.transactionId;
      if (!byTx.has(id)) byTx.set(id, []);
      byTx.get(id).push(e);
    }
  }

  const stream = [];
  for (const txEvents of byTx.values()) {
    const outs = txEvents.filter((e) => e.eventType === "out");
    const fees = txEvents.filter((e) => e.eventType === "fee");
    const ins = txEvents.filter((e) => e.eventType === "in" || REWARD_TYPES.has(e.eventType));

    // Buys / rewards (rewards are zero-basis acquisitions).
    for (const e of ins) {
      if (isInternalIn(e)) continue;
      stream.push({
        type: "buy",
        asset: e.assetId,
        symbol: e.symbol,
        network: e.networkId,
        amount: num(e.amount),
        usd: REWARD_TYPES.has(e.eventType) ? new Decimal(0) : num(e.usdAmount),
        ts: e.createdAt,
      });
    }

    // Sells, netting in same-asset fees (proceeds clamped to >= 0).
    const outAssets = new Set(outs.map((o) => o.assetId));
    for (const o of outs) {
      if (isInternalOut(o)) continue;
      const sameFees = fees.filter((f) => f.assetId === o.assetId);
      const feeAmt = sameFees.reduce((s, f) => s.plus(num(f.amount)), new Decimal(0));
      const feeUsd = sameFees.reduce((s, f) => s.plus(num(f.usdAmount)), new Decimal(0));
      let usd = num(o.usdAmount).minus(feeUsd);
      if (usd.lt(0)) usd = new Decimal(0);
      stream.push({
        type: "sell",
        asset: o.assetId,
        symbol: o.symbol,
        network: o.networkId,
        amount: num(o.amount).plus(feeAmt),
        usd,
        ts: o.createdAt,
        is_fee: false,
      });
    }

    // Different-asset fees → standalone disposals against the fee asset's FIFO.
    for (const f of fees) {
      if (outAssets.has(f.assetId)) continue;
      stream.push({
        type: "sell",
        asset: f.assetId,
        symbol: f.symbol,
        network: f.networkId,
        amount: num(f.amount),
        usd: num(f.usdAmount),
        ts: f.createdAt,
        is_fee: true,
      });
    }
  }

  stream.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return stream;
}

/**
 * Run FIFO over the preprocessed stream. Returns per-asset open lots
 * (held qty, avg basis) + realised P&L + lifetime fees. All numbers as strings.
 */
export function runFifo(events) {
  const queues = new Map(); // asset -> [{ qty, cost, ts }]
  const realised = new Map(); // asset -> Decimal
  const meta = new Map();
  let lifetimeFees = new Decimal(0);
  const addRealised = (a, d) => realised.set(a, (realised.get(a) || new Decimal(0)).plus(d));

  for (const e of events || []) {
    const aid = e.asset;
    meta.set(aid, { symbol: e.symbol, network: e.network });
    const amt = num(e.amount);
    const usd = num(e.usd);

    if (e.type === "buy") {
      if (!queues.has(aid)) queues.set(aid, []);
      queues.get(aid).push({ qty: amt, cost: usd, ts: e.ts });
    } else if (e.type === "sell") {
      if (e.is_fee) lifetimeFees = lifetimeFees.plus(usd);
      let remaining = amt;
      let basisConsumed = new Decimal(0);
      const q = queues.get(aid) || [];
      while (remaining.gt(0) && q.length) {
        const lot = q[0];
        if (lot.qty.lte(remaining)) {
          basisConsumed = basisConsumed.plus(lot.cost);
          remaining = remaining.minus(lot.qty);
          q.shift();
        } else {
          const share = remaining.div(lot.qty);
          const partial = lot.cost.times(share);
          basisConsumed = basisConsumed.plus(partial);
          lot.cost = lot.cost.minus(partial);
          lot.qty = lot.qty.minus(remaining);
          remaining = new Decimal(0);
        }
      }
      // Any unmatched remainder is a zero-basis disposal (full proceeds = gain).
      addRealised(aid, usd.minus(basisConsumed));
    }
  }

  const positions = [];
  for (const aid of new Set([...queues.keys(), ...realised.keys()])) {
    const q = queues.get(aid) || [];
    const held = q.reduce((s, l) => s.plus(l.qty), new Decimal(0));
    const basis = q.reduce((s, l) => s.plus(l.cost), new Decimal(0));
    const avg = held.gt(0) ? basis.div(held) : new Decimal(0);
    positions.push({
      assetId: aid,
      symbol: meta.get(aid)?.symbol ?? null,
      network: meta.get(aid)?.network ?? null,
      held: held.toString(),
      avgBasis: avg.toString(),
      realised: (realised.get(aid) || new Decimal(0)).toString(),
    });
  }
  return { positions, lifetimeFees: lifetimeFees.toString() };
}
