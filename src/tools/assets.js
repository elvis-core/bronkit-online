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
  // Confirmed live: the contract lives under contractInformation.contractAddress
  // (native coins have no contractInformation). Top-level variants kept as a
  // fallback in case the shape shifts.
  const ci = r.contractInformation && typeof r.contractInformation === "object" ? r.contractInformation : {};
  const contractAddress =
    pick("contractAddress", "contract_address", "tokenAddress", "address") || ci.contractAddress || ci.address || null;
  return {
    assetId: assetId != null ? String(assetId) : null,
    symbol: pick("symbol", "assetSymbol", "ticker"),
    name: pick("name", "assetName", "title"),
    networkId: pick("networkId", "network", "chain", "networkCode"),
    chainId: pick("chainId", "evmChainId", "networkChainId"),
    decimals: pick("decimals", "decimal", "precision"),
    contractAddress,
    standard: ci.standard || null,
    verified: r.verified != null ? r.verified : null,
  };
}

// Resolve a single asset id against the dictionary (or a pre-fetched array).
export async function resolveAssetById(client, assetId, prefetched) {
  const arr = prefetched || (await fetchDictionaryAssets(client));
  const found = arr.map(normalizeAsset).find((a) => a && String(a.assetId) === String(assetId));
  return found || null;
}

// Resolve to a concrete assetId: pass through if given, else look up symbol +
// networkId in the dictionary (preferring a verified match, since the catalog
// contains spoof tokens). Throws a clear error rather than sending assetId:null.
// Use for params where Bron REQUIRES assetId (e.g. AllowanceParams) and does not
// accept symbol+networkId itself.
export async function resolveAssetId(client, { assetId, symbol, networkId }) {
  if (assetId != null && assetId !== "") return String(assetId);
  if (!symbol || !networkId) {
    throw new Error("Identify the asset with assetId, or with both symbol and networkId.");
  }
  const dict = (await fetchDictionaryAssets(client)).map(normalizeAsset).filter(Boolean);
  const eq = (a) =>
    a.symbol && a.networkId &&
    a.symbol.toLowerCase() === String(symbol).toLowerCase() &&
    a.networkId.toLowerCase() === String(networkId).toLowerCase();
  const match = dict.find((a) => eq(a) && a.verified === true) || dict.find(eq);
  if (!match || !match.assetId) {
    throw new Error(`No asset found for ${symbol} on ${networkId}. Look it up with bron_assets_list and pass assetId.`);
  }
  return match.assetId;
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
      includeUnverified: { type: "boolean", description: "Include unverified assets (default false — the dictionary contains scam/spoof tokens; verified-only by default)" },
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
    if (!a.includeUnverified) rows = rows.filter((r) => r.verified === true);
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
