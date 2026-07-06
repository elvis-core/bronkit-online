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

// For price-crossing tests: same store across ticks, a fresh client (price) per tick.
const tmpPath = () => join(tmpdir(), `strat-${randomUUID()}.json`);
const ctxOn = (store, clientOpts) => ({ workspaceId: "ws", userId: "u1", store, client: mockClient(clientOpts) });
const price = (assetId, p) => [{ baseAssetId: assetId, quoteSymbolId: "s09", price: p }];

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

test("de_risk (crossing, fire-once): baseline → cross-down fires once; percent sizes from LIVE holding; no duplicate", async () => {
  const store = new FileStore(tmpPath());
  // Created while ABOVE trigger (1.5, trigger 1.0). "Right side" = at/below 1.0.
  const s = T.strategy_create.handler(ctxOn(store, { prices: price("AVOL", "1.5") }), { type: "de_risk", params: { accountId: "acc1", assetId: "AVOL", triggerPrice: "1.0", toAssetId: "USDC", percent: "50" } });

  // tick 1 @ 1.5 (above) → baseline, no fire.
  let r = await T.strategy_run.handler(ctxOn(store, { prices: price("AVOL", "1.5") }), { strategyId: s.id });
  assert.equal(r.fired, false);

  // tick 2 @ 0.8 (crossed below) → fires once; 50% of live held 8 = 4.
  const ctx2 = ctxOn(store, { prices: price("AVOL", "0.8"), balances: [{ accountId: "acc1", assetId: "AVOL", totalBalance: "8", withdrawableBalance: "8" }] });
  r = await T.strategy_run.handler(ctx2, { strategyId: s.id });
  assert.equal(r.fired, true);
  assert.equal(r.prepared[0].kind, "swap");
  assert.equal(ctx2.client.calls.find((c) => c.method === "POST" && c.path.endsWith("/intents")).body.fromAmount, "4");

  // tick 3 @ 0.7 (still below) → NO duplicate (disarmed).
  const ctx3 = ctxOn(store, { prices: price("AVOL", "0.7") });
  r = await T.strategy_run.handler(ctx3, { strategyId: s.id });
  assert.equal(r.fired, false);
  assert.ok(!ctx3.client.calls.some((c) => c.path.endsWith("/intents")), "no duplicate intent");
});

test("de_risk: created already below target does NOT fire (needs a cross)", async () => {
  const store = new FileStore(tmpPath());
  const s = T.strategy_create.handler(ctxOn(store, { prices: price("AVOL", "0.5") }), { type: "de_risk", params: { accountId: "acc1", assetId: "AVOL", triggerPrice: "1.0", toAssetId: "USDC", amount: "5" } });
  let r = await T.strategy_run.handler(ctxOn(store, { prices: price("AVOL", "0.5") }), { strategyId: s.id }); // baseline
  assert.equal(r.fired, false);
  r = await T.strategy_run.handler(ctxOn(store, { prices: price("AVOL", "0.4") }), { strategyId: s.id }); // still below, no cross
  assert.equal(r.fired, false);
});

test("price_target: validation", () => {
  const ctx = freshCtx();
  assert.throws(() => T.strategy_create.handler(ctx, { type: "price_target", params: { accountId: "a", assetId: "ETH", direction: "sideways", targetPrice: "3100", fromAssetId: "ETH", toAssetId: "USDC", amount: "0.5" } }), /direction/);
  assert.throws(() => T.strategy_create.handler(ctx, { type: "price_target", params: { accountId: "a", assetId: "ETH", direction: "above", fromAssetId: "ETH", toAssetId: "USDC", amount: "0.5" } }), /targetPrice/);
});

test("price_target (above): no fire when created past target; fires once on cross up; re-arms on re-cross", async () => {
  const store = new FileStore(tmpPath());
  const params = { accountId: "acc1", assetId: "ETH", direction: "above", targetPrice: "3100", fromAssetId: "ETH", toAssetId: "USDC", amount: "0.5" };
  const s = T.strategy_create.handler(ctxOn(store, { prices: price("ETH", "3000") }), { type: "price_target", params });

  // tick 1 @ 3000 (below target, wrong side for 'above') → baseline, no fire.
  let r = await T.strategy_run.handler(ctxOn(store, { prices: price("ETH", "3000") }), { strategyId: s.id });
  assert.equal(r.fired, false);

  // tick 2 @ 3200 (jumped past 3100 between ticks) → fires once; description records observed vs target.
  const ctx2 = ctxOn(store, { prices: price("ETH", "3200") });
  r = await T.strategy_run.handler(ctx2, { strategyId: s.id });
  assert.equal(r.fired, true);
  assert.match(r.prepared[0].description, /hit 3200/);
  assert.match(r.prepared[0].description, /target 3100/);

  // tick 3 @ 3300 (still above) → no duplicate.
  r = await T.strategy_run.handler(ctxOn(store, { prices: price("ETH", "3300") }), { strategyId: s.id });
  assert.equal(r.fired, false);

  // tick 4 @ 3000 (back below) → re-arm, no fire.
  r = await T.strategy_run.handler(ctxOn(store, { prices: price("ETH", "3000") }), { strategyId: s.id });
  assert.equal(r.fired, false);

  // tick 5 @ 3150 (cross up again) → fires again.
  r = await T.strategy_run.handler(ctxOn(store, { prices: price("ETH", "3150") }), { strategyId: s.id });
  assert.equal(r.fired, true);
});

test("price_target: created already above target never fires while it stays above", async () => {
  const store = new FileStore(tmpPath());
  const params = { accountId: "acc1", assetId: "ETH", direction: "above", targetPrice: "3100", fromAssetId: "ETH", toAssetId: "USDC", amount: "0.5" };
  const s = T.strategy_create.handler(ctxOn(store, { prices: price("ETH", "3200") }), { type: "price_target", params });
  let r = await T.strategy_run.handler(ctxOn(store, { prices: price("ETH", "3200") }), { strategyId: s.id }); // baseline
  assert.equal(r.fired, false);
  r = await T.strategy_run.handler(ctxOn(store, { prices: price("ETH", "3400") }), { strategyId: s.id }); // still above, no cross
  assert.equal(r.fired, false);
});

test("strategy_run with no ids evaluates ALL enabled strategies and returns a summary", async () => {
  const store = new FileStore(tmpPath());
  const dcaParams = { accountId: "acc1", fromAssetId: "a-usdc", toAssetId: "a-eth", amount: "10", schedule: "0 9 * * *" };
  const a = T.strategy_create.handler(ctxOn(store, {}), { type: "dca", params: dcaParams });
  const b = T.strategy_create.handler(ctxOn(store, {}), { type: "dca", params: dcaParams });
  T.strategy_set_enabled.handler(ctxOn(store, {}), { strategyId: b.id, enabled: false }); // disabled → not evaluated

  const out = await T.strategy_run.handler(ctxOn(store, { intentGet: PRICED_INTENT }), {}); // NO ids
  assert.equal(out.checked, 1, "only the enabled strategy was evaluated");
  assert.equal(out.fired, 1);
  assert.equal(out.results[0].strategyId, a.id);
});

test("batched fire: each strategy independent; one bad id does not abort the rest", async () => {
  const ctx = freshCtx({ intentGet: PRICED_INTENT });
  const a = T.strategy_create.handler(ctx, { type: "dca", params: { accountId: "acc1", fromAssetId: "USDC", toAssetId: "ETH", amount: "10", schedule: "x" } });
  const out = await T.strategy_run.handler(ctx, { strategyIds: [a.id, "does-not-exist"] });
  assert.ok(Array.isArray(out.results) && out.results.length === 2);
  assert.equal(out.results[0].fired, true);
  assert.equal(out.results[1].error, "not found");
});

test("scheduler_setup_text: returns a self-contained, paste-ready metronome prompt", () => {
  const ctx = freshCtx();
  const out = T.scheduler_setup_text.handler(ctx);
  assert.ok(typeof out.pasteText === "string" && out.pasteText.length > 0);
  // Self-contained: names the tool + connector, the no-ids semantics, and the sign reminder.
  assert.match(out.pasteText, /strategy_run/);
  assert.match(out.pasteText, /bronkit/i);
  assert.match(out.pasteText, /hour/i);
  assert.match(out.pasteText, /no strategy ids/i);
  assert.match(out.pasteText, /Bron app/);
  // Presents the two-step Cowork install (/schedule → paste → confirm).
  assert.ok(Array.isArray(out.installInCowork) && out.installInCowork.some((s) => /schedule/i.test(s)));
});

test("disabled strategy is skipped on fire", async () => {
  const ctx = freshCtx();
  const s = T.strategy_create.handler(ctx, { type: "dca", params: { accountId: "acc1", fromAssetId: "USDC", toAssetId: "ETH", amount: "10", schedule: "x" }, enabled: false });
  const out = await T.strategy_run.handler(ctx, { strategyId: s.id });
  assert.equal(out.skipped, "disabled");
  assert.ok(!ctx.client.calls.some((c) => c.method === "POST"), "nothing prepared");
});
