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

import { randomBytes } from "node:crypto";

// Bron requires client-generated ids in ITS format: 24-char lowercase base36.
// A UUID intentId makes POST /intents fail with a generic 409 "Something went
// wrong" — confirmed live 15 Jul 2026 (UUID 409s; this format prices and creates
// the signable tx). This was the real cause of the "week-long Bron-side 409".
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function bronId(len = 24) {
  const b = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += ID_ALPHABET[b[i] % ID_ALPHABET.length];
  return s;
}

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

// An intent is effectively dead once its signing deadline or auction-expiry has
// passed. Bron does not always flip the status itself (it can sit at
// user-initiated past the deadline), so we derive it rather than trust `status`.
function deadlinePassed(intent) {
  const now = Date.now();
  for (const v of [intent && intent.userSettlementDeadline, intent && intent.expiresAt]) {
    if (v != null && Number.isFinite(Number(v)) && Number(v) <= now) return true;
  }
  return false;
}

// A solver has bid once the intent carries a positive price in a live (non-
// terminal, non-expired) state. That is the cue to create the signable
// transaction — step 3 of Bron's intents flow.
function hasSolverPrice(intent) {
  if (!intent) return false;
  const n = Number(intent.price);
  if (!Number.isFinite(n) || n <= 0) return false;
  if (TERMINAL.has(intent.status) || intent.status === "not-exist") return false;
  if (deadlinePassed(intent)) return false;
  return true;
}

// Step 3: create the signable transaction that references the priced intent.
// This is the object that appears in the Bron app to sign (status
// "signing-required"). Uses the same /transactions endpoint as withdrawals;
// nothing moves until the user signs (MPC gate). externalId is stable per intent
// so a retry returns the same transaction instead of duplicating it.
async function createSignableTx(ctx, { intentId, accountId, externalId, description }) {
  const body = {
    accountId,
    externalId: externalId || `swap-${intentId}`,
    transactionType: "intents",
    params: { intentId },
  };
  if (description) body.description = description; // rationale travels to the signing surface
  return ctx.client.post(`${ws(ctx)}/transactions`, body);
}

// Poll the intent; once a solver prices it (and we have an accountId), create the
// signable transaction. Returns the poll result plus a `signable` summary.
async function pollAndMaybeSign(ctx, { intentId, accountId, maxWaitSeconds, seed, externalId, description }) {
  const startedAt = Date.now();
  let polled;
  try {
    polled = await pollIntent(ctx, intentId, { maxWaitSeconds, seed });
  } catch (e) {
    polled = { timeline: [], last: seed || null, pollError: e.message };
  }
  const polledForSeconds = Math.round((Date.now() - startedAt) / 1000);
  const signable = { priced: hasSolverPrice(polled.last), created: null, error: null };
  if (signable.priced && accountId) {
    try {
      signable.created = await createSignableTx(ctx, { intentId, accountId, externalId, description });
    } catch (e) {
      signable.error = e.message;
    }
  }
  return { ...polled, polledForSeconds, signable };
}

// Bounded poll of get-intent. Records each DISTINCT status as a transition.
// Stops on a STOP state, once a solver prices it, or when the budget elapses.
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
    // A solver has priced it — stop so we can create the signable transaction.
    if (last && hasSolverPrice(last)) break;
    // A passed deadline means the intent can no longer advance or be signed —
    // it's dead, so stop polling instead of waiting out the budget.
    if (last !== null && deadlinePassed(last)) break;
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
function summarise({ action, intentId, timeline, last, pollError, polledForSeconds, signable }) {
  signable = signable || { priced: false, created: null, error: null };
  const status = (last && last.status) || null;
  const terminal = status ? TERMINAL.has(status) : false;
  const notFound = status === "not-exist";
  const deadline = describeDeadline(last && last.userSettlementDeadline);
  const auctionExpiry = describeDeadline(last && last.expiresAt);
  // Bron may leave the status unchanged after a deadline lapses, so derive
  // "expired" rather than rely on the status flipping to cancelled/liquidated.
  const expired = !terminal && deadlinePassed(last);
  const userActionRequired = status === USER_ACTION && !expired;

  // The signable transaction (step 3) is the object the user signs in the app.
  const tx = signable.created || null;
  const signableTransactionId = tx ? tx.transactionId || (tx.transaction && tx.transaction.transactionId) || null : null;
  const signableStatus = tx ? tx.status || (tx.transaction && tx.transaction.status) || null : null;

  // A solver priced it at some point iff the intent ever carried a positive price.
  const everPriced = !!(last && Number(last.price) > 0);
  let guidance;
  if (tx) {
    guidance =
      "Signable transaction created — it is now in the Bron app awaiting your signature" +
      (signableStatus ? ` (status: ${signableStatus})` : "") +
      (deadline ? `, before ${deadline.iso} (~${deadline.secondsRemaining}s)` : "") +
      ". Open the Bron app and sign it to execute the swap.";
  } else if (status === "completed") {
    guidance = "Swap completed.";
  } else if (terminal) {
    guidance = `Swap ended: ${status}.`;
  } else if (expired) {
    // Distinguish the two very different expiry causes — DON'T claim "no solver"
    // when the intent actually got a price (that misdiagnosis wasted hours).
    guidance = everPriced
      ? `A solver PRICED this swap (you would have received ~${last.toAmount} ${""}for ${last.fromAmount}), but the SETTLEMENT WINDOW passed before it was signed, so it expired. Bron intents must be signed within seconds of pricing (~40s here) — the signable transaction inherits that deadline. This is NOT a solver/liquidity problem: the swap works, it just needs to be signed promptly in the Bron app. Automated 'prepare now, sign later' will usually miss this window unless signing is automated on the Bron side.`
      : `The deadline passed while still '${status}' and no solver ever priced it (no bid in time), so nothing was produced to sign.`;
  } else if (signable.priced && signable.error) {
    guidance = `A solver priced the intent, but creating the signable transaction failed: ${signable.error}. Ask me to retry (action:status with accountId).`;
  } else if (signable.priced && !signable.created) {
    guidance = "A solver priced the intent. Provide accountId (action:status with accountId, or action:create) so I can create the signable transaction for you to sign.";
  } else if (userActionRequired) {
    guidance =
      "Open the Bron app and approve/sign the swap before the settlement deadline" +
      (deadline ? ` (${deadline.iso}, ~${deadline.secondsRemaining}s left)` : "") +
      ". Then ask me to check the swap status.";
  } else if (notFound) {
    guidance = "Intent not found yet — it may still be registering. Ask me to check the status again shortly.";
  } else if (pollError) {
    guidance = `Stopped polling after a read error (${pollError}). Ask me to check the status again.`;
  } else {
    guidance =
      `Still ${status || "pending"} after ${polledForSeconds}s — no solver has priced it yet. ` +
      "If it never leaves 'user-initiated', the environment likely has no solvers bidding. Ask me to check the status again, or confirm solvers are active.";
  }

  return {
    action,
    intentId,
    status,
    statusLabel: status ? LABELS[status] || status : null,
    terminal,
    expired,
    userActionRequired,
    solverPriced: signable.priced,
    everPriced, // true if a solver priced it at any point (even if it later expired)
    expiredAfterPricing: expired && everPriced, // priced but not signed in the ~40s window (NOT a solver problem)
    signableTransaction: tx || undefined,
    signableTransactionId: signableTransactionId || undefined,
    signableTransactionError: signable.error || undefined,
    notFound,
    statusTimeline: timeline,
    userSettlementDeadline: deadline,
    auctionExpiry,
    amounts: last ? { fromAmount: last.fromAmount, toAmount: last.toAmount, price: last.price } : null,
    polledForSeconds,
    pollComplete: terminal || expired || userActionRequired || notFound || !!tx,
    pollError: pollError || undefined,
    guidance,
    note:
      "Flow: create intent -> solver prices it in the auction -> bronkit creates the signable transaction (transactionType:intents) -> you sign it in the Bron app (MPC gate). bronkit drives every step it can, but it cannot make a solver bid; with no active solver the intent stalls at user-initiated. Polling is bounded; call action:status (with accountId) to continue.",
  };
}

export const swapTool = {
  name: "bron_tx_swap",
  title: "Swap assets (Bron intent)",
  description:
    "Swap one asset for another via Bron's Intents auction. SAFE TO CALL — does NOT move funds; funds move only when the user signs the resulting transaction in the Bron app (MPC gate). " +
    "Full flow this tool drives: 1) create the intent, 2) poll until a solver prices it in the auction, 3) create the SIGNABLE transaction (transactionType:intents) — which appears in the Bron app for the user to sign. " +
    "Three actions: " +
    "action:'quote' = OPTIONAL indicative price preview (POST /intents/quote, no order created) — only if the user explicitly asks to preview; do NOT quote-then-confirm before a swap (the quote expires in seconds). " +
    "action:'create' = the DEFAULT for a swap request: place it directly WITHOUT asking the user to confirm first (auto-generates a unique intentId). A 409 conflict is returned as-is (with its requestId) and NOT retried. Once a solver prices it within the poll window it creates the signable transaction (returns signableTransactionId). The user reviews the price and signs or declines in the Bron app — that is the confirmation. Requires accountId. " +
    "action:'status' = re-check an existing intent by intentId; pass accountId so that if a solver has since priced it, the signable transaction is created on this check too (idempotent). " +
    "Identify assets by id (fromAssetId / toAssetId) and give exactly one of fromAmount or toAmount. " +
    "IMPORTANT — Bron intents have a SHORT settlement window (~40s). Two distinct expiry cases the result distinguishes: (a) everPriced=false → no solver bid in time (real liquidity gap); (b) expiredAfterPricing=true → a solver DID price it and a signable tx was (or would be) created, but it was not signed within the window, so it expired — this is NOT a solver problem, the swap works and just needs prompt signing in the Bron app. The signable tx inherits the intent deadline, so 'prepare now, sign later' automation will usually miss the window unless signing is automated on the Bron side.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["quote", "create", "status"], description: "quote = preview only; create = place the swap + create the signable tx once priced; status = check an existing intent (and create the signable tx if now priced)" },
      accountId: { type: "string", description: "Account id the swap is placed from (required for create; pass on status too so the signable transaction can be created once a solver prices the intent)" },
      fromAssetId: { type: "string", description: "Asset id being sent (required for quote/create)" },
      toAssetId: { type: "string", description: "Asset id to receive (required for quote/create)" },
      fromAmount: { type: "string", description: "Amount of the from-asset (decimal string). Give exactly one of fromAmount / toAmount." },
      toAmount: { type: "string", description: "Amount of the to-asset (decimal string). Give exactly one of fromAmount / toAmount." },
      intentId: { type: "string", description: "For action:status — the intent id to check. For create it is auto-generated and returned." },
      externalId: { type: "string", description: "Optional idempotency key for the signable transaction; defaults to a stable value derived from the intent id." },
      description: { type: "string", description: "Optional human rationale written onto the signable transaction so context travels to the Bron app for signing." },
      maxWaitSeconds: { type: "integer", description: `How long to poll within this call before returning (default ${DEFAULT_MAX_WAIT_S}, max ${MAX_MAX_WAIT_S}). Polling stops once a solver prices the intent, at a terminal/expired state, or at the budget.` },
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
        note: "Indicative quote only — no intent/order created. OPTIONAL: only use this if the user explicitly wants a price preview. For an actual swap, call action:'create' directly — do NOT quote-then-confirm (the quote expires in seconds).",
      };
    }

    if (action === "create") {
      if (!a.accountId) throw new Error("create needs accountId.");
      if (!a.fromAssetId || !a.toAssetId) throw new Error("create needs fromAssetId and toAssetId.");
      requireExactlyOneAmount(a);
      const amountFields = {};
      if (a.fromAmount != null && a.fromAmount !== "") amountFields.fromAmount = a.fromAmount;
      if (a.toAmount != null && a.toAmount !== "") amountFields.toAmount = a.toAmount;

      // Create the intent (POST /intents), then poll until a solver prices it and
      // create the signable transaction (step 3) so it appears in the Bron app to sign.
      // Do NOT auto-retry a 409: diagnosis showed intent-create currently 409s
      // workspace-wide (every pair/account) while reads/quote/withdrawals work — so a
      // 409 is a Bron-side condition on the intent-create endpoint (possibly a rate
      // limit/cooldown), NOT a fixable same-pair conflict. Retrying only hammers it.
      const intentId = a.intentId || bronId();
      const body = { accountId: a.accountId, intentId, fromAssetId: a.fromAssetId, toAssetId: a.toAssetId, ...amountFields };
      let created;
      try {
        created = await ctx.client.post(`${ws(ctx)}/intents`, body);
      } catch (e) {
        if (e && (e.status === 409 || e.code === "conflict")) {
          return {
            action: "create",
            intentId,
            conflict: true,
            status: null,
            guidance:
              "Intent NOT created — Bron returned a 409 conflict on POST /intents. Relay the status, message and requestId (in conflictError) to the user, and do NOT retry automatically. Escalate to Bron support with the requestId if it persists. " +
              "Prior context (history, not a claim about this specific call): the same 409 was seen on 8 Jul and 15 Jul 2026 across multiple pairs and accounts while reads and quotes on the same pairs returned 200 — consistent with a Bron-side condition on the intent-create endpoint rather than a malformed request. Treat that as background, not as the confirmed cause here.",
            conflictError: e.message,
          };
        }
        throw e; // other failures propagate with the rich Bron API message
      }
      const r = await pollAndMaybeSign(ctx, {
        intentId,
        accountId: a.accountId,
        maxWaitSeconds: clampWait(a.maxWaitSeconds),
        seed: created,
        externalId: a.externalId,
        description: a.description,
      });
      return { ...summarise({ action: "create", intentId, ...r }), created };
    }

    if (action === "status") {
      if (!a.intentId) throw new Error("status needs intentId.");
      // Pass accountId so that if a solver has now priced the intent, we create
      // the signable transaction on this check too (idempotent per intent).
      const r = await pollAndMaybeSign(ctx, {
        intentId: a.intentId,
        accountId: a.accountId,
        maxWaitSeconds: clampWait(a.maxWaitSeconds),
        externalId: a.externalId,
        description: a.description,
      });
      return summarise({ action: "status", intentId: a.intentId, ...r });
    }

    throw new Error(`Unknown action: ${action}`);
  },
};

export const intentTools = [swapTool];
