// Tests for bron_swap: resolves Bron asset/address data, fetches a Li.Fi route
// (mocked via global fetch), and submits it as a 'defi' transaction. No network.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.BRONKIT_MASTER_KEY = "test-master";
process.env.OAUTH_SIGNING_SECRET = "test-signing";

const { swapTools } = await import("../src/tools/swap.js");
const bronSwap = swapTools[0];

function mockCtx({ postResp, dict } = {}) {
  const calls = [];
  return {
    workspaceId: "ws",
    calls,
    client: {
      async get(path, query) {
        calls.push({ method: "GET", path, query });
        if (path.endsWith("/dictionary/assets")) return { assets: dict || [] };
        if (path.endsWith("/balances")) {
          return { balances: [
            { assetId: "5002", symbol: "USDT", networkId: "ETH" },
            { assetId: "2", symbol: "ETH", networkId: "ETH" },
          ] };
        }
        if (path.endsWith("/addresses")) return { addresses: [{ address: "0xVault", accountId: "acc1", networkId: "ETH" }] };
        return {};
      },
      async post(path, body) {
        calls.push({ method: "POST", path, body });
        return postResp || { transactionId: "tx-defi-1", status: "signing-required" };
      },
    },
  };
}

// Mock Li.Fi's /token and /quote via global fetch. Returns a restore fn that also
// carries `.urls` — every Li.Fi URL called, so tests can assert what was resolved.
function mockLifi() {
  const orig = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("/token")) {
      const isUsdt = u.includes("USDT");
      return { ok: true, text: async () => JSON.stringify({ address: isUsdt ? "0xUSDT" : "0x0000000000000000000000000000000000000000", decimals: isUsdt ? 6 : 18, symbol: isUsdt ? "USDT" : "ETH", chainId: 1 }) };
    }
    if (u.includes("/quote")) {
      return { ok: true, text: async () => JSON.stringify({
        tool: "1inch", toolDetails: { name: "1inch" },
        transactionRequest: { to: "0xRouter", data: "0xdeadbeef", value: "0x0", chainId: 1 },
        estimate: { fromAmount: "20000000", toAmount: "11000000000000000", approvalAddress: "0xRouter" },
      }) };
    }
    return { ok: false, status: 404, text: async () => "nope" };
  };
  const restore = () => { globalThis.fetch = orig; };
  restore.urls = urls;
  return restore;
}

test("bron_swap: resolves asset/address/route and submits a defi tx (create)", async () => {
  const restore = mockLifi();
  try {
    const ctx = mockCtx();
    const out = await bronSwap.handler(ctx, { accountId: "acc1", fromAssetId: "5002", toAssetId: "2", fromAmount: "20", dryRun: false });
    assert.equal(out.signableTransactionId, "tx-defi-1");
    assert.equal(out.swap.from, "20 USDT");
    assert.match(out.swap.toEstimated, /ETH/);
    assert.equal(out.swap.via, "1inch");
    assert.equal(out.swap.fromAddress, "0xVault");
    const post = ctx.calls.find((c) => c.method === "POST");
    assert.equal(post.path, "/workspaces/ws/transactions");
    assert.equal(post.body.transactionType, "defi");
    assert.equal(post.body.params.to, "0xRouter");
    assert.equal(post.body.params.data, "0xdeadbeef");
    assert.equal(post.body.params.networkId, "ETH");
    assert.ok(ctx.calls.some((c) => c.path.endsWith("/addresses")), "resolved the vault address");
  } finally { restore(); }
});

test("bron_swap: dryRun fetches the route only and never calls Bron", async () => {
  const restore = mockLifi();
  try {
    const ctx = mockCtx({ postResp: { estimations: [] } });
    const out = await bronSwap.handler(ctx, { accountId: "acc1", fromAssetId: "5002", toAssetId: "2", fromAmount: "20", dryRun: true });
    assert.equal(out.dryRun, true);
    assert.equal(out.swap.approvalAddress, "0xRouter");
    assert.equal(ctx.calls.find((c) => c.method === "POST"), undefined, "dryRun must not POST to Bron");
    assert.match(out.guidance, /Preview only/);
  } finally { restore(); }
});

test("bron_swap: non-EVM network is rejected clearly (no Li.Fi)", async () => {
  const restore = mockLifi();
  try {
    const ctx = mockCtx();
    ctx.client.get = async (path) => (path.endsWith("/balances") ? { balances: [{ assetId: "5", symbol: "CC", networkId: "CC" }] } : {});
    await assert.rejects(() => bronSwap.handler(ctx, { accountId: "acc1", fromAssetId: "5", toAssetId: "5", fromAmount: "1" }), /EVM/);
  } finally { restore(); }
});

test("bron_swap: P1 — resolves the route by dictionary CONTRACT address, not by symbol", async () => {
  const restore = mockLifi();
  try {
    // USDT on Arbitrum: symbol lookup 404s at Li.Fi (USDT0), but the dictionary
    // carries the contract + decimals, so we must route by address and never do a
    // by-symbol /token lookup for it.
    const dict = [
      { assetId: "5011", symbol: "USDT", networkId: "ARB", chainId: 42161, decimals: 6, contractAddress: "0xUSDT0onArb" },
      { assetId: "7", symbol: "ETH", networkId: "ARB", chainId: 42161, decimals: 18, contractAddress: null },
    ];
    const ctx = mockCtx({ dict });
    const out = await bronSwap.handler(ctx, { accountId: "acc1", fromAssetId: "5011", toAssetId: "7", fromAmount: "10", dryRun: true });
    assert.equal(out.dryRun, true);
    const quoteUrl = restore.urls.find((u) => u.includes("/quote"));
    assert.ok(quoteUrl, "a Li.Fi quote was requested");
    assert.match(quoteUrl, /fromToken=0xUSDT0onArb/); // routed by contract address
    assert.ok(!restore.urls.some((u) => u.includes("/token") && u.includes("USDT")), "never did a by-symbol USDT lookup");
    assert.ok(ctx.calls.some((c) => c.path.endsWith("/dictionary/assets")), "used the dictionary");
  } finally { restore(); }
});

test("bron_swap: EVM source into a non-EVM destination (Solana) is rejected toward intents", async () => {
  const restore = mockLifi();
  try {
    const dict = [
      { assetId: "5000", symbol: "USDC", networkId: "ETH", chainId: 1, decimals: 6, contractAddress: "0xUSDConEth" },
      { assetId: "9999", symbol: "USDC", networkId: "SOL", chainId: null, decimals: 6, contractAddress: "Es9v...SPL" },
    ];
    const ctx = mockCtx({ dict });
    await assert.rejects(
      () => bronSwap.handler(ctx, { accountId: "acc1", fromAssetId: "5000", toAssetId: "9999", fromAmount: "10", dryRun: true }),
      /intents|cross-VM|not an EVM/i
    );
  } finally { restore(); }
});
