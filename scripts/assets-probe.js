// Read-only probe for the Bron asset catalog — run with your own JWK to reveal
// what /assets actually returns BEFORE we build bron_assets_list + address-based
// Li.Fi resolution on it (the probe-first rule). GET only: no order, no funds.
//
//   BRON_API_KEY='<your JWK JSON>' BRON_WORKSPACE_ID='<ws>' \
//   node scripts/assets-probe.js
//
// Prints: which endpoint path works, the record count, the field names on a
// record, and the full records for USDT/USDC on Arbitrum (the P1 USDT0 case) so
// we can see whether contractAddress + decimals + chainId are present.

import { BronApiClient } from "../src/api/client.js";

const apiKey = process.env.BRON_API_KEY;
const workspaceId = process.env.BRON_WORKSPACE_ID;
if (!apiKey || !workspaceId) {
  console.error("Set BRON_API_KEY (your JWK JSON) and BRON_WORKSPACE_ID.");
  process.exit(1);
}

const client = new BronApiClient({ apiKey });

// Pull the array out of whatever envelope the API uses.
function pickArray(resp) {
  if (Array.isArray(resp)) return resp;
  if (!resp || typeof resp !== "object") return null;
  for (const k of ["assets", "data", "items", "records", "result"]) {
    if (Array.isArray(resp[k])) return resp[k];
  }
  // fall back: first array-valued property
  for (const v of Object.values(resp)) if (Array.isArray(v)) return v;
  return null;
}

// Candidate list endpoints, confirmed path first.
const LIST_PATHS = [
  `/dictionary/assets`,
  `/dictionary/assets?limit=1000`,
  `/workspaces/${workspaceId}/assets`,
];

let rows = null;
let goodPath = null;
for (const path of LIST_PATHS) {
  try {
    const [p, q] = path.split("?");
    const query = q ? Object.fromEntries(new URLSearchParams(q)) : undefined;
    const resp = await client.get(p, query);
    const arr = pickArray(resp);
    console.log(`GET ${path} -> 200, array? ${arr ? `yes (${arr.length})` : "no"}${arr ? "" : ` keys=${Object.keys(resp || {}).join(",")}`}`);
    if (arr && arr.length) { rows = arr; goodPath = path; break; }
  } catch (e) {
    console.log(`GET ${path} -> ${e.status || "ERR"} ${String(e.message).slice(0, 120)}`);
  }
}

if (!rows) {
  console.error("\nNo asset-list endpoint returned records. Report the lines above.");
  process.exit(1);
}

console.log(`\n=== Catalog found at: ${goodPath} (${rows.length} records) ===`);
console.log("Field names on record[0]:", Object.keys(rows[0]).join(", "));
console.log("\nrecord[0] (full):");
console.log(JSON.stringify(rows[0], null, 2));

// The P1 case: USDT / USDC on Arbitrum. Match loosely across likely field names.
const sym = (r) => r.symbol || r.assetSymbol || r.ticker || "";
const net = (r) => r.networkId || r.network || r.chain || r.chainId || "";
const hits = rows.filter(
  (r) => /^(USDT|USDC)$/i.test(String(sym(r))) && /ARB|42161|arbitrum/i.test(String(net(r)))
);
console.log(`\n=== USDT/USDC on Arbitrum matches: ${hits.length} ===`);
for (const h of hits) console.log(JSON.stringify(h, null, 2));

// Field-presence summary across the catalog: does it carry a contract + decimals?
const has = (k) => rows.some((r) => r[k] != null);
console.log("\n=== Field presence across catalog ===");
for (const k of ["assetId", "id", "symbol", "networkId", "network", "chainId", "decimals", "contractAddress", "contract_address", "address", "tokenAddress"]) {
  console.log(`  ${k}: ${has(k) ? "present" : "absent"}`);
}
