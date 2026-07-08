// Tests for the scheduled-strategy layer: CRUD + validation, and firing that
// re-reads LIVE balance/price (never stored numbers), prepares via the existing
// tools with rationale in the description, and batches independently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.BRONKIT_POLL_INTERVAL_MS = "0"; // no real-time swap polling
process.env.BRONKIT_CONFLICT_RETRY_MS = "0"; // no real-time waiting on 409 auto-retry
process.env.BRONKIT_MASTER_KEY = "test-master";
process.env.OAUTH_SIGNING_SECRET = "test-signing";

const { FileStore } = await import("../src/store/index.js");
const { strategyTools } = await import("../src/tools/strategies.js");
const T = Object.fromEntries(strategyTools.map((t) => [t.name, t]));

const PRICED_INTENT = { status: "auction-in-progress", price: "0.0003", fromAmount: "10", toAmount: "0.003", userSettlementDeadline: Date.now() + 120000 };

function mockClient({ balances = [], prices = [], intentGet = PRICED_INTENT, intentConflict = false } = {}) {
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
      if (path.endsWith("/intents")) {
        // Simulate Bron rejecting a second intent for the same pair.
        if (intentConflict) {
          const e = new Error("Bron API 409 [conflict]: Something went wrong. Please try again (requestId: test-409)");
          e.status = 409; e.code = "conflict";
          throw e;
        }
        return { status: "user-initiated" };
      }
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

test("scheduledTaskId optionally records the user's recurring task id (round-trips + survives reload)", () => {
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

test("strategy names: auto-generated self-explanatory default; explicit name kept; renamable", () => {
  const ctx = freshCtx();
  // No name given -> auto-generated from params, human-readable.
  const auto = T.strategy_create.handler(ctx, { type: "dca", params: { accountId: "acc1", fromAssetId: "USDC", toAssetId: "ETH", amount: "10", schedule: "0 9 * * *" } });
  assert.match(auto.name, /USDC/);
  assert.match(auto.name, /ETH/);
  assert.match(auto.name, /10/);
  // Explicit name wins.
  const named = T.strategy_create.handler(ctx, { type: "price_target", name: "Sell half my ETH at 3500", params: { accountId: "acc1", assetId: "ETH", direction: "above", targetPrice: "3500", fromAssetId: "ETH", toAssetId: "USDC", amount: "0.5" } });
  assert.equal(named.name, "Sell half my ETH at 3500");
  // Rename via update; visible in list.
  T.strategy_update.handler(ctx, { strategyId: named.id, name: "Take profit on ETH" });
  const listed = T.strategy_list.handler(ctx).strategies.find((s) => s.id === named.id);
  assert.equal(listed.name, "Take profit on ETH");
});

test("strategy name travels into the fired tx rationale (signing surface)", async () => {
  const ctx = freshCtx({ intentGet: PRICED_INTENT });
  const s = T.strategy_create.handler(ctx, { type: "dca", name: "Morning ETH buy", params: { accountId: "acc1", fromAssetId: "USDC", toAssetId: "ETH", amount: "10", schedule: "0 9 * * *" } });
  await T.strategy_run.handler(ctx, { strategyId: s.id });
  const txCall = ctx.client.calls.find((c) => c.method === "POST" && c.path.endsWith("/transactions"));
  assert.match(txCall.body.description, /Morning ETH buy/);
});

test("strategy_create result explains the beat honestly (howItRuns): not self-running, runs while alive, not 24/7", () => {
  const ctx = freshCtx();
  const s = T.strategy_create.handler(ctx, { type: "dca", params: { accountId: "acc1", fromAssetId: "USDC", toAssetId: "ETH", amount: "10", schedule: "0 9 * * *" } });
  assert.ok(typeof s.howItRuns === "string");
  assert.match(s.howItRuns, /does NOT run on its own/);
  assert.match(s.howItRuns, /evaluated only when a live Claude session calls strategy_run/);
  assert.match(s.howItRuns, /phone/i); // reliable-on-any-device path stated
  assert.match(s.howItRuns, /ONLY on Claude DESKTOP/); // recurring is desktop-only, honestly
  assert.match(s.howItRuns, /24\/7/); // states the honest limit
  // No stale Cowork branding baked into the guidance.
  assert.doesNotMatch(s.howItRuns, /cowork/i);
  // Ephemeral guidance — not persisted on the stored strategy.
  assert.equal(ctx.store.getStrategy(ctx.userId, s.id).howItRuns, undefined);
});

test("scheduler_setup_text: surface-neutral, self-contained prompt + honest 'runs while alive' limit", () => {
  const ctx = freshCtx();
  const out = T.scheduler_setup_text.handler(ctx);
  assert.ok(typeof out.pasteText === "string" && out.pasteText.length > 0);
  // Self-contained: names the tool + connector, the no-ids semantics, and the sign reminder.
  assert.match(out.pasteText, /strategy_run/);
  assert.match(out.pasteText, /bronkit/i);
  assert.match(out.pasteText, /no strategy ids/i);
  assert.match(out.pasteText, /Bron app/);
  // No stale Cowork branding.
  assert.doesNotMatch(JSON.stringify(out), /cowork/i);
  // States the honest limitation: runs only while alive, desktop-only recurring, not 24/7.
  assert.match(out.honestLimit, /only while a Claude session/i);
  assert.match(out.honestLimit, /Claude Desktop/);
  assert.match(out.honestLimit, /24\/7/);
  assert.ok(typeof out.howToUse === "string");
});

test("dca cadence gate: no-ids sweep fires only when due; explicit id forces", async () => {
  const store = new FileStore(tmpPath());
  const params = { accountId: "acc1", fromAssetId: "USDC", toAssetId: "ETH", amount: "10", schedule: "hourly" };
  const s = T.strategy_create.handler(ctxOn(store, {}), { type: "dca", params });

  // Sweep 1 (never fired) → due → fires.
  let out = await T.strategy_run.handler(ctxOn(store, { intentGet: PRICED_INTENT }), {});
  assert.equal(out.fired, 1);

  // Sweep 2 immediately after → NOT due (hourly cadence) → no duplicate.
  const ctx2 = ctxOn(store, { intentGet: PRICED_INTENT });
  out = await T.strategy_run.handler(ctx2, {});
  assert.equal(out.fired, 0);
  assert.match(out.results[0].reason, /not due/);
  assert.ok(!ctx2.client.calls.some((c) => c.path.endsWith("/intents")), "no intent placed");

  // Explicit id ("run it now") → forced → fires despite cadence.
  const forced = await T.strategy_run.handler(ctxOn(store, { intentGet: PRICED_INTENT }), { strategyId: s.id });
  assert.equal(forced.fired, true);
  assert.match(forced.reason, /forced/);
});

test("swap with no solver: NOT ok, no signable tx, reason explains it is a Bron auction matter (not a false success)", async () => {
  // Intent stalls unpriced with a passed deadline → no solver ever bids → no tx.
  const ctx = freshCtx({ intentGet: { status: "user-initiated", userSettlementDeadline: Date.now() - 1000 } });
  const s = T.strategy_create.handler(ctx, { type: "dca", params: { accountId: "acc1", fromAssetId: "5002", toAssetId: "2", amount: "20", schedule: "hourly" } });
  const out = await T.strategy_run.handler(ctx, { strategyId: s.id });
  assert.equal(out.prepared[0].ok, false, "no signable tx => not a success");
  assert.equal(out.prepared[0].result.signableTransactionId, undefined, "nothing to sign");
  assert.ok(/solver|auction|expire|sign/i.test(out.prepared[0].reason || ""), "reason explains why there is no tx");
  assert.ok(!ctx.client.calls.some((c) => c.path.endsWith("/transactions")), "no signable tx was created");
});

test("swap 409 conflict: reported cleanly (not a false success), no signable tx, sweep survives", async () => {
  const ctx = freshCtx({ intentConflict: true });
  const s = T.strategy_create.handler(ctx, { type: "dca", params: { accountId: "acc1", fromAssetId: "5002", toAssetId: "2", amount: "20", schedule: "hourly" } });
  const out = await T.strategy_run.handler(ctx, { strategyId: s.id });
  // A 409 makes the prepare NOT ok and reports the honest Bron-side cause.
  assert.equal(out.prepared[0].ok, false);
  assert.equal(out.prepared[0].result.conflict, true);
  assert.match(out.prepared[0].result.guidance, /Bron-SIDE|workspace-wide|409 conflict/i);
  // It did not throw and never reached the signable-transaction step.
  assert.ok(!ctx.client.calls.some((c) => c.path.endsWith("/transactions")), "no signable tx created on conflict");
});

test("strategy_create warns when a new strategy duplicates an enabled same-pair one", () => {
  const ctx = freshCtx();
  const p = { accountId: "acc1", fromAssetId: "5002", toAssetId: "2", amount: "20", schedule: "hourly" };
  const first = T.strategy_create.handler(ctx, { type: "dca", params: p });
  assert.ok(!first.warning, "first strategy has no warning");
  const second = T.strategy_create.handler(ctx, { type: "dca", params: { ...p, amount: "5" } });
  assert.match(second.warning || "", /same pair/i);
  // A different pair does not warn.
  const third = T.strategy_create.handler(ctx, { type: "dca", params: { ...p, toAssetId: "5003" } });
  assert.ok(!third.warning, "different pair -> no warning");
  // A disabled duplicate does not warn (it won't fire concurrently).
  const dis = T.strategy_create.handler(ctx, { type: "dca", params: { ...p, amount: "7" }, enabled: false });
  assert.ok(!dis.warning, "disabled duplicate -> no warning");
});

test("swap strategy RESUMES an existing priced intent into a signable tx (no duplicate create)", async () => {
  const ctx = freshCtx({ intentGet: PRICED_INTENT });
  const s = T.strategy_create.handler(ctx, { type: "dca", params: { accountId: "acc1", fromAssetId: "5002", toAssetId: "2", amount: "20", schedule: "hourly" } });
  // Simulate a prior fire that left a pending (now priced) intent for this pair.
  ctx.store.updateStrategy(ctx.userId, s.id, { lastIntentId: "prev-intent-1" });
  const out = await T.strategy_run.handler(ctx, { strategyId: s.id });
  assert.equal(out.prepared[0].ok, true);
  assert.equal(out.prepared[0].resumed, true, "completed the existing intent rather than duplicating");
  assert.ok(out.prepared[0].result.signableTransactionId, "priced intent completed into a signable tx");
  // Checked the stored intent id, and did NOT POST a duplicate intent.
  assert.ok(ctx.client.calls.some((c) => c.method === "GET" && c.path.endsWith("/intents/prev-intent-1")));
  assert.ok(!ctx.client.calls.some((c) => c.method === "POST" && /\/intents$/.test(c.path)), "no duplicate intent created");
});

test("disabled strategy is skipped on fire", async () => {
  const ctx = freshCtx();
  const s = T.strategy_create.handler(ctx, { type: "dca", params: { accountId: "acc1", fromAssetId: "USDC", toAssetId: "ETH", amount: "10", schedule: "x" }, enabled: false });
  const out = await T.strategy_run.handler(ctx, { strategyId: s.id });
  assert.equal(out.skipped, "disabled");
  assert.ok(!ctx.client.calls.some((c) => c.method === "POST"), "nothing prepared");
});
