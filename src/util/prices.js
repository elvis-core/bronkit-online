// USD price enrichment for balances — faithful port of bron-cli's
// `--embed prices` (cmd/bron/balances_prices.go).
//
// The /balances endpoint has NO price parameter. Prices come from a separate
// call to /dictionary/asset-market-prices (keyed by assetId), merged into each
// balance under `_embedded` as { usdPrice, usdQuoteSymbolId, usdValue }, where
// usdValue = totalBalance × price (precise decimal multiply).

/**
 * Fetch a USD price map for the given asset ids from /dictionary/asset-market-prices.
 * Prefers the USD-quoted price (quoteSymbolId "s09") when an asset has multiple
 * quotes — the docs warn the quote currency varies per row — falling back to a
 * non-USD quote rather than dropping (matches the CLI; avoids an empty result).
 * @returns {Promise<Map<string,{price:string,quoteSymbolId:string}>>}
 */
export async function fetchUsdPriceMap(client, assetIds) {
  const map = new Map();
  const ids = [...new Set((assetIds || []).filter(Boolean))];
  if (ids.length === 0) return map;

  let resp;
  try {
    resp = await client.get("/dictionary/asset-market-prices", { baseAssetIds: ids.join(",") });
  } catch {
    return map; // prices unavailable
  }

  const USD_SYMBOL = "s09";
  for (const p of (resp && resp.prices) || []) {
    const id = p && p.baseAssetId;
    const price = numStr(p && p.price);
    if (!id || !price) continue;
    const prev = map.get(id);
    if (prev && prev.quoteSymbolId === USD_SYMBOL && p.quoteSymbolId !== USD_SYMBOL) continue;
    map.set(id, { price, quoteSymbolId: p.quoteSymbolId });
  }
  return map;
}

/**
 * Mutates `data.balances[*]._embedded` with USD price + value in place.
 * @returns {Promise<{priced:number}>} how many rows got a usdValue.
 */
export async function attachUsdPrices(client, data) {
  const rows = data && Array.isArray(data.balances) ? data.balances : [];
  if (rows.length === 0) return { priced: 0 };
  const byAsset = await fetchUsdPriceMap(client, rows.map((b) => b && b.assetId));

  let priced = 0;
  for (const b of rows) {
    const p = b && byAsset.get(b.assetId);
    if (!p) continue;
    const emb = b._embedded || (b._embedded = {});
    emb.usdPrice = p.price;
    if (p.quoteSymbolId) emb.usdQuoteSymbolId = p.quoteSymbolId;
    const total = numStr(b.totalBalance);
    const usd = total && mulDecimal(total, p.price);
    if (usd) {
      emb.usdValue = usd;
      priced++;
    }
  }
  return { priced };
}

function numStr(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

// Precise decimal multiply (mirrors Go's big.Rat path): no float error, capped
// at 18 fractional digits, trailing zeros trimmed. Returns "" on parse failure.
export function mulDecimal(a, b) {
  const pa = parseDec(a);
  const pb = parseDec(b);
  if (!pa || !pb) return "";
  return formatDec(pa.mant * pb.mant, pa.scale + pb.scale);
}

function parseDec(s) {
  s = String(s).trim();
  if (!/^-?(\d+(\.\d+)?|\.\d+)$/.test(s)) return null;
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  const [int = "0", frac = ""] = s.split(".");
  const mant = BigInt((int || "0") + frac);
  return { mant: neg ? -mant : mant, scale: frac.length };
}

function formatDec(mant, scale) {
  const MAX = 18;
  if (scale > MAX) {
    mant /= 10n ** BigInt(scale - MAX); // truncate toward zero
    scale = MAX;
  }
  const neg = mant < 0n;
  let m = (neg ? -mant : mant).toString();
  if (scale === 0) return (neg ? "-" : "") + m;
  while (m.length <= scale) m = "0" + m;
  const int = m.slice(0, m.length - scale);
  const frac = m.slice(m.length - scale).replace(/0+$/, "");
  return (neg ? "-" : "") + int + (frac ? "." + frac : "");
}
