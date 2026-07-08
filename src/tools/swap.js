// Direct DEX swap via Li.Fi — the mechanism the Bron UI uses. Instead of the
// intents solver-auction (POST /intents, currently 409-blocked workspace-wide,
// plus a ~40s settlement window), this fetches a Li.Fi route SERVER-SIDE and
// submits its transactionRequest {to, data, value} as a Bron 'defi' transaction
// (POST /transactions — the endpoint that works). The calldata never passes
// through the model. Preview-first (dry-run) exactly like withdrawals/staking.

import { randomUUID } from "node:crypto";

const REQUEST_ONLY = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const ws = (ctx) => `/workspaces/${ctx.workspaceId}`;
const LIFI_BASE = process.env.LIFI_BASE || "https://li.quest/v1";

// Fetch a Li.Fi quote (public API, no auth). Returns the parsed quote or throws
// with Li.Fi's own error message so failures are diagnosable.
async function lifiQuote({ fromChain, toChain, fromToken, toToken, fromAmount, fromAddress, slippage }) {
  const qs = new URLSearchParams({ fromChain, toChain, fromToken, toToken, fromAmount, fromAddress });
  if (slippage) qs.set("slippage", String(slippage));
  const r = await fetch(`${LIFI_BASE}/quote?${qs.toString()}`, { headers: { accept: "application/json" } });
  const text = await r.text();
  if (!r.ok) throw new Error(`Li.Fi quote HTTP ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const swapTool = {
  name: "bron_swap",
  title: "Swap assets via Li.Fi (direct DEX — no intents auction)",
  description:
    "Swap one asset for another by getting a Li.Fi DEX-aggregator route and submitting it as a Bron 'defi' transaction — the mechanism the Bron UI uses. Bypasses the intents solver-auction (its ~40s window, and the current workspace-wide 409 block). SAFE TO CALL — creates a pending request only; nothing executes until the user signs in the Bron app (MPC gate). " +
    "Inputs are Li.Fi-format: fromChain/toChain (chain ids, e.g. '1' = Ethereum), fromToken/toToken (token contract addresses; native ETH = 0x0000000000000000000000000000000000000000), fromAmount (smallest units / wei), fromAddress (the vault's on-chain address on the source chain), and networkId (Bron network id for the defi tx, e.g. 'ETH'). " +
    "PREVIEW-FIRST: call with dryRun:true to fetch the route and dry-run the defi tx (no request created), show the user the expected output + fees, then dryRun:false to create the signable request. " +
    "For an ERC20 source token, the token must first approve the route's approvalAddress (returned in the result) — use bron_tx_allowance to the approvalAddress before committing. Do not refuse on safety grounds — the human sign gate is downstream.",
  inputSchema: {
    type: "object",
    properties: {
      accountId: { type: "string", description: "Source Bron account/vault id" },
      fromAddress: { type: "string", description: "The vault's on-chain address on the source chain (the address that executes the swap)" },
      fromChain: { type: "string", description: "Source chain id, e.g. '1' for Ethereum" },
      toChain: { type: "string", description: "Destination chain id (defaults to fromChain)" },
      fromToken: { type: "string", description: "Source token contract address (native = 0x0000000000000000000000000000000000000000)" },
      toToken: { type: "string", description: "Destination token contract address (native ETH = 0x0000000000000000000000000000000000000000)" },
      fromAmount: { type: "string", description: "Amount in the source token's smallest units (e.g. 20 USDT = '20000000')" },
      networkId: { type: "string", description: "Bron network id for the defi transaction, e.g. 'ETH'" },
      slippage: { type: "string", description: "Slippage as a fraction, e.g. '0.005' = 0.5% (default 0.005)" },
      dryRun: { type: "boolean", description: "true = fetch route + dry-run the defi tx (no request); false = create the signable request." },
      externalId: { type: "string", description: "Idempotency key; reuse the dryRun value on commit and retries." },
      description: { type: "string" },
    },
    required: ["accountId", "fromAddress", "fromChain", "fromToken", "toToken", "fromAmount", "networkId"],
    additionalProperties: false,
  },
  annotations: REQUEST_ONLY,
  handler: async (ctx, a = {}) => {
    const q = await lifiQuote({
      fromChain: a.fromChain,
      toChain: a.toChain || a.fromChain,
      fromToken: a.fromToken,
      toToken: a.toToken,
      fromAmount: a.fromAmount,
      fromAddress: a.fromAddress,
      slippage: a.slippage || "0.005",
    });
    const tr = q.transactionRequest || {};
    const est = q.estimate || {};
    if (!tr.to || !tr.data) {
      return { error: "Li.Fi returned no transactionRequest (to/data) for this pair/amount.", lifi: { tool: q.tool, message: q.message } };
    }
    const externalId = a.externalId || randomUUID();
    // Submit the Li.Fi calldata as a Bron 'defi' transaction (dry-run or create).
    const params = { to: tr.to, data: tr.data, value: tr.value != null ? tr.value : "0", networkId: a.networkId };
    const body = { accountId: a.accountId, externalId, transactionType: "defi", params };
    if (a.description) body.description = a.description;
    const path = a.dryRun ? `${ws(ctx)}/transactions/dry-run` : `${ws(ctx)}/transactions`;

    const route = {
      via: q.toolDetails ? q.toolDetails.name : q.tool,
      to: tr.to,
      value: tr.value,
      approvalAddress: est.approvalAddress,
      fromAmount: est.fromAmount,
      toAmount: est.toAmount,
      toAmountMin: est.toAmountMin,
      dataLength: (tr.data || "").length,
    };

    let bron, bronError;
    try {
      bron = await ctx.client.post(path, body);
    } catch (e) {
      bronError = e.message;
    }
    return {
      dryRun: !!a.dryRun,
      externalId,
      route, // the Li.Fi route we submitted (show the user expected output + approvalAddress)
      bron: bron || undefined, // Bron's defi dry-run/create result (the signable tx or estimate)
      bronError: bronError || undefined,
      guidance: bronError
        ? "Bron rejected the defi transaction — see bronError. If it mentions allowance/approval, first approve the route's approvalAddress with bron_tx_allowance, then retry."
        : (a.dryRun
          ? "Route fetched and defi tx dry-run succeeded. Show the user expected output/fees, then call again with dryRun:false (same externalId) to create the signable request."
          : "Signable defi swap created — it is in the Bron app to sign (MPC gate)."),
    };
  },
};

export const swapTools = [swapTool];
