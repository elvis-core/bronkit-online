// Conversational management + firing for scheduled strategies. CRUD tools let
// Claude set/manage strategies in chat; strategy_fire is what the Cowork
// scheduled task (the clock) calls when a strategy is due — it re-reads the live
// condition and prepares the transaction(s). Strategies are scoped to the
// caller's user identity (ctx.userId), persisted in ctx.store.

import { STRATEGY_TYPES, validateStrategy, fireStrategy } from "../strategies.js";

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
    "Create a standing strategy that PREPARES transactions automatically when its trigger fires (a Cowork scheduled task is the clock). Standing authorisation to prepare only — signing always happens on the phone. Types: dca (time-scheduled swap), idle_to_stake (stake idle balance over a threshold), de_risk (swap to stable when a price drops). " +
    PARAMS_HELP,
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: STRATEGY_TYPES, description: "dca | idle_to_stake | de_risk" },
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
    const s = ctx.store.createStrategy(ctx.userId, { type: a.type, params: a.params, trigger });
    if (a.enabled === false) ctx.store.setStrategyEnabled(ctx.userId, s.id, false);
    return ctx.store.getStrategy(ctx.userId, s.id);
  },
};

const listTool = {
  name: "strategy_list",
  title: "List strategies",
  description: "List the user's strategies (id, type, params, trigger, enabled, lastFiredAt). Read-only.",
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
  description: "Update a strategy's params, enabled flag, and/or scheduledTaskId. Provided params are merged with the existing ones and re-validated against the type. The skill records the Cowork task id here via scheduledTaskId so pause/delete can update both halves. " + PARAMS_HELP,
  inputSchema: {
    type: "object",
    properties: {
      strategyId: { type: "string" },
      params: { type: "object", description: PARAMS_HELP, additionalProperties: true },
      enabled: { type: "boolean" },
      scheduledTaskId: { type: "string", description: "Id of the Cowork scheduled task that fires this strategy (set by the orchestration skill after create_scheduled_task)." },
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
        const outcome = await fireStrategy(ctx, s); // re-reads live condition + prepares
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

export const strategyTools = [createTool, listTool, updateTool, deleteTool, setEnabledTool, runTool];
