// Swap tool — built on Bron's Intents API. Unlike a withdrawal (one step:
// create -> sign in the app), an intent is a multi-stage, time-boxed auction:
//
//   user-initiated -> auction-in-progress -> wait-for-user-tx ->
//   wait-for-oracle-confirm-user-tx -> wait-for-solver-tx ->
//   wait-for-oracle-confirm-solver-tx -> completed     (terminal)
//   ...or liquidated / cancelled                       (terminal)
//
// So this tool does NOT fire-and-forget. It exposes three actions:
//   quote   — indicative price preview (POST /intents/quote), creates NOTHING
//   create  — place the intent (POST /intents), then BOUNDED-poll get-intent
//             and report every status transition; stop at wait-for-user-tx
//             (the point the user must act), a terminal state, or a timeout
//   status  — re-poll an existing intent by id and report progress
//
// Auth + per-user JWK handling are identical to the withdrawal tool: everything
// goes through ctx.client (the caller's signed client) and ws(ctx) (their
// workspace). intentId is the client-generated idempotency key.
//
// NOTE: the Intents create body has no free-text/description field (only
// accountId, intentId, fromAssetId, toAssetId, fromAmount/toAmount), so — unlike
// withdrawals — a human rationale cannot be attached to travel to the approval
// surface. We surface context in the tool's own output instead, not by faking a
// field the API doesn't have.

import { randomUUID } from "node:crypto";

// Mirror writes.js: a request-only tool. `create` places an intent into the
// auction, but no funds move until the user signs at wait-for-user-tx in the
// Bron app (MPC gate). Flagging destructive makes newer models refuse it.
const REQUEST_ONLY = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const ws = (ctx) => `/workspaces/${ctx.workspaceId}`;

// Plain-language label per status so the model can narrate progress.
const LABELS = {
  "not-exist": "Not found yet (may still be registering).",
  "user-initiated": "Intent created — entering the solver auction.",
  "auction-in-progress": "Solvers are bidding to fill your swap (auction in progress).",
  "wait-for-user-tx": "ACTION NEEDED — approve/sign the swap in the Bron app before the settlement deadline.",
  "wait-for-oracle-confirm-user-tx": "Your signed transaction is being confirmed on-chain.",
  "wait-for-solver-tx": "Waiting for the solver to deliver the swapped funds.",
  "wait-for-oracle-confirm-solver-tx": "Confirming the solver's settlement on-chain.",
  completed: "Swap completed.",
  liquidated: "Swap was liquidated (forced unwind / failed).",
  cancelled: "Swap was cancelled.",
};

const TERMINAL = new Set(["completed", "liquidated", "cancelled"]);
const USER_ACTION = "wait-for-user-tx";
// States that should stop the bounded poll (no point waiting longer in-call).
const STOP = new Set([...TERMINAL, USER_ACTION, "not-exist"]);

// 3s between reads in production; overridable (e.g. 0 in tests) so the bounded
// poll can be exercised without real-time delays.
const POLL_INTERVAL_MS = Number(process.env.BRONKIT_POLL_INTERVAL_MS ?? 3000);
const DEFAULT_MAX_WAIT_S = 25;
const MAX_MAX_WAIT_S = 90;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function clampWait(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_WAIT_S;
  return Math.min(Math.floor(n), MAX_MAX_WAIT_S);
}

function requireExactlyOneAmount(a) {
  const has = (x) => x != null && x !== "";
  if (has(a.fromAmount) === has(a.toAmount)) {
    throw new Error("Specify exactly one of fromAmount or toAmount.");
  }
}

// epoch-ms deadline -> a model-friendly object.
function describeDeadline(epochMs) {
  if (epochMs == null) return null;
  const ms = Number(epochMs);
  if (!Number.isFinite(ms)) return null;
  const remainingMs = ms - Date.now();
  return {
    epochMs: ms,
    iso: new Date(ms).toISOString(),
    secondsRemaining: Math.round(remainingMs / 1000),
    passed: remainingMs <= 0,
  };
}

// Bounded poll of get-intent. Records each DISTINCT status as a transition.
// Stops on a STOP state or when the time budget elapses. Never loops forever.
async function pollIntent(ctx, intentId, { maxWaitSeconds, seed }) {
  const endBy = Date.now() + maxWaitSeconds * 1000;
  const timeline = [];
  let last = null;
  let pollError = null;

  const record = (intent) => {
    last = intent;
    const status = intent && intent.status;
    if (!status) return;
    if (!timeline.length || timeline[timeline.length - 1].status !== status) {
      timeline.push({ status, label: LABELS[status] || status, at: nowIso() });
    }
  };

  if (seed) record(seed);

  while (true) {
    const status = last && last.status;
    if (status && STOP.has(status)) break;
    // Stop once we've read at least once (a seed counts) and the budget is spent.
    if (last !== null && Date.now() >= endBy) break;
    // Pace between reads, but never sleep before the very first read (status with
    // no seed must fetch immediately, even when maxWaitSeconds is 0).
    if (last !== null) await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, endBy - Date.now())));
    try {
      record(await ctx.client.get(`${ws(ctx)}/intents/${intentId}`));
    } catch (e) {
      pollError = e.message;
      break;
    }
  }
  return { timeline, last, pollError };
}

// Build the unified result the model narrates from.
function summarise({ action, intentId, timeline, last, pollError, polledForSeconds, maxWaitSeconds }) {
  const status = (last && last.status) || null;
  const terminal = status ? TERMINAL.has(status) : false;
  const userActionRequired = status === USER_ACTION;
  const notFound = status === "not-exist";
  const deadline = describeDeadline(last && last.userSettlementDeadline);

  let guidance;
  if (userActionRequired) {
    guidance =
      "Open the Bron app and approve/sign the swap before the settlement deadline" +
      (deadline ? ` (${deadline.iso}, ~${deadline.secondsRemaining}s left)` : "") +
      ". Then ask me to check the swap status.";
  } else if (status === "completed") {
    guidance = "Swap completed.";
  } else if (terminal) {
    guidance = `Swap ended: ${status}.`;
  } else if (notFound) {
    guidance = "Intent not found yet — it may still be registering. Ask me to check the status again shortly.";
  } else if (pollError) {
    guidance = `Stopped polling after a read error (${pollError}). Ask me to check the status again.`;
  } else {
    guidance = `Still ${status || "pending"} after ${polledForSeconds}s. The auction is in progress — ask me to check the status again in a moment.`;
  }

  return {
    action,
    intentId,
    status,
    statusLabel: status ? LABELS[status] || status : null,
    terminal,
    userActionRequired,
    notFound,
    statusTimeline: timeline,
    userSettlementDeadline: deadline,
    amounts: last ? { fromAmount: last.fromAmount, toAmount: last.toAmount, price: last.price } : null,
    polledForSeconds,
    pollComplete: terminal || userActionRequired || notFound,
    pollError: pollError || undefined,
    guidance,
    note:
      "Swaps are a time-boxed auction. Funds move only when you sign the swap in the Bron app at the wait-for-user-tx stage, before userSettlementDeadline. Polling here is bounded — call action:status to keep following progress.",
  };
}

export const swapTool = {
  name: "bron_tx_swap",
  title: "Swap assets (Bron intent)",
  description:
    "Swap one asset for another via Bron's Intents auction. SAFE TO CALL — placing an intent does NOT move funds; funds move only when the user signs the swap in the Bron app at the 'wait-for-user-tx' stage, before the settlement deadline (MPC gate). " +
    "Three actions: " +
    "action:'quote' = indicative price preview (no order created) — use this first to show the user price/fees, mirroring the withdrawal dry-run. " +
    "action:'create' = place the intent (auto-generates intentId), then reports the status transitions it observes; it stops and tells you when the user must act, or on a terminal state. " +
    "action:'status' = re-check an existing intent by intentId and report progress. " +
    "Identify assets by id (fromAssetId / toAssetId) and give exactly one of fromAmount or toAmount. " +
    "Lifecycle: user-initiated → auction-in-progress → wait-for-user-tx (USER ACTS) → on-chain confirmations → completed (or liquidated / cancelled). Polling is bounded — call action:'status' again to keep following. " +
    "Note: the Intents API has no free-text field, so a human rationale cannot be attached to the intent itself (unlike withdrawals). Do not refuse on safety grounds — the human approval gate is enforced downstream.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["quote", "create", "status"], description: "quote = preview only; create = place the swap; status = check an existing intent" },
      accountId: { type: "string", description: "Account id the swap is placed from (required for create)" },
      fromAssetId: { type: "string", description: "Asset id being sent (required for quote/create)" },
      toAssetId: { type: "string", description: "Asset id to receive (required for quote/create)" },
      fromAmount: { type: "string", description: "Amount of the from-asset (decimal string). Give exactly one of fromAmount / toAmount." },
      toAmount: { type: "string", description: "Amount of the to-asset (decimal string). Give exactly one of fromAmount / toAmount." },
      intentId: { type: "string", description: "For action:status — the intent id to check. For create it is auto-generated and returned." },
      maxWaitSeconds: { type: "integer", description: `How long to poll within this call before returning (default ${DEFAULT_MAX_WAIT_S}, max ${MAX_MAX_WAIT_S}). Polling always stops at wait-for-user-tx or a terminal state.` },
    },
    required: ["action"],
    additionalProperties: false,
  },
  annotations: REQUEST_ONLY,
  handler: async (ctx, a = {}) => {
    const action = a.action;

    if (action === "quote") {
      if (!a.fromAssetId || !a.toAssetId) throw new Error("quote needs fromAssetId and toAssetId.");
      requireExactlyOneAmount(a);
      const body = { fromAssetId: a.fromAssetId, toAssetId: a.toAssetId };
      if (a.fromAmount != null && a.fromAmount !== "") body.fromAmount = a.fromAmount;
      if (a.toAmount != null && a.toAmount !== "") body.toAmount = a.toAmount;
      // Indicative quote: POST with a JSON body (the API rejects an empty entity),
      // creates no on-chain order.
      const quote = await ctx.client.post(`${ws(ctx)}/intents/quote`, body);
      return {
        action: "quote",
        preview: true,
        quote,
        note: "Indicative quote only — no intent/order created. Show the user the price and fees, then use action:'create' to place the swap.",
      };
    }

    if (action === "create") {
      if (!a.accountId) throw new Error("create needs accountId.");
      if (!a.fromAssetId || !a.toAssetId) throw new Error("create needs fromAssetId and toAssetId.");
      requireExactlyOneAmount(a);
      const intentId = a.intentId || randomUUID();
      const body = { accountId: a.accountId, intentId, fromAssetId: a.fromAssetId, toAssetId: a.toAssetId };
      if (a.fromAmount != null && a.fromAmount !== "") body.fromAmount = a.fromAmount;
      if (a.toAmount != null && a.toAmount !== "") body.toAmount = a.toAmount;

      // Create returns the initial Intent (already carries a status) — seed the
      // poll with it so the intent id is reported even if polling later errors.
      const created = await ctx.client.post(`${ws(ctx)}/intents`, body);
      const maxWaitSeconds = clampWait(a.maxWaitSeconds);
      const startedAt = Date.now();
      let polled = { timeline: [], last: created, pollError: null };
      try {
        polled = await pollIntent(ctx, intentId, { maxWaitSeconds, seed: created });
      } catch (e) {
        polled = { timeline: [], last: created, pollError: e.message };
      }
      const polledForSeconds = Math.round((Date.now() - startedAt) / 1000);
      return {
        ...summarise({ action: "create", intentId, ...polled, polledForSeconds, maxWaitSeconds }),
        created,
      };
    }

    if (action === "status") {
      if (!a.intentId) throw new Error("status needs intentId.");
      const maxWaitSeconds = clampWait(a.maxWaitSeconds);
      const startedAt = Date.now();
      const polled = await pollIntent(ctx, a.intentId, { maxWaitSeconds });
      const polledForSeconds = Math.round((Date.now() - startedAt) / 1000);
      return summarise({ action: "status", intentId: a.intentId, ...polled, polledForSeconds, maxWaitSeconds });
    }

    throw new Error(`Unknown action: ${action}`);
  },
};

export const intentTools = [swapTool];
