---
name: bronkit-strategies
description: Set up, manage, and (optionally) schedule recurring/triggered Bron treasury strategies (DCA, idle→stake, de-risk, price-target) via the bronkit connector. Use when the user asks to automate, schedule, or set a recurring/conditional treasury action — e.g. "DCA $10 into ETH every morning", "stake my idle ATOM weekly", "sell CANTON to USDC if it drops below $0.17", or "run my strategies". Strategies live in the bronkit store and are evaluated by a live Claude session calling strategy_run.
---

# bronkit strategies

A strategy is stored config the user sets up **in chat**. When evaluated, it re-reads
the **live** balance/price and, if the trigger is met at that moment, PREPARES a
transaction. Preparing is standing authorisation only — the user signs each one in the
Bron app (MPC). Never sign on their behalf.

## How strategies actually run (say this honestly — do not overpromise)
Strategies do **not** run themselves. There is **no server-side clock**. A strategy is
evaluated **only when a live Claude session calls `strategy_run`**. That happens two ways:
1. The user asks **"run my strategies"** (any surface, anytime).
2. The user sets up a **recurring task in their own Claude** (whatever device/feature
   they use) that calls `strategy_run` with no ids each run.

`strategy_run` with no ids evaluates **all enabled** strategies at that moment, so
adding/pausing/deleting in chat changes the next run automatically.

**The honest limitation — state it every time you set up a price trigger:** because a
strategy only runs while a Claude session is alive, a trigger like "sell if it drops
below X" is **not a 24/7 market watcher**. If no session runs during the move, it does
not fire. Do not let a user believe a de_risk protects them while they sleep. True
unattended 24/7 execution would have to live in the Bron platform, not here.

## Do not force a specific surface
Users operate Claude however is convenient (web, mobile, desktop). Do **not** prescribe
a particular scheduling flow, and never claim you (an MCP connector) created a schedule
yourself. If the user wants a hands-off recurring check, hand them the optional
paste-ready prompt from `scheduler_setup_text` and let them drop it into whatever
scheduled-task feature their Claude offers, at whatever cadence they like.

## Creating a strategy (in chat)
1. **Gather params** for the type (always need `accountId` + asset ids — ask or infer
   from a prior balances/accounts call). Confirm the plan in one line.
2. `strategy_create({ type, name, params })`. Give a **self-explanatory name** in the
   user's own words ("Buy ETH with 10 USDC every morning") — auto-generated if omitted.
3. **Never stop at "strategy is set up."** Relay the create result's `howItRuns`: it
   only runs when a session evaluates it, and it is not 24/7. Offer the optional
   `scheduler_setup_text` if they want it hands-off.

When listing strategies, lead with each one's **name**, not the type code.

## Strategy types (the only ones — all on existing primitives)
- **dca** — swap a fixed amount A→B; the `schedule` (hourly/daily/weekly) gates how often it re-prepares. params: `accountId, fromAssetId, toAssetId, amount, schedule`.
- **idle_to_stake** — when live idle balance exceeds a threshold, stake the excess. params: `accountId, assetId, threshold`.
- **de_risk** — when a live price crosses down to/below a level, swap a holding to a stable. params: `accountId, assetId, triggerPrice, toAssetId, and exactly one of amount | percent`.
- **price_target** — when a live price crosses to/through a target (above or below), swap. params: `accountId, assetId, direction ('above'|'below'), targetPrice, fromAssetId, toAssetId, amount`.

Price triggers (de_risk, price_target) fire **once per cross**: a strategy created
already past its target does NOT fire on creation, and it won't prepare duplicates on
repeat evaluations — it re-arms only when price crosses back or the user re-enables it.
Do not invent other types (no derivatives/lending primitive exists).

## Managing strategies (all in chat)
- **List:** `strategy_list`.
- **Pause / resume:** `strategy_set_enabled({ strategyId, enabled:false|true })` (re-enabling re-arms a price trigger).
- **Edit params:** `strategy_update({ strategyId, params:{…} })` (re-validated).
- **Remove:** `strategy_delete({ strategyId })`.
Whatever recurring task the user has reflects each change on its next run.

## What an evaluation does (so you can explain it)
`strategy_run` re-reads the **live** balance/price (never stored numbers), decides if
the trigger trips, and if so prepares the transaction(s) via `bron_tx_swap` /
`bron_tx_staking`. Each prepared tx carries a rationale (the strategy's name, why, the
trigger value) in its description and appears in the Bron app to sign. It returns
`{ checked, fired, results }`. Only call it directly when the user says "run my
strategies now"; otherwise it's the recurring task's job. Swaps have a **short signing
window** — tell the user to sign promptly in the Bron app or it re-fires next run.
