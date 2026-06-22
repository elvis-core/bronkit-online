---
name: bronkit-strategies
description: Set up, manage, and schedule recurring/triggered Bron treasury strategies (DCA, idle→stake, de-risk) via the bronkit connector. Use when the user asks to automate, schedule, or set a recurring/conditional treasury action — e.g. "DCA $10 into ETH every morning", "stake my idle ATOM weekly", "sell AVOL to USDC if it drops below $1". Drives BOTH halves: the bronkit strategy store AND the Cowork scheduled task that fires it.
---

# bronkit strategy scheduler

bronkit-online stores strategies and runs them; **Claude (you)** is what creates the
Cowork scheduled task — an MCP server cannot call another server's tools, so bronkit
cannot create the task itself. Every strategy therefore has two halves you must keep
in sync:

1. the **stored strategy** (bronkit `strategy_*` tools), and
2. a **Cowork scheduled task** (`create_scheduled_task`) that calls `strategy_run`
   on each cycle.

A strategy only ever **prepares** transactions; the user signs each one in the Bron
app (MPC). Never sign on their behalf.

## Strategy types (the only ones — all on existing primitives)
- **dca** — time schedule → swap a fixed amount A→B. params: `accountId, fromAssetId, toAssetId, amount, schedule`.
- **idle_to_stake** — when live idle balance exceeds a threshold, stake the excess. params: `accountId, assetId, threshold`.
- **de_risk** — when a live price drops to/below a level, swap a holding to a stable. params: `accountId, assetId, triggerPrice, toAssetId, and exactly one of amount | percent`.

Do not invent other types (no derivatives/lending primitive exists).

## Setting up a strategy (the core flow)
When the user asks to automate a recurring/conditional action:

1. **Gather params** for the matching type. You always need `accountId` (which Bron
   account to act from) and the asset ids — ask if not given, or infer from a prior
   balances/accounts call. Confirm the plan in one line.
2. **Store it:** call `strategy_create({ type, params })`. Keep the returned `id`.
3. **Schedule it:** call the Cowork tool **`create_scheduled_task`** with:
   - a **recurring** schedule:
     - `dca` → match the user's cadence (e.g. daily 09:00).
     - `idle_to_stake` / `de_risk` → a **polling** cadence (e.g. hourly). `strategy_run`
       re-reads the live condition each run and only prepares when it actually trips,
       so polling more often just checks more often.
   - **prompt** (verbatim): `Call bronkit strategy_run for strategy <id>. If it prepared any transactions, tell me what and why. Do not sign anything.`
   - a recognisable title, e.g. `bronkit strategy <id>`.
4. **Link them:** call `strategy_update({ strategyId: <id>, scheduledTaskId: <task id from step 3> })`
   so pause/delete can later update both halves.
5. **Tell the user** both halves are set, and the two real constraints:
   - firing only happens while their computer + Claude are available (laptop awake);
   - they must **sign each prepared tx in the Bron app** — and swaps have a **short
     signing window** (seconds after a solver prices it), so be ready to sign promptly,
     or it lapses and re-fires next cycle.

## Managing strategies
- **List:** call `strategy_list`. Show type, params, enabled, lastFiredAt, and whether
  a `scheduledTaskId` is linked.
- **Pause / resume:** `strategy_set_enabled({ strategyId, enabled:false|true })`, AND
  pause/resume the linked Cowork task (`scheduledTaskId`) so it stops/starts running.
  (A disabled strategy is also skipped if `strategy_run` is called, so disabling alone
  is safe — but pausing the task too avoids pointless runs.)
- **Edit:** `strategy_update({ strategyId, params:{…} })` (params re-validated). If the
  cadence changed, update the Cowork task's schedule too.
- **Delete:** `strategy_delete({ strategyId })`, AND delete the linked Cowork task
  (`scheduledTaskId`). Do both — leaving the task orphaned will keep calling a missing
  strategy.

## What firing does (so you can explain it)
`strategy_run(strategyId)` re-reads the **live** balance/price (never stored numbers),
decides if the trigger trips, and if so prepares the transaction(s) via `bron_tx_swap`
/ `bron_tx_staking`. Each prepared tx is independent and carries a rationale (strategy,
why, the trigger value) in its description, so context travels to the phone. It returns
a summary of what it checked and what (if anything) it prepared.

## Notes
- `strategy_run` is for the scheduled task. Only call it directly if the user explicitly
  says "run my strategy now".
- If `create_scheduled_task` is not available in the session (no Cowork), say so plainly:
  the strategy is stored, but it won't fire until a scheduled task is created — don't
  pretend it's scheduled.
