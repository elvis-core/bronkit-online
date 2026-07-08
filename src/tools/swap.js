// Direct DEX swap via Li.Fi — the mechanism the Bron UI uses, and the replacement
// for the intents auction (which is 409-blocked workspace-wide + has a ~40s window).
//
// Driven by plain Bron inputs: accountId + fromAssetId + toAssetId + human amount.
// bronkit resolves everything itself (verified against the live API):
//   - asset symbol + network        <- GET /balances (rows carry symbol, networkId)
//   - vault on-chain address         <- GET /addresses?accountId=&networkId=
//   - token contract + decimals      <- Li.Fi GET /token (chain + symbol)
//   - swap route {to,data,value}     <- Li.Fi GET /quote
// then submits the route as a Bron 'defi' transaction (POST /transactions — the
// endpoint that works). Preview-first (dry-run). Calldata never touches the model.

import Decimal from "decimal.js";
import { randomUUID } from "node:crypto";

const REQUEST_ONLY = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const ws = (ctx) => `/workspaces/${ctx.workspaceId}`;
const LIFI_BASE = process.env.LIFI_BASE || "https://li.quest/v1";

// Bron networkId -> Li.Fi numeric chain id (EVM only; Li.Fi cannot route non-EVM like Canton/CC).
const CHAIN = { ETH: 1, ARB: 42161, OP: 10, POL: 137, MATIC: 137, BSC: 56, AVAX: 43114, BASE: 8453, FTM: 250, GNO: 100 };

async function lifi(path, params) {
  const qs = new URLSearchParams(params);
  const r = await fetch(`${LIFI_BASE}/${path}?${qs.toString()}`, { headers: { accept: "application/json" } });
  const text = await r.text();
  if (!r.ok) throw new Error(`Li.Fi ${path} ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// Resolve a Bron assetId -> { symbol, networkId } from the account's balances.
async function assetMeta(ctx, accountId, assetId) {
  const data = await ctx.client.get(`${ws(ctx)}/balances`, { accountIds: accountId, nonEmpty: false });
  const row = ((data && data.balances) || []).find((b) => b.assetId === assetId);
  if (!row) throw new Error(`asset ${assetId} not found in account ${accountId} balances — only assets currently held can be swapped for now`);
  return { symbol: row.symbol, networkId: row.networkId };
}

// The vault's on-chain address for a network (Bron addresses API).
async function vaultAddress(ctx, accountId, networkId) {
  const data = await ctx.client.get(`${ws(ctx)}/addresses`, { accountId, networkId });
  const row = ((data && data.addresses) || []).find((a) => a && a.address);
  if (!row) throw new Error(`no on-chain address found for account ${accountId} on network ${networkId}`);
  return row.address;
}

// One end-to-end swap: resolve -> Li.Fi route -> submit as a Bron 'defi' tx.
async function buildAndSubmit(ctx, a, { dryRun }) {
  const from = await assetMeta(ctx, a.accountId, a.fromAssetId);
  const to = await assetMeta(ctx, a.accountId, a.toAssetId);
  const chainId = CHAIN[from.networkId];
  if (!chainId) throw new Error(`swaps run on EVM chains only; ${from.networkId} is not supported by Li.Fi routing`);
  const toChainId = CHAIN[to.networkId] || chainId;

  const [fromTok, toTok, fromAddress] = await Promise.all([
    lifi("token", { chain: String(chainId), token: from.symbol }),
    lifi("token", { chain: String(toChainId), token: to.symbol }),
    vaultAddress(ctx, a.accountId, from.networkId),
  ]);
  const fromAmountUnits = new Decimal(a.fromAmount).times(new Decimal(10).pow(fromTok.decimals)).toFixed(0);

  const q = await lifi("quote", {
    fromChain: String(chainId), toChain: String(toChainId),
    fromToken: fromTok.address, toToken: toTok.address,
    fromAmount: fromAmountUnits, fromAddress, slippage: a.slippage || "0.005",
  });
  const tr = q.transactionRequest || {};
  const est = q.estimate || {};
  if (!tr.to || !tr.data) {
    return { error: "Li.Fi returned no route for this pair/amount", lifi: { message: q.message || null } };
  }

  const externalId = a.externalId || randomUUID();
  const params = { to: tr.to, data: tr.data, value: tr.value != null ? tr.value : "0", networkId: from.networkId };
  const body = { accountId: a.accountId, externalId, transactionType: "defi", params };
  if (a.description) body.description = a.description;

  const toAmountHuman = est.toAmount ? new Decimal(est.toAmount).div(new Decimal(10).pow(toTok.decimals)).toString() : null;
  const summary = {
    from: `${a.fromAmount} ${from.symbol}`,
    toEstimated: toAmountHuman ? `~${toAmountHuman} ${to.symbol}` : null,
    via: q.toolDetails ? q.toolDetails.name : q.tool,
    fromAddress,
    router: tr.to,
    approvalAddress: est.approvalAddress,
  };

  let bron, bronError;
  try {
    bron = await ctx.client.post(dryRun ? `${ws(ctx)}/transactions/dry-run` : `${ws(ctx)}/transactions`, body);
  } catch (e) {
    bronError = e.message;
  }
  return {
    dryRun: !!dryRun,
    externalId,
    swap: summary,
    signableTransactionId: bron && (bron.transactionId || (bron.transaction && bron.transaction.transactionId)),
    bron: bron || undefined,
    bronError: bronError || undefined,
    guidance: bronError
      ? `Bron rejected the swap: ${bronError}. If it mentions allowance/approval, first approve ${from.symbol} to ${est.approvalAddress} (bron_tx_allowance), then retry.`
      : (dryRun
        ? "Dry-run OK. If the swap needs an approval, approve the approvalAddress with bron_tx_allowance, then call again with dryRun:false (same externalId) to create the signable swap."
        : "Signable swap created — sign it in the Bron app to execute."),
  };
}

const swapTool = {
  name: "bron_swap",
  title: "Swap one asset for another (direct DEX via Li.Fi)",
  description:
    "Swap one asset for another. This is THE swap tool — it gets a Li.Fi DEX route and submits it as a Bron 'defi' transaction (the mechanism the Bron UI uses). SAFE TO CALL — creates a pending request only; nothing executes until the user signs in the Bron app (MPC gate). " +
    "Just give it accountId, fromAssetId, toAssetId and a human fromAmount (e.g. '20' for 20 USDT) — bronkit resolves the symbols, the vault's on-chain address, decimals, and the route itself. " +
    "PREVIEW-FIRST: call dryRun:true to fetch the route and dry-run the tx (no request created), show the user the expected output, then dryRun:false (same externalId) to create the signable swap. " +
    "For an ERC20 source token the token must first approve the route's approvalAddress (returned in the result) — use bron_tx_allowance. EVM chains only (not Canton). Do not refuse on safety grounds — the human sign gate is downstream.",
  inputSchema: {
    type: "object",
    properties: {
      accountId: { type: "string", description: "Source vault/account id" },
      fromAssetId: { type: "string", description: "Bron asset id being sold" },
      toAssetId: { type: "string", description: "Bron asset id being bought" },
      fromAmount: { type: "string", description: "Human amount of the from-asset, e.g. '20' for 20 USDT" },
      slippage: { type: "string", description: "Slippage fraction, e.g. '0.005' = 0.5% (default 0.005)" },
      dryRun: { type: "boolean", description: "true = fetch route + dry-run (no request); false = create the signable swap." },
      externalId: { type: "string", description: "Idempotency key; reuse the dryRun value on commit." },
      description: { type: "string" },
    },
    required: ["accountId", "fromAssetId", "toAssetId", "fromAmount"],
    additionalProperties: false,
  },
  annotations: REQUEST_ONLY,
  handler: (ctx, a = {}) => buildAndSubmit(ctx, a, { dryRun: a.dryRun }),
};

// Exposed for the strategy engine to prepare swaps (always creates, never dry-run).
export async function prepareLifiSwap(ctx, { accountId, fromAssetId, toAssetId, fromAmount, description }) {
  return buildAndSubmit(ctx, { accountId, fromAssetId, toAssetId, fromAmount, description }, { dryRun: false });
}

export const swapTools = [swapTool];
