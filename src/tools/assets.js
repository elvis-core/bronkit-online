// Asset catalog (dictionary) — the read surface that was missing. Sourced from
// Bron's GET /dictionary/assets (global, signed like every other call; NOT a
// held-balances view, so it can name assets the vault does not yet hold — which
// is the whole point of a swap destination). Also the source of the on-chain
// contract address + decimals that bron_swap needs to resolve a Li.Fi route by
// address instead of by symbol (symbols are not stable across chains).

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

// Pull the record array out of whatever envelope the API uses.
function pickArray(resp) {
  if (Array.isArray(resp)) return resp;
  if (!resp || typeof resp !== "object") return [];
  for (const k of ["assets", "data", "items", "records", "result"]) {
    if (Array.isArray(resp[k])) return resp[k];
  }
  for (const v of Object.values(resp)) if (Array.isArray(v)) return v;
  return [];
}

// Fetch the raw dictionary once. Exported so bron_swap reuses it.
export async function fetchDictionaryAssets(client) {
  const resp = await client.get(`/dictionary/assets`);
  return pickArray(resp);
}

// Defensive field mapping — the exact field names are confirmed on the first live
// call (bron_assets_list surfaces a raw sample). Until then we accept the common
// variants so a rename does not silently break resolution.
export function normalizeAsset(r) {
  if (!r || typeof r !== "object") return null;
  const pick = (...ks) => {
    for (const k of ks) if (r[k] != null && r[k] !== "") return r[k];
    return null;
  };
  const assetId = pick("assetId", "id", "asset_id");
  return {
    assetId: assetId != null ? String(assetId) : null,
    symbol: pick("symbol", "assetSymbol", "ticker"),
    name: pick("name", "assetName", "title"),
    networkId: pick("networkId", "network", "chain", "networkCode"),
    chainId: pick("chainId", "evmChainId", "networkChainId"),
    decimals: pick("decimals", "decimal", "precision"),
    contractAddress: pick("contractAddress", "contract_address", "tokenAddress", "address", "contract"),
  };
}

// Resolve a single asset id against the dictionary (or a pre-fetched array).
export async function resolveAssetById(client, assetId, prefetched) {
  const arr = prefetched || (await fetchDictionaryAssets(client));
  const found = arr.map(normalizeAsset).find((a) => a && String(a.assetId) === String(assetId));
  return found || null;
}

const assetsListTool = {
  name: "bron_assets_list",
  title: "List the Bron asset catalog (dictionary)",
  description:
    "List assets from Bron's global asset dictionary (GET /dictionary/assets) — every asset Bron knows, across all networks, NOT just what you hold. Read-only. " +
    "Use this to find the assetId, symbol, networkId, chain id, decimals and on-chain contract address for an asset you want to swap INTO (e.g. USDC on Solana, USDT on Arbitrum) that is not in your balances. " +
    "Filter by symbol and/or networkId to narrow it, or search by name/symbol substring. Returns normalized rows plus a raw sample of the first match so field names are always visible.",
  inputSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Exact symbol filter, e.g. USDC (case-insensitive)" },
      networkId: { type: "string", description: "Network filter, e.g. SOL, ETH, ARB (case-insensitive)" },
      assetId: { type: "string", description: "Return just this asset id" },
      search: { type: "string", description: "Substring match on symbol or name (case-insensitive)" },
      limit: { type: "integer", description: "Max rows to return (default 50)" },
    },
    additionalProperties: false,
  },
  annotations: READ_ONLY,
  handler: async (ctx, a = {}) => {
    const raw = await fetchDictionaryAssets(ctx.client);
    const all = raw.map(normalizeAsset).filter(Boolean);
    const eq = (x, y) => String(x || "").toLowerCase() === String(y || "").toLowerCase();
    const sub = (hay, needle) => String(hay || "").toLowerCase().includes(String(needle).toLowerCase());
    let rows = all;
    if (a.assetId) rows = rows.filter((r) => String(r.assetId) === String(a.assetId));
    if (a.symbol) rows = rows.filter((r) => eq(r.symbol, a.symbol));
    if (a.networkId) rows = rows.filter((r) => eq(r.networkId, a.networkId));
    if (a.search) rows = rows.filter((r) => sub(r.symbol, a.search) || sub(r.name, a.search));

    const limit = a.limit && a.limit > 0 ? a.limit : 50;
    const returned = rows.slice(0, limit);
    // Raw sample of the first match so the true dictionary field names are visible
    // (confirms whether contract address + decimals are present).
    const firstRawMatch = returned.length
      ? raw.find((r) => {
          const n = normalizeAsset(r);
          return n && n.assetId === returned[0].assetId;
        })
      : null;
    return {
      total: all.length,
      matched: rows.length,
      returned: returned.length,
      truncated: rows.length > returned.length,
      assets: returned,
      sampleRaw: firstRawMatch || undefined,
      note: rows.length > returned.length ? `Showing ${returned.length} of ${rows.length}; narrow with symbol/networkId/search or raise limit.` : undefined,
    };
  },
};

export const assetsTools = [assetsListTool];
