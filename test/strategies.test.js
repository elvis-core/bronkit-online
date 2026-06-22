// Tests for the scheduled-strategy layer: CRUD + validation, and firing that
// re-reads LIVE balance/price (never stored numbers), prepares via the existing
// tools with rationale in the description, and batches independently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.BRONKIT_POLL_INTERVAL_MS = "0"; // no real-time swap polling
process.env.BRONKIT_MASTER_KEY = "test-master";
process.env.OAUTH_SIGNING_SECRET = "test-signing";

const { FileStore } = await import("../src/store/index.js");
const { strategyTools } = await import("../src/tools/strategies.js");
const T = Object.fromEntries(strategyTools.map((t) => [t.name, t]));

const PRICED_INTENT = { status: "auction-in-progress", price: "0.0003", fromAmount: "10", toAmount: "0.003", userSettlementDeadline: Date.now() + 120000 };

function mockClient({ balances = [], prices = [], intentGet = PRICED_INTENT } = {}) {
  const calls = [];
  return {
    calls,
    async get(path, query) {
      calls.push({ method: "GET", path, query });
      if (path.endsWith("/balances")) return { balances };
      if (path === "/dictionary/asset-market-prices") return { prices };
      if (/\/intents\/[^/]+$/.test(path)) return intentGet;
      return {};
    },
    async post(path, body) {
      calls.push({ method: "POST", path, body });
      if (path.endsWith("/intents/quote")) return {};
      if (path.endsWith("/transactions")) return { transactionId: `tx-${calls.filter((c) => c.method === "POST" && c.path.endsWith("/transactions")).length}`, status: "signing-required" };
      if (path.endsWith("/intents")) return { status: "user-initiated" };
      return {};
    },
  };
}

function freshCtx(clientOpts) {
  const store = new FileStore(join(tmpdir(), `strat-${randomUUID()}.json`));
  return { workspaceId: "ws", userId: "u1", store, client: mockClient(clientOpts) };
}

test("CRUD: create / list / update / enable / delete; per-user scoping", () => {
  const ctx = freshCtx();
  const s = T.strategy_create.handler(ctx, { type: "dca", params: { accountId: "acc1", fromAssetId: "USDC", toAssetId: "ETH", amount: "10", schedule: "0 9 * * *" } });
  assert.ok(s.id);
  assert.equal(s.enabled, true);
  assert.equal(s.trigger.kind, "schedule");

  assert.equal(T.strategy_list.handler(ctx).strategies.length, 1);

  const upd = T.strategy_update.handler(ctx, { strategyId: s.id, params: { amount: "25" } });
  assert.equal(upd.params.amount, "25");
  assert.equal(upd.params.fromAssetId, "USDC"); // merged, not replaced

  assert.equal(T.strategy_set_enabled.handler(ctx, { strategyId: s.id, enabled: false }).enabled, false);

  // A different user cannot see or touch it.
  const other = { ...ctx, userId: "u2" };
  assert.equal(T.strategy_list.handler(other).strategies.length, 0);
  assert.equal(ctx.store.getStrategy("u2", s.id), null);

  assert.deepEqual(T.strategy_delete.handler(ctx, { strategyId: s.id }), { deleted: true, strategyId: s.id });
  assert.equal(T.strategy_list.handler(ctx).strategies.length, 0);
});

test("scheduledTaskId links the strategy to its Cowork task (for pause/delete)", () => {
  const ctx = freshCtx();
  const s = T.strategy_create.handler(ctx, { type: "dca", params: { accountId: "acc1", fromAssetId: "USDC", toAssetId: "ETH", amount: "10", schedule: "0 9 * * *" } });
  assert.equal(s.scheduledTaskId, null);
  const linked = T.strategy_update.handler(ctx, { strategyId: s.id, scheduledTaskId: "task-123" });
  assert.equal(linked.scheduledTaskId, "task-123");
  // Survives a store reload and is visible in list (so the skill can find the task).
  assert.equal(T.strategy_list.handler(ctx).strategies[0].scheduledTaskId, "task-123");
});

test("validation: rejects bad params per type", () => {
  const ctx = freshCtx();
  assert.throws(() => T.strategy_create.handler(ctx, { type: "dca", params: { fromAssetId: "USDC", toAssetId: "ETH", amount: "10", schedule: "x" } }), /accountId/);
  assert.throws(() => T.strategy_create.handler(ctx, { type: "de_risk", params: { accountId: "a", assetId: "X", triggerPrice: "1", toAssetId: "USDC", amount: "1", percent: "50" } }), /exactly one/);
  assert.throws(() => T.strategy_create.handler(ctx, { type: "lending", params: {} }), /Unknown strategy type/);
});

test("dca fire: prepares a swap, signable tx created, rationale in description, lastFiredAt set", async () => {
  const ctx = freshCtx({ intentGet: PRICED_INTENT });
  const s = T.strategy_create.handler(ctx, { type: "dca", params: { accountId: "acc1", fromAssetId: "USDC", toAssetId: "ETH", amount: "10", schedule: "0 9 * * *" } });
  const out = await T.strategy_run.handler(ctx, { strategyId: s.id });

  assert.equal(out.fired, true);
  assert.equal(out.prepared.length, 1);
  assert.equal(out.prepared[0].kind, "swap");
  assert.equal(out.prepared[0].result.signableTransactionId, "tx-1");
  assert.match(out.prepared[0].description, new RegExp(s.id));
  assert.match(out.prepared[0].description, /DCA/);

  const txCall = ctx.client.calls.find((c) => c.method === "POST" && c.path.endsWith("/transactions"));
  assert.match(txCall.body.description, new RegExp(s.id)); // rationale travels to the signing surface
  assert.ok(T.strategy_list.handler(ctx).strategies[0].lastFiredAt, "lastFiredAt set");
});

test("idle_to_stake fire: re-reads LIVE idle; fires only when above threshold", async () => {
  // Live idle (100) > threshold (40) → stake the excess (60).
  const ctxHi = freshCtx({ balances: [{ accountId: "acc1", assetId: "ATOM", totalBalance: "100", withdrawableBalance: "100" }] });
  const sHi = T.strategy_create.handler(ctxHi, { type: "idle_to_stake", params: { accountId: "acc1", assetId: "ATOM", threshold: "40" } });
  const hi = await T.strategy_run.handler(ctxHi, { strategyId: sHi.id });
  assert.equal(hi.fired, true);
  assert.equal(hi.conditionValue, "100");
  const stakeCall = ctxHi.client.calls.find((c) => c.method === "POST" && c.path.endsWith("/transactions"));
  assert.equal(stakeCall.body.transactionType, "stake-delegation");
  assert.equal(stakeCall.body.params.amount, "60"); // 100 - 40, computed from LIVE balance
  assert.match(stakeCall.body.description, new RegExp(sHi.id));

  // Same stored threshold, but live idle (30) <= threshold → does NOT fire.
  const ctxLo = freshCtx({ balances: [{ accountId: "acc1", assetId: "ATOM", totalBalance: "30", withdrawableBalance: "30" }] });
  const sLo = T.strategy_create.handler(ctxLo, { type: "idle_to_stake", params: { accountId: "acc1", assetId: "ATOM", threshold: "40" } });
  const lo = await T.strategy_run.handler(ctxLo, { strategyId: sLo.id });
  assert.equal(lo.fired, false);
  assert.equal(lo.conditionValue, "30");
  assert.ok(!ctxLo.client.calls.some((c) => c.path.endsWith("/transactions")), "nothing prepared");
});

test("de_risk fire: fires on LIVE price drop; percent sizes from LIVE holding", async () => {
  // price 0.5 <= trigger 1.0 → fire; percent 50 of held 8 = 4.
  const ctx = freshCtx({
    prices: [{ baseAssetId: "AVOL", quoteSymbolId: "s09", price: "0.5" }],
    balances: [{ accountId: "acc1", assetId: "AVOL", totalBalance: "8", withdrawableBalance: "8" }],
    intentGet: PRICED_INTENT,
  });
  const s = T.strategy_create.handler(ctx, { type: "de_risk", params: { accountId: "acc1", assetId: "AVOL", triggerPrice: "1.0", toAssetId: "USDC", percent: "50" } });
  const out = await T.strategy_run.handler(ctx, { strategyId: s.id });
  assert.equal(out.fired, true);
  assert.equal(out.conditionValue, "0.5");
  const intentCreate = ctx.client.calls.find((c) => c.method === "POST" && c.path.endsWith("/intents"));
  assert.equal(intentCreate.body.fromAmount, "4"); // 50% of live 8

  // price above trigger → no fire.
  const ctx2 = freshCtx({ prices: [{ baseAssetId: "AVOL", quoteSymbolId: "s09", price: "2" }], intentGet: PRICED_INTENT });
  const s2 = T.strategy_create.handler(ctx2, { type: "de_risk", params: { accountId: "acc1", assetId: "AVOL", triggerPrice: "1.0", toAssetId: "USDC", amount: "5" } });
  const out2 = await T.strategy_run.handler(ctx2, { strategyId: s2.id });
  assert.equal(out2.fired, false);
  assert.ok(!ctx2.client.calls.some((c) => c.path.endsWith("/intents")), "no intent created");
});

test("batched fire: each strategy independent; one bad id does not abort the rest", async () => {
  const ctx = freshCtx({ intentGet: PRICED_INTENT });
  const a = T.strategy_create.handler(ctx, { type: "dca", params: { accountId: "acc1", fromAssetId: "USDC", toAssetId: "ETH", amount: "10", schedule: "x" } });
  const out = await T.strategy_run.handler(ctx, { strategyIds: [a.id, "does-not-exist"] });
  assert.ok(Array.isArray(out.results) && out.results.length === 2);
  assert.equal(out.results[0].fired, true);
  assert.equal(out.results[1].error, "not found");
});

test("disabled strategy is skipped on fire", async () => {
  const ctx = freshCtx();
  const s = T.strategy_create.handler(ctx, { type: "dca", params: { accountId: "acc1", fromAssetId: "USDC", toAssetId: "ETH", amount: "10", schedule: "x" }, enabled: false });
  const out = await T.strategy_run.handler(ctx, { strategyId: s.id });
  assert.equal(out.skipped, "disabled");
  assert.ok(!ctx.client.calls.some((c) => c.method === "POST"), "nothing prepared");
});
