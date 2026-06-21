// Composite tools — server-side multi-call orchestration + computation that
// returns a finished result, so the model makes one call instead of being made
// to orchestrate. Read-only.

import Decimal from "decimal.js";
import { preprocessEvents, runFifo } from "../util/fifo.js";
import { fetchUsdPriceMap, attachUsdPrices } from "../util/prices.js";
import { readDustThreshold } from "../util/dust.js";

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const ws = (ctx) => `/workspaces/${ctx.workspaceId}`;
const PAGE = 500;
const MAX_PAGES = 200; // safety cap: 200 × 500 = 100k transactions

// Walk the full completed/partially-completed history with events embedded.
async function fetchHistoryWithEvents(ctx) {
  const all = [];
  for (let page = 0, offset = 0; page < MAX_PAGES; page++, offset += PAGE) {
    const resp = await ctx.client.get(`${ws(ctx)}/transactions`, {
      transactionStatuses: "completed,partially-completed",
      includeEvents: true,
      limit: PAGE,
      offset,
    });
    const txs = (resp && resp.transactions) || [];
    all.push(...txs);
    if (txs.length < PAGE) break;
  }
  return all;
}

export const costBasisTool = {
  name: "bron_cost_basis",
  title: "Cost basis & P&L",
  description:
    "FIFO cost basis with realised + unrealised P&L per holding, reconstructed from full transaction history (event-level USD pricing, fees folded in). Read-only. Use for 'what did I pay for X', 'which holdings am I up on', 'rank by profit', 'lifetime fees'.",
  inputSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Optional: restrict to one asset symbol, e.g. ETH" },
      includeDust: { type: "boolean", description: "Include sub-threshold positions (default false)" },
    },
    additionalProperties: false,
  },
  annotations: RO,
  handler: async (ctx, a = {}) => {
    const txs = await fetchHistoryWithEvents(ctx);
    const stream = preprocessEvents(txs);
    const { positions, lifetimeFees } = runFifo(stream);

    const heldAssets = positions.filter((p) => new Decimal(p.held).gt(0)).map((p) => p.assetId);
    const priceMap = await fetchUsdPriceMap(ctx.client, heldAssets);
    const dust = new Decimal(readDustThreshold());

    const usd = (d) => new Decimal(d).toDecimalPlaces(2).toString(); // 2 dp for $ amounts
    const px = (d) => new Decimal(d).toDecimalPlaces(6).toString(); // 6 dp for per-unit prices
    let rows = positions.map((p) => {
      const held = new Decimal(p.held);
      const avg = new Decimal(p.avgBasis);
      const price = new Decimal(priceMap.get(p.assetId)?.price ?? 0);
      return {
        symbol: p.symbol,
        network: p.network,
        assetId: p.assetId,
        held: p.held, // full precision — quantities matter
        avgBasis: px(avg),
        currentPrice: px(price),
        currentValue: usd(held.times(price)),
        unrealisedUsd: usd(price.minus(avg).times(held)),
        unrealisedPct: avg.gt(0) ? price.minus(avg).div(avg).times(100).toDecimalPlaces(2).toString() : null,
        realised: usd(p.realised),
      };
    });

    // USD-value dust filter (not the skill's buggy held-quantity compare).
    if (!a.includeDust) {
      rows = rows.filter((p) => new Decimal(p.currentValue).gte(dust) || !new Decimal(p.realised).eq(0));
    }
    if (a.symbol) {
      const s = a.symbol.toUpperCase();
      rows = rows.filter((p) => (p.symbol || "").toUpperCase() === s);
    }
    rows.sort((x, y) => new Decimal(y.unrealisedUsd).cmp(new Decimal(x.unrealisedUsd)));

    const sum = (pick) => usd(rows.reduce((s, p) => s.plus(new Decimal(pick(p))), new Decimal(0)));
    const totals = {
      holdingsValue: sum((p) => p.currentValue), // total USD you currently hold
      unrealisedUsd: sum((p) => p.unrealisedUsd),
      realisedUsd: sum((p) => p.realised),
    };
    return { positions: rows, totals, lifetimeFees: usd(lifetimeFees), transactionsScanned: txs.length };
  },
};

// Curated stakeable / lendable allow-list (ported from the bron-opportunities
// skill). Conservative on purpose: off-list assets get a "check protocol docs"
// disclaimer rather than a guess. APY is NEVER quoted — Bron embeds no protocol
// rates, so we point at the venue's dashboard for live numbers instead.
const STAKE_BUCKETS = {
  "native-staking": new Set(["SOL", "ETH", "DOT", "ATOM", "MATIC", "AVAX", "NEAR", "ADA", "TIA", "DYDX"]),
  "stable-lending": new Set(["USDC", "USDT", "DAI"]),
  "btc-lending": new Set(["WBTC", "CBBTC"]),
};

function classifyIdle(symbol) {
  const s = (symbol || "").toUpperCase();
  if (STAKE_BUCKETS["native-staking"].has(s)) {
    return { bucket: "native-staking", recommendation: `Native staking (${symbol})` };
  }
  if (STAKE_BUCKETS["stable-lending"].has(s) || STAKE_BUCKETS["btc-lending"].has(s)) {
    const bucket = STAKE_BUCKETS["stable-lending"].has(s) ? "stable-lending" : "btc-lending";
    return { bucket, recommendation: bucket === "stable-lending" ? "Stable lending (Aave / Compound)" : "BTC lending (Aave / Compound)" };
  }
  return { bucket: null, recommendation: "Off-list — check protocol docs" };
}

const dec = (v) => {
  try {
    return new Decimal(v == null || v === "" ? 0 : v);
  } catch {
    return new Decimal(0);
  }
};

export const stakingOpportunitiesTool = {
  name: "bron_staking_opportunities",
  title: "Staking & yield opportunities",
  description:
    "Idle capital + staking/lending options across current holdings. Derives idle from withdrawableBalance (totalBalance − withdrawable = already-working), classifies each asset against a curated allow-list, and points at the venue's dashboard for rates. Never quotes APY. Read-only. Use for 'what could I be staking', 'where's my idle capital', 'what's not earning yield', 'show staking/lending options', 'how much of my X is idle'.",
  inputSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Optional: restrict to one asset symbol, e.g. ETH" },
      includeDust: { type: "boolean", description: "Include sub-threshold idle positions (default false)" },
      includeOffList: { type: "boolean", description: "Include off-list assets (CC, BRON, ZAMA, …) in positions (default false; off-list is summarised separately to keep responses fast)" },
    },
    additionalProperties: false,
  },
  annotations: RO,
  handler: async (ctx, a = {}) => {
    // Raw balances (NOT the dust-filtered read tool) + prices, so we keep every
    // row and apply the idle-specific filter ourselves. withdrawableBalance is
    // the authoritative idle signal; Bron prices the whole position, so we
    // prorate usdValue by the idle share.
    const data = await ctx.client.get(`${ws(ctx)}/balances`, { nonEmpty: true });
    await attachUsdPrices(ctx.client, data);
    const dust = new Decimal(readDustThreshold());
    const usd = (d) => new Decimal(d).toDecimalPlaces(2).toString();
    const balances = (data && Array.isArray(data.balances) && data.balances) || [];

    let rows = balances.map((b) => {
      const total = dec(b.totalBalance);
      const idle = dec(b.withdrawableBalance); // missing → 0 (treated as fully locked)
      const locked = total.minus(idle);
      const usdTotal = dec(b._embedded && b._embedded.usdValue);
      const ratio = total.gt(0) ? idle.div(total) : new Decimal(0);
      const idleUsd = usdTotal.times(ratio);
      const cls = classifyIdle(b.symbol);
      return {
        symbol: b.symbol,
        network: b.networkId,
        assetId: b.assetId,
        total: total.toString(), // full precision — quantities matter
        idle: idle.toString(),
        locked: locked.toString(),
        idleUsd: usd(idleUsd),
        eligible: cls.bucket !== null,
        bucket: cls.bucket,
        recommendation: cls.recommendation,
      };
    });

    // Keep a row if its idle USD clears the dust threshold OR it has something
    // locked worth surfacing (mirrors the skill's filter).
    if (!a.includeDust) {
      rows = rows.filter((p) => new Decimal(p.idleUsd).gte(dust) || new Decimal(p.locked).gt(0));
    }
    if (a.symbol) {
      const s = a.symbol.toUpperCase();
      rows = rows.filter((p) => (p.symbol || "").toUpperCase() === s);
    }
    rows.sort((x, y) => new Decimal(y.idleUsd).cmp(new Decimal(x.idleUsd)));

    const sumIdle = (list) => usd(list.reduce((s, p) => s.plus(new Decimal(p.idleUsd)), new Decimal(0)));

    // Off-list rows are advisory-only (no actionable recommendation) and bloat
    // the response. Hide them by default; surface as a one-line summary.
    let offListSummary;
    if (!a.includeOffList) {
      const offRows = rows.filter((p) => !p.eligible);
      rows = rows.filter((p) => p.eligible);
      offListSummary = {
        count: offRows.length,
        idleUsd: sumIdle(offRows),
        symbols: offRows.map((p) => p.symbol).filter(Boolean),
      };
    }

    const totals = {
      idleUsd: sumIdle(rows), // total deployable idle USD across kept rows
      eligibleIdleUsd: sumIdle(rows.filter((p) => p.eligible)), // idle USD on assets we can act on
    };
    const result = {
      positions: rows,
      totals,
      note: "Live APY/yield rates are deliberately not included. Tell the user to check the venue's dashboard themselves (Aave for lending, validator marketplaces for staking). DO NOT web-search for current rates — they vary and the user knows where to look.",
    };
    if (offListSummary) result.offListSummary = offListSummary;
    return result;
  },
};

// Staking rewards — sum realised reward events per asset over a date range
// (default YTD), plus a simple annualised APR estimate from principal staked in
// the same window. Perf trick: filter at the API by transaction type + date
// window so we pull ~10–60 stake-* tx rather than the full history (~500+).

const REWARD_EVENT_TYPES = new Set(["stake-earn-reward", "stake-take-reward"]);
const ACCRUED_EVENT_TYPE = "stake-reward-accrued";

function defaultRewardsFrom() {
  return new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)).toISOString();
}

async function fetchStakingHistory(ctx, { from, to }) {
  const all = [];
  const transactionTypes = "stake-claim,stake-earn-reward,stake-take-reward,stake-delegation,stake-undelegation";
  // Bron's createdAtFrom / createdAtTo use format `date-time-millis` — Unix
  // milliseconds as a string. ISO 8601 strings cause a 500. Convert here.
  const createdAtFrom = String(Date.parse(from));
  const createdAtTo = String(Date.parse(to));
  for (let page = 0, offset = 0; page < MAX_PAGES; page++, offset += PAGE) {
    const resp = await ctx.client.get(`${ws(ctx)}/transactions`, {
      transactionStatuses: "completed,partially-completed",
      transactionTypes,
      createdAtFrom,
      createdAtTo,
      includeEvents: true,
      limit: PAGE,
      offset,
    });
    const txs = (resp && resp.transactions) || [];
    all.push(...txs);
    if (txs.length < PAGE) break;
  }
  return all;
}

export const stakingRewardsTool = {
  name: "bron_staking_rewards",
  title: "Staking rewards & yield",
  description:
    "Per-asset staking rewards earned over a date range, plus a simple annualised APR estimate. Defaults to year-to-date (Jan 1 of the current year → now). Read-only. Use for 'staking rewards', 'yield earned', 'how much I made on staking', 'staking income YTD'. Pass includeAccrued:true to also count pending/accrued rewards alongside realised ones.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Start date, ISO 8601 (default Jan 1 of current year)" },
      to: { type: "string", description: "End date, ISO 8601 (default now)" },
      symbol: { type: "string", description: "Optional asset symbol filter, e.g. ETH" },
      includeAccrued: { type: "boolean", description: "Also count pending/accrued rewards (default false — realised only)" },
    },
    additionalProperties: false,
  },
  annotations: RO,
  handler: async (ctx, a = {}) => {
    const from = a.from || defaultRewardsFrom();
    const to = a.to || new Date().toISOString();
    const days = Math.max(1, (Date.parse(to) - Date.parse(from)) / 86_400_000);
    const txs = await fetchStakingHistory(ctx, { from, to });

    // Aggregate per asset.
    const byAsset = new Map();
    const slot = (assetId, sym, net) => {
      if (!byAsset.has(assetId)) {
        byAsset.set(assetId, {
          assetId, symbol: sym, network: net,
          rewards: new Decimal(0), rewardsUsd: new Decimal(0),
          principal: new Decimal(0), principalUsd: new Decimal(0),
        });
      }
      return byAsset.get(assetId);
    };

    for (const tx of txs) {
      const events = (tx && tx._embedded && tx._embedded.events) || [];
      for (const ev of events) {
        if (!ev || !ev.assetId) continue;
        const s = slot(ev.assetId, ev.symbol, ev.networkId);
        const isReward = REWARD_EVENT_TYPES.has(ev.eventType) || (a.includeAccrued && ev.eventType === ACCRUED_EVENT_TYPE);
        if (isReward) {
          s.rewards = s.rewards.plus(dec(ev.amount));
          s.rewardsUsd = s.rewardsUsd.plus(dec(ev.usdAmount));
        } else if (ev.eventType === "stake-delegation") {
          s.principal = s.principal.plus(dec(ev.amount));
          s.principalUsd = s.principalUsd.plus(dec(ev.usdAmount));
        } else if (ev.eventType === "stake-undelegation") {
          s.principal = s.principal.minus(dec(ev.amount));
          s.principalUsd = s.principalUsd.minus(dec(ev.usdAmount));
        }
      }
    }

    const usd = (d) => new Decimal(d).toDecimalPlaces(2).toString();
    let rows = [...byAsset.values()].map((r) => {
      const periodPct = r.principalUsd.gt(0)
        ? r.rewardsUsd.div(r.principalUsd).times(100).toDecimalPlaces(2).toString()
        : null;
      const aprPct = periodPct != null
        ? new Decimal(periodPct).times(365 / days).toDecimalPlaces(2).toString()
        : null;
      return {
        symbol: r.symbol, network: r.network, assetId: r.assetId,
        rewards: r.rewards.toString(),
        rewardsUsd: usd(r.rewardsUsd),
        principal: r.principal.toString(),
        principalUsd: usd(r.principalUsd),
        periodPct, aprPct,
      };
    });

    if (a.symbol) {
      const s = a.symbol.toUpperCase();
      rows = rows.filter((p) => (p.symbol || "").toUpperCase() === s);
    }
    rows.sort((x, y) => new Decimal(y.rewardsUsd).cmp(new Decimal(x.rewardsUsd)));

    const totalRewardsUsd = rows.reduce((s, r) => s.plus(new Decimal(r.rewardsUsd)), new Decimal(0));
    const totalPrincipalUsd = rows.reduce((s, r) => s.plus(new Decimal(r.principalUsd)), new Decimal(0));
    const totalsAprPct = totalPrincipalUsd.gt(0)
      ? totalRewardsUsd.div(totalPrincipalUsd).times(100).times(365 / days).toDecimalPlaces(2).toString()
      : null;

    return {
      from, to, days: Math.round(days * 10) / 10,
      positions: rows,
      totals: {
        rewardsUsd: usd(totalRewardsUsd),
        principalUsd: usd(totalPrincipalUsd),
        aprPct: totalsAprPct,
      },
      transactionsScanned: txs.length,
      note: "APR is a simple annualised estimate (rewards / principal × 365 / days). Live yields vary — check the protocol dashboard for current rates.",
    };
  },
};

// Accounts overview — one-call summary for "what accounts do I have and what
// are my balances": per-account name + total USD + asset count. Server-side
// fetches accounts + priced balances in parallel and joins, so the model gets
// exactly the per-account shape (not a per-asset enumeration) in a single call.

export const accountsOverviewTool = {
  name: "bron_accounts_overview",
  title: "Accounts overview (per-account totals)",
  description:
    "One-call summary of your accounts (vaults) with each account's USD total and priced-asset count. Read-only. Use for 'my accounts and balances', 'what accounts do I have', 'list my accounts with totals'. Faster than calling accounts_list + balances_list separately, and the response is intentionally per-account (no per-asset breakdown) — for the asset breakdown, use bron_balances_list.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: RO,
  handler: async (ctx) => {
    const [accountsResp, balancesResp] = await Promise.all([
      ctx.client.get(`${ws(ctx)}/accounts`),
      ctx.client.get(`${ws(ctx)}/balances`, { nonEmpty: true }),
    ]);
    await attachUsdPrices(ctx.client, balancesResp);
    const accounts = (accountsResp && accountsResp.accounts) || [];
    const balances = (balancesResp && Array.isArray(balancesResp.balances) && balancesResp.balances) || [];

    // Group priced balances by accountId.
    const byAcc = new Map();
    for (const b of balances) {
      if (!b || !b.accountId) continue;
      const v = Number(b._embedded ? b._embedded.usdValue : NaN);
      if (!Number.isFinite(v)) continue;
      const slot = byAcc.get(b.accountId) || { totalUsd: 0, assets: 0 };
      slot.totalUsd += v;
      slot.assets += 1;
      byAcc.set(b.accountId, slot);
    }

    let portfolioUsd = 0;
    const rows = accounts.map((a) => {
      const slot = byAcc.get(a.accountId) || { totalUsd: 0, assets: 0 };
      portfolioUsd += slot.totalUsd;
      return {
        accountId: a.accountId,
        accountName: a.accountName,
        accountType: a.accountType,
        status: a.status,
        totalUsd: Math.round(slot.totalUsd * 100) / 100,
        assetCount: slot.assets,
      };
    });
    rows.sort((x, y) => y.totalUsd - x.totalUsd);

    return {
      accounts: rows,
      totals: {
        holdingsValue: Math.round(portfolioUsd * 100) / 100,
        accountCount: rows.length,
      },
    };
  },
};

export const compositeTools = [costBasisTool, stakingOpportunitiesTool, stakingRewardsTool, accountsOverviewTool];
