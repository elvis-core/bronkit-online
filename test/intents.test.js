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
function mockCtx({ createResp, getSeq = [], quoteResp, txResp } = {}) {
  const calls = [];
  let i = 0;
  return {
    workspaceId: "ws-test",
    calls,
    client: {
      async post(path, body) {
        calls.push({ method: "POST", path, body });
        if (path.endsWith("/quote")) return quoteResp;
        if (path.endsWith("/transactions")) return txResp || { transactionId: "tx-1", status: "signing-required" };
        return createResp; // /intents (create)
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
  // No price on any entry → step 3 is NOT triggered; the poll runs through to
  // wait-for-user-tx and surfaces the deadline / user-action branch.
  const ctx = mockCtx({
    createResp: { intentId: "ignored-server-echo", status: "user-initiated", fromAmount: "100", toAmount: "99" },
    getSeq: [
      { status: "auction-in-progress", fromAmount: "100", toAmount: "99" },
      { status: "wait-for-user-tx", fromAmount: "100", toAmount: "99", userSettlementDeadline: deadline },
    ],
  });
  const out = await swapTool.handler(ctx, { action: "create", accountId: "acc1", fromAssetId: "a", toAssetId: "b", fromAmount: "100", maxWaitSeconds: 10 });

  assert.equal(out.action, "create");
  assert.ok(out.intentId && out.intentId.length > 10, "a client intentId was generated");
  assert.match(out.intentId, /^[a-z0-9]{24}$/, "Bron-format id (24-char base36)");
  assert.doesNotMatch(out.intentId, /-/, "NOT a UUID — Bron rejects UUID intentIds with a 409");
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
  assert.equal(out.signableTransactionId, undefined); // no price → no signable tx created
  assert.equal(out.userSettlementDeadline.epochMs, deadline);
  assert.equal(out.userSettlementDeadline.passed, false);
  assert.match(out.guidance, /Bron app/);
});

test("create: once a solver prices it, creates the SIGNABLE transaction (step 3)", async () => {
  const ctx = mockCtx({
    createResp: { status: "user-initiated" },
    getSeq: [
      { status: "auction-in-progress" }, // no price yet
      { status: "auction-in-progress", price: "0.0003", toAmount: "0.03", userSettlementDeadline: Date.now() + 120000 }, // solver priced it
    ],
    txResp: { transactionId: "tx-abc", status: "signing-required" },
  });
  const out = await swapTool.handler(ctx, { action: "create", accountId: "acc1", fromAssetId: "a", toAssetId: "b", fromAmount: "100", maxWaitSeconds: 30 });

  assert.equal(out.solverPriced, true);
  assert.equal(out.signableTransactionId, "tx-abc");
  assert.equal(out.signableTransaction.status, "signing-required");
  assert.match(out.guidance, /Bron app|sign/i);

  // The signable tx was created via POST /transactions with the intents type.
  const txCall = ctx.calls.find((c) => c.method === "POST" && c.path === "/workspaces/ws-test/transactions");
  assert.ok(txCall, "a POST /transactions call was made");
  assert.equal(txCall.body.transactionType, "intents");
  assert.equal(txCall.body.params.intentId, out.intentId);
  assert.equal(txCall.body.accountId, "acc1");
  assert.ok(txCall.body.externalId, "externalId present (idempotency)");
});

test("create: no solver price → no signable transaction, honest guidance", async () => {
  const ctx = mockCtx({
    createResp: { status: "user-initiated" },
    getSeq: [{ status: "auction-in-progress" }], // never priced
  });
  const out = await swapTool.handler(ctx, { action: "create", accountId: "acc1", fromAssetId: "a", toAssetId: "b", fromAmount: "1", maxWaitSeconds: 0 });
  assert.equal(out.solverPriced, false);
  assert.equal(out.signableTransactionId, undefined);
  assert.ok(!ctx.calls.some((c) => c.path === "/workspaces/ws-test/transactions"), "no /transactions call");
  assert.match(out.guidance, /no solver|solvers? .* bidding|priced it yet/i);
});

test("status: creates the signable tx when priced + accountId given; asks for accountId when missing", async () => {
  const priced = { status: "auction-in-progress", price: "0.0003", userSettlementDeadline: Date.now() + 120000 };
  // With accountId → creates the tx.
  const ctxA = mockCtx({ getSeq: [priced], txResp: { transactionId: "tx-xyz", status: "signing-required" } });
  const a = await swapTool.handler(ctxA, { action: "status", intentId: "i-1", accountId: "acc1", maxWaitSeconds: 0 });
  assert.equal(a.signableTransactionId, "tx-xyz");
  assert.equal(ctxA.calls.find((c) => c.path === "/workspaces/ws-test/transactions").body.params.intentId, "i-1");

  // Without accountId → priced but no tx; guidance asks for accountId.
  const ctxB = mockCtx({ getSeq: [priced] });
  const b = await swapTool.handler(ctxB, { action: "status", intentId: "i-1", maxWaitSeconds: 0 });
  assert.equal(b.solverPriced, true);
  assert.equal(b.signableTransactionId, undefined);
  assert.match(b.guidance, /accountId/);
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

test("expired: deadline passed while stuck at user-initiated → reported dead, not 'in progress'", async () => {
  const past = Date.now() - 60000;
  const ctx = mockCtx({
    createResp: { status: "user-initiated", userSettlementDeadline: past },
    getSeq: [{ status: "user-initiated", userSettlementDeadline: past }],
  });
  const out = await swapTool.handler(ctx, { action: "create", accountId: "acc1", fromAssetId: "a", toAssetId: "b", fromAmount: "1", maxWaitSeconds: 30 });
  assert.equal(out.status, "user-initiated");   // Bron's status relayed truthfully
  assert.equal(out.expired, true);              // but we derive that it's dead
  assert.equal(out.userActionRequired, false);
  assert.equal(out.terminal, false);
  assert.equal(out.pollComplete, true);         // stop telling the user to poll a dead intent
  assert.match(out.guidance, /dead|deadline passed/i);
  // It must not have burned the whole budget polling a dead intent.
  assert.ok(out.polledForSeconds < 5);
});

test("expired takes precedence: wait-for-user-tx but deadline already passed → not actionable", async () => {
  const past = Date.now() - 1000;
  const ctx = mockCtx({ getSeq: [{ status: "wait-for-user-tx", userSettlementDeadline: past }] });
  const out = await swapTool.handler(ctx, { action: "status", intentId: "i", maxWaitSeconds: 0 });
  assert.equal(out.expired, true);
  assert.equal(out.userActionRequired, false); // can't sign after the deadline
});

test("create with maxWaitSeconds 0 returns the intent id immediately without polling", async () => {
  const ctx = mockCtx({ createResp: { status: "user-initiated" }, getSeq: [{ status: "auction-in-progress" }] });
  const out = await swapTool.handler(ctx, { action: "create", accountId: "acc1", fromAssetId: "a", toAssetId: "b", fromAmount: "1", maxWaitSeconds: 0 });
  assert.ok(out.intentId);
  assert.equal(out.status, "user-initiated");
  // Only the create POST happened — no get-intent reads.
  assert.equal(ctx.calls.filter((c) => c.method === "GET").length, 0);
});

test("ApiError carries status/code/requestId in the message (no more bare upstream text)", async () => {
  const { toApiError } = await import("../src/api/client.js");
  const resp = { status: 500, statusText: "Internal Server Error", headers: { get: (h) => (h === "Correlation-Id" ? "req-abc-123" : null) } };
  const err = toApiError(resp, JSON.stringify({ message: "Something went wrong. Please try again", code: "INTERNAL" }));
  assert.match(err.message, /Bron API 500/);
  assert.match(err.message, /INTERNAL/);
  assert.match(err.message, /Something went wrong/);
  assert.match(err.message, /requestId: req-abc-123/);
  assert.equal(err.status, 500);
  assert.equal(err.bronMessage, "Something went wrong. Please try again");
});

test("expired but PRICED: reports everPriced/expiredAfterPricing, guidance blames the ~40s window, NOT solvers", async () => {
  // Solver priced it (price + toAmount present) but the settlement deadline passed.
  const priced = { status: "auction-in-progress", price: "6.5", fromAmount: "100", toAmount: "654", userSettlementDeadline: Date.now() - 1000 };
  const ctx = mockCtx({ createResp: { status: "user-initiated" }, getSeq: [priced] });
  const out = await swapTool.handler(ctx, { action: "create", accountId: "acc1", fromAssetId: "a", toAssetId: "b", fromAmount: "100", maxWaitSeconds: 1 });
  assert.equal(out.expired, true);
  assert.equal(out.everPriced, true, "a price was present -> everPriced");
  assert.equal(out.expiredAfterPricing, true);
  assert.match(out.guidance, /PRICED/);
  assert.match(out.guidance, /window|sign/i);
  assert.doesNotMatch(out.guidance, /no solver|nothing bid/i);
  // No signable tx (deadline passed) and it did not falsely claim a liquidity gap.
  assert.equal(out.signableTransactionId, undefined);
});

test("expired and NEVER priced: honestly reports no bid (everPriced false)", async () => {
  const unpriced = { status: "user-initiated", userSettlementDeadline: Date.now() - 1000 };
  const ctx = mockCtx({ createResp: { status: "user-initiated" }, getSeq: [unpriced] });
  const out = await swapTool.handler(ctx, { action: "create", accountId: "acc1", fromAssetId: "a", toAssetId: "b", fromAmount: "100", maxWaitSeconds: 1 });
  assert.equal(out.expired, true);
  assert.equal(out.everPriced, false);
  assert.match(out.guidance, /no solver|no bid/i);
});

test("409 on create: fails fast with an honest Bron-side message, does NOT retry-hammer", async () => {
  // Every POST /intents 409s (the real-world workspace-wide condition). We must NOT
  // retry — one attempt, then report it honestly.
  let intentPosts = 0;
  const ctx = {
    workspaceId: "ws-test", calls: [],
    client: {
      async post(path) {
        if (path.endsWith("/intents") && !path.endsWith("/quote")) {
          intentPosts++;
          const e = new Error("Bron API 409[conflict]: Something went wrong (requestId: r-1)");
          e.status = 409; e.code = "conflict";
          throw e;
        }
        return {};
      },
      async get() { return {}; },
    },
  };
  const out = await swapTool.handler(ctx, { action: "create", accountId: "acc1", fromAssetId: "5002", toAssetId: "2", fromAmount: "20", maxWaitSeconds: 1 });
  assert.equal(out.conflict, true);
  assert.equal(intentPosts, 1, "exactly one attempt — no retry-hammering");
  assert.match(out.guidance, /409 conflict/i);
  assert.match(out.guidance, /do NOT retry|requestId/i); // action-first, not a hardcoded cause
  assert.doesNotMatch(out.guidance, /same-pair|pending|rate-limit|cooldown/i); // no fabricated live cause
  assert.match(out.conflictError, /requestId/i); // the real requestId is surfaced
});
