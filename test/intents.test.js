// Tests for the swap (intent) tool. A scripted mock client stands in for the
// signed Bron client: it records calls and returns a programmable sequence of
// get-intent responses so we can exercise the multi-stage lifecycle without the
// network or real time. Poll interval is forced to 0 via env (set before import).

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.BRONKIT_POLL_INTERVAL_MS = "0";
const { swapTool } = await import("../src/tools/intents.js");

// Mock signed client. `getSeq` is consumed one entry per get-intent call; the
// last entry repeats once exhausted.
function mockCtx({ createResp, getSeq = [], quoteResp } = {}) {
  const calls = [];
  let i = 0;
  return {
    workspaceId: "ws-test",
    calls,
    client: {
      async post(path, body) {
        calls.push({ method: "POST", path, body });
        return path.endsWith("/quote") ? quoteResp : createResp;
      },
      async get(path) {
        calls.push({ method: "GET", path });
        const r = getSeq[Math.min(i, getSeq.length - 1)];
        i++;
        return r;
      },
      async request({ method, path, query }) {
        calls.push({ method, path, query });
        return quoteResp;
      },
    },
  };
}

test("quote: previews via POST /intents/quote with a JSON body, creates nothing", async () => {
  const ctx = mockCtx({ quoteResp: { fromAssetId: "a", toAssetId: "b", toAmount: "99", minToAmount: "98", minPrice: "0.99", solverFeePercent: "0.1", oracleFeePercent: "0.05" } });
  const out = await swapTool.handler(ctx, { action: "quote", fromAssetId: "a", toAssetId: "b", fromAmount: "100" });
  assert.equal(out.action, "quote");
  assert.equal(out.preview, true);
  assert.equal(out.quote.minToAmount, "98");
  const call = ctx.calls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/workspaces/ws-test/intents/quote");
  // Must send a JSON body (Bron rejects an empty request entity), not a query string.
  assert.deepEqual(call.body, { fromAssetId: "a", toAssetId: "b", fromAmount: "100" });
  assert.equal(call.query, undefined);
  // No /intents (create) call happened.
  assert.ok(!ctx.calls.some((c) => c.path === "/workspaces/ws-test/intents"));
});

test("amount validation: exactly one of fromAmount/toAmount", async () => {
  const ctx = mockCtx({});
  await assert.rejects(() => swapTool.handler(ctx, { action: "quote", fromAssetId: "a", toAssetId: "b" }), /exactly one/);
  await assert.rejects(() => swapTool.handler(ctx, { action: "quote", fromAssetId: "a", toAssetId: "b", fromAmount: "1", toAmount: "2" }), /exactly one/);
});

test("create: generates intentId, posts intent, polls to wait-for-user-tx and surfaces the deadline", async () => {
  const deadline = Date.now() + 120000;
  const ctx = mockCtx({
    createResp: { intentId: "ignored-server-echo", status: "user-initiated", fromAmount: "100", toAmount: "99" },
    getSeq: [
      { status: "auction-in-progress", fromAmount: "100", toAmount: "99", price: "0.99" },
      { status: "wait-for-user-tx", fromAmount: "100", toAmount: "99", price: "0.99", userSettlementDeadline: deadline },
    ],
  });
  const out = await swapTool.handler(ctx, { action: "create", accountId: "acc1", fromAssetId: "a", toAssetId: "b", fromAmount: "100", maxWaitSeconds: 10 });

  assert.equal(out.action, "create");
  assert.ok(out.intentId && out.intentId.length > 10, "a client intentId was generated");
  // The create POST used the generated intentId, not the server echo.
  const post = ctx.calls.find((c) => c.method === "POST");
  assert.equal(post.path, "/workspaces/ws-test/intents");
  assert.equal(post.body.intentId, out.intentId);
  assert.equal(post.body.accountId, "acc1");
  assert.equal(post.body.fromAmount, "100");

  // Lifecycle reported as transitions, ending at the user-action stage.
  assert.deepEqual(out.statusTimeline.map((t) => t.status), ["user-initiated", "auction-in-progress", "wait-for-user-tx"]);
  assert.equal(out.status, "wait-for-user-tx");
  assert.equal(out.userActionRequired, true);
  assert.equal(out.terminal, false);
  assert.equal(out.pollComplete, true);
  assert.equal(out.userSettlementDeadline.epochMs, deadline);
  assert.equal(out.userSettlementDeadline.passed, false);
  assert.match(out.guidance, /Bron app/);
});

test("create: stops on a terminal state (completed)", async () => {
  const ctx = mockCtx({
    createResp: { status: "user-initiated" },
    getSeq: [{ status: "auction-in-progress" }, { status: "wait-for-solver-tx" }, { status: "completed", toAmount: "99" }],
  });
  const out = await swapTool.handler(ctx, { action: "create", accountId: "acc1", fromAssetId: "a", toAssetId: "b", toAmount: "99", maxWaitSeconds: 30 });
  assert.equal(out.status, "completed");
  assert.equal(out.terminal, true);
  assert.equal(out.userActionRequired, false);
  assert.match(out.guidance, /completed/i);
});

test("status: re-polls an existing intent by id and stops on terminal", async () => {
  const ctx = mockCtx({ getSeq: [{ status: "wait-for-oracle-confirm-solver-tx" }, { status: "completed" }] });
  const out = await swapTool.handler(ctx, { action: "status", intentId: "intent-123", maxWaitSeconds: 30 });
  assert.equal(out.action, "status");
  assert.equal(ctx.calls[0].path, "/workspaces/ws-test/intents/intent-123");
  assert.equal(out.status, "completed");
  assert.equal(out.terminal, true);
});

test("bounded: never loops forever — non-terminal stream returns at the time budget", async () => {
  // Always auction-in-progress; with interval 0 and maxWait 0 we read once then stop.
  const ctx = mockCtx({ getSeq: [{ status: "auction-in-progress" }] });
  const out = await swapTool.handler(ctx, { action: "status", intentId: "intent-x", maxWaitSeconds: 0 });
  assert.equal(out.status, "auction-in-progress");
  assert.equal(out.terminal, false);
  assert.equal(out.userActionRequired, false);
  assert.equal(out.pollComplete, false); // stopped on timeout, not a settled state
  assert.match(out.guidance, /check the status again/i);
});

test("create with maxWaitSeconds 0 returns the intent id immediately without polling", async () => {
  const ctx = mockCtx({ createResp: { status: "user-initiated" }, getSeq: [{ status: "auction-in-progress" }] });
  const out = await swapTool.handler(ctx, { action: "create", accountId: "acc1", fromAssetId: "a", toAssetId: "b", fromAmount: "1", maxWaitSeconds: 0 });
  assert.ok(out.intentId);
  assert.equal(out.status, "user-initiated");
  // Only the create POST happened — no get-intent reads.
  assert.equal(ctx.calls.filter((c) => c.method === "GET").length, 0);
});
