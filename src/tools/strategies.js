// Conversational management + firing for scheduled strategies. CRUD tools let
// Claude sets/manages strategies in chat; strategy_run is what a live session (the
// user, or a recurring task they set up in their own Claude) calls to evaluate them
// — it re-reads the live condition and prepares the transaction(s). There is no
// server-side clock. Strategies are scoped to the caller's user identity
// (ctx.userId), persisted in ctx.store.

import { STRATEGY_TYPES, validateStrategy, fireStrategy, defaultStrategyName } from "../strategies.js";

const CONFIG = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }; // local store, reversible
const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
// Firing prepares transactions on Bron (signing-required), gated by MPC downstream.
const REQUEST_ONLY = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

function need(ctx) {
  if (!ctx || !ctx.store || !ctx.userId) throw new Error("strategy tools require an authenticated user context");
}

const PARAMS_HELP =
  "Type-specific params (validated): " +
  "dca = {accountId, fromAssetId, toAssetId, amount, schedule}; " +
  "idle_to_stake = {accountId, assetId, threshold}; " +
  "de_risk = {accountId, assetId, triggerPrice, toAssetId, and exactly one of amount | percent}; " +
  "price_target = {accountId, assetId, direction ('above'|'below'), targetPrice, fromAssetId, toAssetId, amount}.";

const createTool = {
  name: "strategy_create",
  title: "Create a strategy",
  description:
    "Create a standing strategy that PREPARES a transaction when its trigger is met AT THE MOMENT IT IS EVALUATED. Standing authorisation to prepare only — signing always happens in the Bron app. Types: dca (time-scheduled swap), idle_to_stake (stake idle balance over a threshold), de_risk (swap to a stable when a price crosses down to/below a level), price_target (swap when a price crosses a target, direction above|below). " +
    PARAMS_HELP +
    " IMPORTANT: after creating, ALWAYS relay the create result's howItRuns field — a stored strategy does NOT run on its own; it is only evaluated when a live Claude session calls strategy_run (the user asking 'run my strategies', or a recurring task they set up in Claude). Be honest that it only runs while a session is alive, and that price triggers do NOT watch the market 24/7.",
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: STRATEGY_TYPES, description: "dca | idle_to_stake | de_risk | price_target" },
      name: { type: "string", description: "Self-explanatory human name shown in lists and in the signed-transaction rationale, e.g. 'Buy ETH with 10 USDC every morning'. Auto-generated from the params if omitted." },
      params: { type: "object", description: PARAMS_HELP, additionalProperties: true },
      enabled: { type: "boolean", description: "Start enabled (default true)" },
    },
    required: ["type", "params"],
    additionalProperties: false,
  },
  annotations: CONFIG,
  handler: (ctx, a = {}) => {
    need(ctx);
    const { trigger } = validateStrategy(a.type, a.params || {}); // throws on invalid params
    const name = (typeof a.name === "string" && a.name.trim().slice(0, 120)) || defaultStrategyName(a.type, a.params || {});
    const s = ctx.store.createStrategy(ctx.userId, { type: a.type, name, params: a.params, trigger });
    if (a.enabled === false) ctx.store.setStrategyEnabled(ctx.userId, s.id, false);
    return {
      ...ctx.store.getStrategy(ctx.userId, s.id),
      // Not persisted — the honest beat explanation the assistant must relay verbatim.
      howItRuns:
        "Stored, but NOT self-running. Nothing on this server wakes up on its own — the strategy is evaluated ONLY when a live Claude session calls strategy_run. Two ways that happens: (1) the user asks 'run my strategies' anytime; (2) the user sets up a recurring task in Claude (on whichever device they use) that calls strategy_run — which then evaluates ALL their enabled strategies each run. Tell the user this plainly, and tell them the honest limit: it runs only WHILE a Claude session is alive, so a price trigger like 'sell if it drops below X' does NOT watch the market 24/7 — if no session runs during the drop, it won't fire. For a hands-off recurring check, offer scheduler_setup_text (a ready-to-paste prompt for Claude's scheduler). Do not promise unattended 24/7 firing.",
    };
  },
};

const listTool = {
  name: "strategy_list",
  title: "List strategies",
  description: "List the user's strategies (id, name, type, params, trigger, enabled, lastFiredAt). Read-only. When showing the user, lead with each strategy's NAME (self-explanatory), not its type code.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: READ,
  handler: (ctx) => {
    need(ctx);
    return { strategies: ctx.store.listStrategies(ctx.userId) };
  },
};

const updateTool = {
  name: "strategy_update",
  title: "Update a strategy",
  description: "Update a strategy's name, params, enabled flag, and/or scheduledTaskId. Provided params are merged with the existing ones and re-validated against the type. scheduledTaskId optionally records the id of a recurring Claude task the user set up to evaluate strategies, if they want to track it. " + PARAMS_HELP,
  inputSchema: {
    type: "object",
    properties: {
      strategyId: { type: "string" },
      name: { type: "string", description: "New self-explanatory human name" },
      params: { type: "object", description: PARAMS_HELP, additionalProperties: true },
      enabled: { type: "boolean" },
      scheduledTaskId: { type: "string", description: "Optional id of a recurring Claude task the user set up to call strategy_run, if they want to track which one drives their strategies." },
    },
    required: ["strategyId"],
    additionalProperties: false,
  },
  annotations: CONFIG,
  handler: (ctx, a = {}) => {
    need(ctx);
    const existing = ctx.store.getStrategy(ctx.userId, a.strategyId);
    if (!existing) throw new Error(`strategy not found: ${a.strategyId}`);
    const patch = {};
    if (a.name !== undefined) patch.name = String(a.name).trim().slice(0, 120) || existing.name;
    if (a.params !== undefined) {
      const merged = { ...existing.params, ...a.params };
      const { trigger } = validateStrategy(existing.type, merged); // re-validate full set
      patch.params = merged;
      patch.trigger = trigger;
    }
    if (a.enabled !== undefined) patch.enabled = a.enabled;
    if (a.scheduledTaskId !== undefined) patch.scheduledTaskId = a.scheduledTaskId;
    return ctx.store.updateStrategy(ctx.userId, a.strategyId, patch);
  },
};

const deleteTool = {
  name: "strategy_delete",
  title: "Delete a strategy",
  description: "Delete a strategy by id.",
  inputSchema: {
    type: "object",
    properties: { strategyId: { type: "string" } },
    required: ["strategyId"],
    additionalProperties: false,
  },
  annotations: { ...CONFIG, destructiveHint: true },
  handler: (ctx, a = {}) => {
    need(ctx);
    return { deleted: ctx.store.deleteStrategy(ctx.userId, a.strategyId), strategyId: a.strategyId };
  },
};

const setEnabledTool = {
  name: "strategy_set_enabled",
  title: "Enable / disable a strategy",
  description: "Enable or disable a strategy (enabled:true|false). A disabled strategy is skipped when fired.",
  inputSchema: {
    type: "object",
    properties: {
      strategyId: { type: "string" },
      enabled: { type: "boolean" },
    },
    required: ["strategyId", "enabled"],
    additionalProperties: false,
  },
  annotations: CONFIG,
  handler: (ctx, a = {}) => {
    need(ctx);
    if (!ctx.store.getStrategy(ctx.userId, a.strategyId)) throw new Error(`strategy not found: ${a.strategyId}`);
    // Re-enabling a price trigger re-arms it (per the fire-once/re-arm rule).
    const patch = a.enabled ? { enabled: true, armed: true } : { enabled: false };
    return ctx.store.updateStrategy(ctx.userId, a.strategyId, patch);
  },
};

// Optional ready-to-paste prompt for whatever recurring-task feature the user's
// Claude offers (Desktop scheduled task, Anthropic-cloud task — surface-neutral).
// One run calls strategy_run with no ids → every enabled strategy is evaluated.
// Self-contained: a scheduled run starts fresh with no chat memory, so it names the
// connector, the call, the reporting, and the sign reminder explicitly.
const SCHEDULER_PASTE_TEXT =
`Using the Bron (bronkit) connector, call strategy_run with no strategy ids — this evaluates all of my enabled treasury strategies against live prices and balances.

Then tell me in plain language: which strategies you checked, the live values you saw (prices and balances), and any transactions you prepared and why — include each strategy's rationale.

If you prepared any transactions, remind me they are waiting in the Bron app for me to sign; nothing moves until I approve them there.`;

const schedulerSetupTextTool = {
  name: "scheduler_setup_text",
  title: "Get a paste-ready recurring-check prompt",
  description:
    "Return an OPTIONAL ready-to-paste prompt the user can drop into whatever recurring/scheduled-task feature their Claude offers (Desktop app or Anthropic cloud — whichever they use). Each run calls strategy_run (no ids) to evaluate all enabled strategies. Hand the user its pasteText and let them set it up in their own scheduler — do NOT prescribe a specific surface, and never claim you (an MCP connector) created the schedule yourself. Be honest: whatever they use, it only runs while that Claude session/app is active — it is NOT a 24/7 market watcher. Read-only: returns text, creates nothing.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: READ,
  handler: (ctx) => {
    need(ctx);
    return {
      pasteText: SCHEDULER_PASTE_TEXT,
      howToUse:
        "Optional. Put this prompt into any recurring-task feature your Claude offers (e.g. a scheduled task on the device you use). Pick your own cadence (hourly is typical). It evaluates whatever strategies are enabled at that moment — add/pause/delete strategies in chat and the next run reflects it.",
      honestLimit:
        "It only runs while that Claude session/app is alive. There is no server-side 24/7 watcher, so a price trigger will NOT fire during a market move if no session runs then. For guaranteed unattended execution, that has to live in the Bron platform, not here.",
    };
  },
};

const runTool = {
  name: "strategy_run",
  title: "Run a strategy (re-check condition, prepare txs)",
  description:
    "Evaluate strategies against LIVE data and, if a trigger is tripped, PREPARE the transaction(s) — each appears in the Bron app to sign. This is what a scheduled task calls each cycle; it never acts on stored numbers (it re-reads the live balance/price every run). SAFE TO CALL — preparing does not move funds; signing is on the phone (MPC). Omit both ids to evaluate ALL enabled strategies for the user in one call; or pass strategyId for one, or strategyIds for a specific batch (each run independently — one failing does not abort the others, and no prepared tx assumes a prior one settled).",
  inputSchema: {
    type: "object",
    properties: {
      strategyId: { type: "string", description: "Run a single strategy" },
      strategyIds: { type: "array", items: { type: "string" }, description: "Run several specific strategies, each independently" },
    },
    additionalProperties: false,
  },
  annotations: REQUEST_ONLY,
  handler: async (ctx, a = {}) => {
    need(ctx);
    const singleId = !a.strategyIds && a.strategyId;
    let ids;
    if (a.strategyIds && a.strategyIds.length) ids = a.strategyIds;
    else if (a.strategyId) ids = [a.strategyId];
    // No ids: evaluate every ENABLED strategy for this user.
    else ids = ctx.store.listStrategies(ctx.userId).filter((s) => s.enabled).map((s) => s.id);

    const results = [];
    for (const id of ids) {
      const s = ctx.store.getStrategy(ctx.userId, id);
      if (!s) {
        results.push({ strategyId: id, error: "not found" });
        continue;
      }
      if (!s.enabled) {
        results.push({ strategyId: id, type: s.type, skipped: "disabled" });
        continue;
      }
      try {
        // Explicit ids = the user asked for THIS strategy now (bypasses the dca
        // cadence gate). The no-ids sweep never forces — same rule as the server clock.
        const force = !!(a.strategyId || (a.strategyIds && a.strategyIds.length));
        const outcome = await fireStrategy(ctx, s, { force }); // re-reads live condition + prepares
        if (outcome.fired) ctx.store.touchStrategyFired(ctx.userId, id);
        results.push({ strategyId: id, type: s.type, ...outcome });
      } catch (e) {
        // One strategy's failure must not abort the batch.
        results.push({ strategyId: id, type: s.type, error: e.message });
      }
    }
    // Single explicit id → return that result directly; otherwise a plain summary.
    if (singleId) return results[0];
    return { checked: results.length, fired: results.filter((r) => r.fired).length, results };
  },
};

export const strategyTools = [createTool, listTool, updateTool, deleteTool, setEnabledTool, runTool, schedulerSetupTextTool];
