---
name: bronkit-strategies
description: Set up, manage, and automate recurring/triggered Bron treasury strategies (DCA, idle→stake, de-risk, price-target) via the bronkit connector. Use when the user asks to automate, schedule, or set a recurring/conditional treasury action — e.g. "DCA $10 into ETH every morning", "stake my idle ATOM weekly", "sell CANTON to USDC if it drops below $0.17", or "start / activate / run my strategies automatically". Strategies live in the bronkit store and are managed in chat; ONE recurring Cowork task (the "metronome") fires them all.
---

# bronkit strategies + the Cowork metronome

Two separate things, kept simple:

1. **Strategies** — created and managed entirely **in chat** with the `strategy_*`
   tools. They live in the central bronkit store.
2. **The metronome** — ONE recurring Cowork scheduled task the user sets up **once**.
   Every hour it calls `strategy_run` with **no ids**, which evaluates **all** the
   user's enabled strategies against live prices/balances and prepares any triggered
   transactions.

Because the metronome always evaluates *whatever is enabled at that moment*, once it
exists the user never touches Cowork again: adding, pausing, or deleting a strategy in
chat changes what fires on the next tick. A strategy only ever **prepares** a tx; the
user signs each one in the Bron app (MPC). Never sign on their behalf.

## You cannot create the Cowork task yourself
An MCP connector cannot create a Cowork scheduled task. **Never claim you scheduled
anything.** Your job is to hand the user the paste line and the two steps to install it
themselves. (This is not `create_scheduled_task` — that's a Claude Desktop/Code local
tool; the metronome lives in Cowork and the user creates it via `/schedule`.)

## When the user asks to "start", "activate", or "run" strategies automatically
1. **Show what will run:** call `strategy_list` and summarise the **enabled** strategies
   (type + one-line trigger each). If none are enabled, offer to create one first.
2. **Get the paste text:** call `scheduler_setup_text`.
3. **Hand it over** with exactly two steps:
   - Present the returned `pasteText` verbatim in a copy-friendly block.
   - Tell the user: **open Cowork → type `/schedule` → paste this → confirm.**
   Add: this is a one-time setup; after it, manage strategies here in chat and the
   metronome picks up changes on its next hourly run — no more Cowork visits.

If the metronome already exists, don't send them back to Cowork — just confirm their
strategy is stored and enabled; the existing metronome will evaluate it next tick.

## Creating a strategy (in chat)
1. **Gather params** for the type (you always need `accountId` + the asset ids — ask or
   infer from a prior balances/accounts call). Confirm the plan in one line.
2. `strategy_create({ type, params })`. Keep the returned `id`.
3. If the user hasn't set up the metronome yet, offer the "activate" flow above so the
   strategy actually gets evaluated. (A stored strategy with no metronome never fires.)

## Strategy types (the only ones — all on existing primitives)
- **dca** — time schedule → swap a fixed amount A→B. params: `accountId, fromAssetId, toAssetId, amount, schedule`.
- **idle_to_stake** — when live idle balance exceeds a threshold, stake the excess. params: `accountId, assetId, threshold`.
- **de_risk** — when a live price crosses down to/below a level, swap a holding to a stable. params: `accountId, assetId, triggerPrice, toAssetId, and exactly one of amount | percent`.
- **price_target** — when a live price crosses to/through a target (above or below), swap. params: `accountId, assetId, direction ('above'|'below'), targetPrice, fromAssetId, toAssetId, amount`.

Price triggers (de_risk, price_target) fire **once per cross**: a strategy created
already past its target does NOT fire on creation, and it won't prepare duplicates on
repeat ticks — it re-arms only when price crosses back or the user re-enables it.
Do not invent other types (no derivatives/lending primitive exists).

## Managing strategies (all in chat, no Cowork needed)
- **List:** `strategy_list`.
- **Pause / resume:** `strategy_set_enabled({ strategyId, enabled:false|true })`
  (re-enabling re-arms a price trigger).
- **Edit params:** `strategy_update({ strategyId, params:{…} })` (re-validated).
- **Remove:** `strategy_delete({ strategyId })`.
The metronome reflects each change on its next run — nothing else to update, no Cowork.

## What a tick does (so you can explain it)
The metronome calls `strategy_run` with no ids. For each enabled strategy it re-reads
the **live** balance/price (never stored numbers), decides if the trigger trips, and if
so prepares the transaction(s) via `bron_tx_swap` / `bron_tx_staking`. Each prepared tx
carries a rationale (strategy, why, the trigger value) in its description and appears in
the Bron app to sign. `strategy_run` returns `{ checked, fired, results }`.

## Notes
- Only call `strategy_run` directly if the user says "run my strategies now"; otherwise
  it's the metronome's job.
- Signing has a **short window** for swaps (seconds after pricing) — tell the user to
  sign promptly in the Bron app or it re-fires next cycle.
