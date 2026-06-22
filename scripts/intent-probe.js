// Read-mostly probe for the Intents API contract — run against a REAL Bron
// workspace with your own JWK to confirm the swap tool matches the live API
// before trusting/deploying it (the probe-first rule).
//
// SAFE BY DEFAULT: with no flags it only requests an indicative quote
// (POST /intents/quote) — no order is created, no funds move.
//
//   BRON_API_KEY='<your JWK JSON>' BRON_WORKSPACE_ID='<ws>' \
//   node scripts/intent-probe.js --from <fromAssetId> --to <toAssetId> --fromAmount 1
//
// OPT-IN, creates a REAL intent (you must then sign in the Bron app for funds to
// move; before that you can let it lapse/cancel): add --create and an --account.
// Only run this knowingly on a small test swap.
//
//   ... --from <a> --to <b> --fromAmount 1 --account <accountId> --create
//
// Prints the raw API responses and the swap tool's own output so you can compare.

import { BronApiClient } from "../src/api/client.js";
import { swapTool } from "../src/tools/intents.js";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const apiKey = process.env.BRON_API_KEY;
const workspaceId = process.env.BRON_WORKSPACE_ID;
if (!apiKey || !workspaceId) {
  console.error("Set BRON_API_KEY (your JWK JSON) and BRON_WORKSPACE_ID.");
  process.exit(1);
}

const fromAssetId = arg("from");
const toAssetId = arg("to");
const fromAmount = arg("fromAmount");
const toAmount = arg("toAmount");
const accountId = arg("account");
const doCreate = arg("create", false);

if (!fromAssetId || !toAssetId || (!fromAmount && !toAmount)) {
  console.error("Required: --from <assetId> --to <assetId> and one of --fromAmount / --toAmount");
  process.exit(1);
}

const ctx = { client: new BronApiClient({ apiKey }), workspaceId };
const amountArgs = {};
if (fromAmount) amountArgs.fromAmount = String(fromAmount);
if (toAmount) amountArgs.toAmount = String(toAmount);

try {
  console.log("=== 1) Indicative quote (no order created) ===");
  const quote = await swapTool.handler(ctx, { action: "quote", fromAssetId, toAssetId, ...amountArgs });
  console.log(JSON.stringify(quote, null, 2));

  if (!doCreate) {
    console.log("\nQuote-only probe done. Re-run with --create --account <id> to place a real intent.");
    process.exit(0);
  }
  if (!accountId) {
    console.error("\n--create requires --account <accountId>.");
    process.exit(1);
  }

  console.log("\n=== 2) Create intent + bounded poll (REAL — sign in the Bron app for funds to move) ===");
  const created = await swapTool.handler(ctx, { action: "create", accountId, fromAssetId, toAssetId, ...amountArgs, maxWaitSeconds: 30 });
  console.log(JSON.stringify(created, null, 2));

  console.log("\n=== 3) Re-check status ===");
  const status = await swapTool.handler(ctx, { action: "status", intentId: created.intentId, maxWaitSeconds: 15 });
  console.log(JSON.stringify(status, null, 2));
} catch (e) {
  console.error("Probe failed:", e.message);
  process.exit(1);
}
