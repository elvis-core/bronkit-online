// bron_assets_list + normalizeAsset, exercised against the REAL /dictionary/assets
// record shape (contract nested under contractInformation, decimals as strings,
// a `verified` flag with scam tokens present). No network.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.BRONKIT_MASTER_KEY = "test-master";
process.env.OAUTH_SIGNING_SECRET = "test-signing";

const { assetsTools, normalizeAsset, resolveAssetId } = await import("../src/tools/assets.js");
const list = assetsTools[0];

const DICT = [
  { assetId: "5011", networkId: "ARB", symbol: "USDT", decimals: "6", verified: true, contractInformation: { contractAddress: "0xFd08", standard: "erc20" } },
  { assetId: "5012", networkId: "ARB", symbol: "USDC", decimals: "6", verified: true, contractInformation: { contractAddress: "0xaf88", standard: "erc20" } },
  { assetId: "1", networkId: "BTC", symbol: "BTC", decimals: "8", verified: true }, // native, no contract
  { assetId: "666", networkId: "ETH", symbol: "USDC", decimals: "18", verified: false, contractInformation: { contractAddress: "0xbad" } }, // spoof
];
const ctx = () => ({ client: { get: async () => ({ assets: DICT }) } });

test("normalizeAsset pulls the nested contractInformation.contractAddress", () => {
  const n = normalizeAsset(DICT[0]);
  assert.equal(n.contractAddress, "0xFd08");
  assert.equal(n.decimals, "6");
  assert.equal(n.networkId, "ARB");
  assert.equal(n.standard, "erc20");
  assert.equal(normalizeAsset(DICT[2]).contractAddress, null); // native has none
});

test("bron_assets_list filters by symbol+network and returns the contract + a raw sample", async () => {
  const out = await list.handler(ctx(), { symbol: "USDC", networkId: "ARB" });
  assert.equal(out.returned, 1);
  assert.equal(out.assets[0].assetId, "5012");
  assert.equal(out.assets[0].contractAddress, "0xaf88");
  assert.ok(out.sampleRaw && out.sampleRaw.contractInformation, "surfaces the raw record");
});

test("bron_assets_list hides unverified assets by default", async () => {
  const clean = await list.handler(ctx(), { symbol: "USDC", networkId: "ETH" });
  assert.equal(clean.returned, 0); // the spoof USDC is unverified
  const all = await list.handler(ctx(), { symbol: "USDC", networkId: "ETH", includeUnverified: true });
  assert.equal(all.returned, 1);
  assert.equal(all.assets[0].assetId, "666");
});

test("resolveAssetId: passes a given assetId through without any lookup", async () => {
  let called = false;
  const client = { get: async () => { called = true; return { assets: DICT }; } };
  assert.equal(await resolveAssetId(client, { assetId: "5012" }), "5012");
  assert.equal(called, false, "no dictionary fetch when assetId is already known");
});

test("resolveAssetId: resolves symbol+networkId to the assetId (the allowance fallback)", async () => {
  assert.equal(await resolveAssetId(ctx().client, { symbol: "USDC", networkId: "ARB" }), "5012");
});

test("resolveAssetId: prefers a verified match over a same-symbol spoof", async () => {
  const dict2 = [...DICT, { assetId: "5000", networkId: "ETH", symbol: "USDC", decimals: "6", verified: true, contractInformation: { contractAddress: "0xreal" } }];
  const client = { get: async () => ({ assets: dict2 }) };
  assert.equal(await resolveAssetId(client, { symbol: "USDC", networkId: "ETH" }), "5000"); // not the 666 spoof
});

test("resolveAssetId: throws a clear error when it cannot resolve", async () => {
  await assert.rejects(() => resolveAssetId(ctx().client, { symbol: "NOPE", networkId: "ETH" }), /bron_assets_list/);
});
