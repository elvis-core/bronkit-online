// Curated read tools (intent-shaped). All read-only. The workspace id is
// injected by the server from config — the model never passes it.

import { keepBalance, readDustThreshold } from "../util/dust.js";
import { attachUsdPrices } from "../util/prices.js";

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const ws = (ctx) => `/workspaces/${ctx.workspaceId}`;

export const readTools = [
  {
    name: "bron_workspace_info",
    title: "Workspace info",
    description: "Get your Bron treasury workspace's metadata (the account/organisation you operate in). Use for 'what workspace am I in', 'my Bron account'. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: RO,
    handler: (ctx) => ctx.client.get(ws(ctx)),
  },
  {
    name: "bron_accounts_list",
    title: "List accounts",
    description: "List your accounts (vaults) in the Bron workspace. Use for 'my accounts', 'list my vaults'. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        accountTypes: { type: "string", description: "Filter by account type, e.g. vault" },
        statuses: { type: "string", description: "Filter by status, e.g. active" },
        limit: { type: "integer" },
      },
      additionalProperties: false,
    },
    annotations: RO,
    handler: (ctx, a) => ctx.client.get(`${ws(ctx)}/accounts`, a),
  },
  {
    name: "bron_accounts_get",
    title: "Get account",
    description: "Get one of your accounts (vaults) by id. Read-only.",
    inputSchema: {
      type: "object",
      properties: { accountId: { type: "string" } },
      required: ["accountId"],
      additionalProperties: false,
    },
    annotations: RO,
    handler: (ctx, a) => ctx.client.get(`${ws(ctx)}/accounts/${a.accountId}`),
  },
  {
    name: "bron_balances_list",
    title: "Portfolio / balances",
    description:
      "Your holdings as a USD-priced portfolio (balances across all accounts). Each kept row carries a weightPct (% of total holdings); the portfolio total is in totals.holdingsValue. Unpriced / sub-threshold dust rows are dropped by default and returned as a compact dustSummary; pass includeDust:true to also get the dust list. Use for 'my balance', 'what do I hold', 'portfolio', 'net worth'. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        accountIds: { type: "string", description: "Filter to specific account id(s), comma-separated" },
        assetIds: { type: "string" },
        networkIds: { type: "string" },
        nonEmpty: { type: "boolean", description: "Only non-zero balances (default true)" },
        includeDust: { type: "boolean", description: "Keep unpriced / sub-threshold rows (default false)" },
        limit: { type: "integer" },
      },
      additionalProperties: false,
    },
    annotations: RO,
    handler: async (ctx, a = {}) => {
      const { includeDust, ...q } = a;
      if (q.nonEmpty === undefined) q.nonEmpty = true;
      const data = await ctx.client.get(`${ws(ctx)}/balances`, q);
      // Composite: merge USD prices in (separate /dictionary/asset-market-prices call).
      const { priced } = await attachUsdPrices(ctx.client, data);
      // Only split out dust when we actually have prices — never hand back an empty
      // list just because pricing was unavailable (that forces slow model fallback).
      if (priced > 0 && data && Array.isArray(data.balances)) {
        const threshold = readDustThreshold();
        const kept = [];
        const dust = [];
        for (const r of data.balances) (keepBalance(r, threshold) ? kept : dust).push(r);
        data.balances = kept;
        // Portfolio weights: % of total holdings USD per kept row + a totals.holdingsValue.
        const totalUsd = kept.reduce((s, r) => {
          const v = Number(r && r._embedded ? r._embedded.usdValue : NaN);
          return Number.isFinite(v) ? s + v : s;
        }, 0);
        for (const r of kept) {
          const v = Number(r && r._embedded ? r._embedded.usdValue : NaN);
          if (Number.isFinite(v) && totalUsd > 0) {
            r.weightPct = (Math.round((v / totalUsd) * 10000) / 100).toString();
          }
        }
        data.totals = { holdingsValue: Math.round(totalUsd * 100) / 100 };
        // Always summarise dust compactly so even the default answer can mention it
        // without the model rendering dozens of tiny rows (keeps includeDust fast too).
        const dustUsd = dust.reduce((s, r) => {
          const v = Number(r && r._embedded ? r._embedded.usdValue : NaN);
          return Number.isFinite(v) ? s + v : s;
        }, 0);
        data.dustSummary = { count: dust.length, totalUsd: Math.round(dustUsd * 100) / 100 };
        if (includeDust) {
          data.dust = dust.map((r) => ({
            symbol: r.symbol,
            network: r.networkId,
            amount: r.totalBalance,
            usdValue: r._embedded ? r._embedded.usdValue ?? null : null,
          }));
        }
      }
      return data;
    },
  },
  {
    name: "bron_tx_list",
    title: "List transactions",
    description:
      "List your Bron transactions — payments, transfers, deposits, withdrawals (metadata only). Read-only. Results include many small reward/deposit events; when summarising 'recent transactions', group or skip tiny dust entries rather than listing each. For the money movement of a specific transaction, call bron_tx_events on its id.",
    inputSchema: {
      type: "object",
      properties: {
        transactionStatuses: { type: "string" },
        transactionTypes: { type: "string" },
        accountIds: { type: "string" },
        createdAtFrom: { type: "string", description: "ISO 8601" },
        createdAtTo: { type: "string", description: "ISO 8601" },
        limit: { type: "integer" },
        offset: { type: "integer" },
      },
      additionalProperties: false,
    },
    annotations: RO,
    handler: (ctx, a) => ctx.client.get(`${ws(ctx)}/transactions`, a),
  },
  {
    name: "bron_tx_get",
    title: "Get transaction",
    description: "Get one transaction by id. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string" },
        embed: { type: "string", description: "Related data to embed, e.g. events" },
      },
      required: ["transactionId"],
      additionalProperties: false,
    },
    annotations: RO,
    handler: (ctx, a) =>
      ctx.client.get(`${ws(ctx)}/transactions/${a.transactionId}`, a.embed ? { embed: a.embed } : undefined),
  },
  {
    name: "bron_tx_events",
    title: "Transaction events",
    description: "Get the event-level money movement for one transaction. Read-only.",
    inputSchema: {
      type: "object",
      properties: { transactionId: { type: "string" } },
      required: ["transactionId"],
      additionalProperties: false,
    },
    annotations: RO,
    handler: (ctx, a) => ctx.client.get(`${ws(ctx)}/transactions/${a.transactionId}/events`),
  },
  {
    name: "bron_address_book_list",
    title: "List saved addresses",
    description: "List your saved addresses (address book) — saved crypto/wallet addresses, payees, beneficiaries. Use for 'my saved addresses', 'my payees', 'address book'. Read-only.",
    inputSchema: {
      type: "object",
      properties: { networkIds: { type: "string" } },
      additionalProperties: false,
    },
    annotations: RO,
    handler: (ctx, a) => ctx.client.get(`${ws(ctx)}/address-book-records`, a),
  },
  {
    name: "bron_address_book_get",
    title: "Get saved address",
    description: "Get one saved address (address-book record) by id. Read-only.",
    inputSchema: {
      type: "object",
      properties: { recordId: { type: "string" } },
      required: ["recordId"],
      additionalProperties: false,
    },
    annotations: RO,
    handler: (ctx, a) => ctx.client.get(`${ws(ctx)}/address-book-records/${a.recordId}`),
  },
];
