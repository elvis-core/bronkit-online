// Direct DEX swap via Li.Fi — the mechanism the Bron UI uses, and the replacement
// for the intents auction (which is 409-blocked workspace-wide + has a ~40s window).
//
// Driven by plain Bron inputs: accountId + fromAssetId + toAssetId + human amount.
// bronkit resolves everything itself:
//   - symbol/network/contract/decimals <- GET /dictionary/assets (all assets, not
//     just held; falls back to GET /balances if the dictionary is unavailable)
//   - vault on-chain address           <- GET /addresses?accountId=&networkId=
//   - swap route {to,data,value}       <- Li.Fi GET /quote, keyed by CONTRACT ADDRESS
//     (symbols are not stable across chains; Li.Fi GET /token is used only to fill a
//     missing address/decimals for a no-contract/native token)
// then submits the route as a Bron 'defi' transaction (POST /transactions).
// Preview-first: dryRun:true fetches the route only and never calls Bron;
// dryRun:false submits the create. Calldata never touches the model.

import Decimal from "decimal.js";
import { bronId } from "../ids.js";
import { fetchDictionaryAssets, resolveAssetById } from "./assets.js";

const REQUEST_ONLY = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const ws = (ctx) => `/workspaces/${ctx.workspaceId}`;
const LIFI_BASE = process.env.LIFI_BASE || "https://li.quest/v1";
const numOrNull = (v) => (v == null || v === "" ? null : Number(v));

// Bron networkId -> Li.Fi numeric chain id (EVM only; Li.Fi cannot route non-EVM like Canton/CC).
const CHAIN = { ETH: 1, ARB: 42161, OP: 10, POL: 137, MATIC: 137, BSC: 56, AVAX: 43114, BASE: 8453, FTM: 250, GNO: 100 };

async function lifi(path, params) {
  const qs = new URLSearchParams(params);
  const r = await fetch(`${LIFI_BASE}/${path}?${qs.toString()}`, { headers: { accept: "application/json" } });
  const text = await r.text();
  if (!r.ok) throw new Error(`Li.Fi ${path} ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// Fallback resolver: a Bron assetId -> { symbol, networkId } from the account's
// balances (held assets only). Used when the dictionary is unavailable.
async function assetMeta(ctx, accountId, assetId) {
  const data = await ctx.client.get(`${ws(ctx)}/balances`, { accountIds: accountId, nonEmpty: false });
  const row = ((data && data.balances) || []).find((b) => b.assetId === assetId);
  if (!row) throw new Error(`asset ${assetId} not found in account ${accountId} balances, and the dictionary did not resolve it either — check the id with bron_assets_list`);
  return { symbol: row.symbol, networkId: row.networkId };
}

// Best-effort dictionary fetch: [] on failure so resolution falls back to balances.
async function safeDictionary(ctx) {
  try {
    return await fetchDictionaryAssets(ctx.client);
  } catch {
    return [];
  }
}

// Resolve an asset id to everything Li.Fi needs. Prefers the dictionary (all
// assets + contract + decimals + chainId); falls back to held balances.
async function resolveAsset(ctx, accountId, assetId, dict) {
  const rec = dict.length ? await resolveAssetById(ctx.client, assetId, dict) : null;
  if (rec && rec.networkId) {
    return {
      symbol: rec.symbol,
      networkId: rec.networkId,
      chainId: numOrNull(rec.chainId),
      decimals: numOrNull(rec.decimals),
      contractAddress: rec.contractAddress || null,
    };
  }
  const meta = await assetMeta(ctx, accountId, assetId);
  return { symbol: meta.symbol, networkId: meta.networkId, chainId: null, decimals: null, contractAddress: null };
}

// The Li.Fi token id + decimals for an asset. Uses the dictionary CONTRACT ADDRESS
// when present (stable across chains — symbols like USDT are not); only a token
// with no contract in the dictionary (native coin, or a gap) falls back to Li.Fi's
// by-symbol lookup, which returns the correct address (native = zero-address).
async function lifiToken(asset, chainId) {
  if (asset.contractAddress) {
    let decimals = asset.decimals;
    if (decimals == null) decimals = (await lifi("token", { chain: String(chainId), token: asset.contractAddress })).decimals;
    return { address: asset.contractAddress, decimals };
  }
  const t = await lifi("token", { chain: String(chainId), token: asset.symbol });
  return { address: t.address, decimals: asset.decimals != null ? asset.decimals : t.decimals };
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
  const dict = await safeDictionary(ctx);
  const from = await resolveAsset(ctx, a.accountId, a.fromAssetId, dict);
  const to = await resolveAsset(ctx, a.accountId, a.toAssetId, dict);

  const chainId = numOrNull(from.chainId) || CHAIN[from.networkId];
  if (!chainId) throw new Error(`swaps run on EVM chains only; source ${from.networkId} (asset ${a.fromAssetId}) is not an EVM chain Li.Fi can route.`);
  const toChainId = numOrNull(to.chainId) || CHAIN[to.networkId];
  if (!toChainId) throw new Error(`destination ${to.networkId} (asset ${a.toAssetId}) is not an EVM chain Li.Fi can route — a cross-VM swap (e.g. into Solana) has to go through the intents path (bron_tx_swap), not bron_swap.`);

  const [fromTok, toTok, fromAddress] = await Promise.all([
    lifiToken(from, chainId),
    lifiToken(to, toChainId),
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

  const externalId = a.externalId || bronId();
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

  // Preview (dryRun) STOPS at the route. It never calls Bron, so it is a genuine
  // read — no state-changing endpoint is touched — and it stays useful even when the
  // Bron create endpoint is permission-blocked (403 create-vault-defi-transaction).
  if (dryRun) {
    return {
      dryRun: true,
      externalId,
      swap: summary,
      guidance:
        `Preview only — no Bron request was created (route resolved via ${summary.via || "Li.Fi"}). ` +
        (est.approvalAddress
          ? `This ERC20 source needs an approval first: approve ${from.symbol} to ${est.approvalAddress} with bron_tx_allowance. `
          : "") +
        "To create the signable swap, call again with dryRun:false and the same externalId.",
    };
  }

  let bron, bronError;
  try {
    bron = await ctx.client.post(`${ws(ctx)}/transactions`, body);
  } catch (e) {
    bronError = e.message;
  }
  return {
    dryRun: false,
    externalId,
    swap: summary,
    signableTransactionId: bron && (bron.transactionId || (bron.transaction && bron.transaction.transactionId)),
    bron: bron || undefined,
    bronError: bronError || undefined,
    guidance: bronError
      ? `Bron rejected the swap: ${bronError}. If it mentions allowance/approval, first approve ${from.symbol} to ${est.approvalAddress} (bron_tx_allowance), then retry.`
      : "Signable swap created — sign it in the Bron app to execute.",
  };
}

const swapTool = {
  name: "bron_swap",
  title: "Swap one asset for another (direct DEX via Li.Fi)",
  description:
    "Swap one asset for another. This is THE swap tool — it gets a Li.Fi DEX route and submits it as a Bron 'defi' transaction (the mechanism the Bron UI uses). SAFE TO CALL — creates a pending request only; nothing executes until the user signs in the Bron app (MPC gate). " +
    "Just give it accountId, fromAssetId, toAssetId and a human fromAmount (e.g. '20' for 20 USDT) — bronkit resolves the symbols, the vault's on-chain address, decimals, and the route itself. " +
    "PREVIEW-FIRST: call dryRun:true to fetch the Li.Fi route only (no Bron call, no request created), show the user the expected output, then dryRun:false (same externalId) to create the signable swap. " +
    "For an ERC20 source token the token must first approve the route's approvalAddress (returned in the result) — use bron_tx_allowance. EVM chains only (not Canton).",
  inputSchema: {
    type: "object",
    properties: {
      accountId: { type: "string", description: "Source vault/account id" },
      fromAssetId: { type: "string", description: "Bron asset id being sold" },
      toAssetId: { type: "string", description: "Bron asset id being bought" },
      fromAmount: { type: "string", description: "Human amount of the from-asset, e.g. '20' for 20 USDT" },
      slippage: { type: "string", description: "Slippage fraction, e.g. '0.005' = 0.5% (default 0.005)" },
      dryRun: { type: "boolean", description: "true = fetch the Li.Fi route only, no Bron call; false = create the signable swap." },
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
