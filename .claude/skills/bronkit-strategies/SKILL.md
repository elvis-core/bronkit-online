---
name: bronkit-strategies
description: Set up, manage, and schedule recurring/triggered Bron treasury strategies (DCA, idle→stake, de-risk) via the bronkit connector. Use when the user asks to automate, schedule, or set a recurring/conditional treasury action — e.g. "DCA $10 into ETH every morning", "stake my idle ATOM weekly", "sell AVOL to USDC if it drops below $1". Drives BOTH halves: the bronkit strategy store AND the scheduled task that fires it.
---

# bronkit strategy scheduler

bronkit-online stores strategies and runs them; **Claude (you)** is what creates the
scheduled task — an MCP server cannot call another server's tools, so bronkit cannot
create the task itself. Every strategy has two halves you keep in sync:

1. the **stored strategy** (bronkit `strategy_*` tools), and
2. a **scheduled task** (`create_scheduled_task`) that calls `strategy_run` each cycle.

A strategy only ever **prepares** transactions; the user signs each one in the Bron
app (MPC). Never sign on their behalf.

## Surface requirement (check FIRST)
`create_scheduled_task` is a **local tool of Claude Desktop / Claude Code** — it is
**not** present in claude.ai web/mobile connector chats. Before promising a schedule,
confirm the tool is actually available in this session. If it isn't, say so plainly:
the strategy is stored but **unscheduled**, and the user must drive this from a
Desktop/Claude Code session. Do not pretend it's scheduled.

Scheduled tasks **run only while that app is open** (a closed app runs due tasks on
next launch). Tell the user this.

## Strategy types (the only ones — all on existing primitives)
- **dca** — time schedule → swap a fixed amount A→B. params: `accountId, fromAssetId, toAssetId, amount, schedule`.
- **idle_to_stake** — when live idle balance exceeds a threshold, stake the excess. params: `accountId, assetId, threshold`.
- **de_risk** — when a live price drops to/below a level, swap a holding to a stable. params: `accountId, assetId, triggerPrice, toAssetId, and exactly one of amount | percent`.

Do not invent other types (no derivatives/lending primitive exists).

## Setting up a strategy (core flow)
1. **Gather params** for the type. You always need `accountId` and the asset ids — ask
   or infer from a prior balances/accounts call. Confirm the plan in one line.
2. **Store it:** `strategy_create({ type, params })`. Keep the returned `id`.
3. **Schedule it:** call **`create_scheduled_task`** with its real schema:
   - `taskId`: kebab-case, derived from the strategy id, e.g. `bronkit-strategy-<short-id>`.
   - `description`: one line, e.g. `bronkit dca strategy <short-id>`.
   - `cronExpression`: 5-field, **local time** (recurring). Pick from the strategy:
     - `dca` → the user's cadence, e.g. `"3 9 * * *"` (daily ~09:00 — nudge off :00).
     - `idle_to_stake` / `de_risk` → a **polling** cadence, e.g. `"7 * * * *"` (hourly).
       `strategy_run` re-reads the live condition and only prepares when it trips, so
       polling more often just checks more often.
     - For a one-time action instead, use `fireAt` (ISO 8601 with offset), not cron.
   - `prompt` — **self-contained** (each run starts fresh with no memory of this chat,
     so name the connector): `Using the bronkit connector, call strategy_run for strategy <id>. If it prepared any transactions, tell me what and why. Do not sign anything.`
4. **Link them:** `strategy_update({ strategyId: <id>, scheduledTaskId: <the taskId you chose> })`.
   (You control `taskId`, so set it deterministically and store it now.)
5. **Tell the user:** both halves are set; it fires only while their Desktop/Claude
   Code app is open; and they **sign each prepared tx in the Bron app** — swaps have a
   **short signing window** (seconds after pricing), so sign promptly or it re-fires next cycle.

## Managing strategies
- **List:** `strategy_list` (and `list_scheduled_tasks` for the schedule / nextRunAt).
- **Pause / resume:** `strategy_set_enabled({ strategyId, enabled:false|true })` AND
  `update_scheduled_task({ taskId, enabled:false|true })`. (A disabled strategy is also
  skipped if run, so disabling the strategy alone is safe — but pause the task too to
  avoid pointless runs.)
- **Edit cadence:** `update_scheduled_task({ taskId, cronExpression })`.
- **Edit params:** `strategy_update({ strategyId, params:{…} })` (re-validated).
- **Stop/remove:** `strategy_delete({ strategyId })` AND stop its task with
  `update_scheduled_task({ taskId, enabled:false })`. (The scheduled-tasks toolset
  exposes create/update/list; if a delete tool is available, use it — otherwise disable
  the task so it stops calling a deleted strategy. Do not invent a delete tool.)

## What firing does (so you can explain it)
`strategy_run(strategyId)` re-reads the **live** balance/price (never stored numbers),
decides if the trigger trips, and if so prepares the transaction(s) via `bron_tx_swap`
/ `bron_tx_staking`. Each prepared tx is independent and carries a rationale (strategy,
why, the trigger value) in its description. It returns a summary of what it checked and
what (if anything) it prepared.

## Notes
- `strategy_run` is for the scheduled task. Only call it directly if the user says
  "run my strategy now".
- Use the exact `taskId` both in `create_scheduled_task` and as the strategy's
  `scheduledTaskId`, so list/pause/edit/stop can always find the task.
