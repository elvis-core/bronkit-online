// End-to-end smoke test (hermetic — no real Bron, no real keys).
//
// Boots the REAL server.js as a child process, points it at a mock Bron API,
// and drives the full connector flow for TWO users with two throwaway JWKs:
//   register (DCR) -> authorize -> paste JWK (callback) -> token -> MCP calls.
//
// Proves the Definition of Done:
//   - server runs over Streamable HTTP, reading PORT
//   - OAuth endpoints work; pasting a JWK completes the handshake; token issued
//   - a tool call resolves the right JWK, signs the Bron request, returns data
//   - two tokens use two different stored JWKs, independently (isolation)
//
// Run: node scripts/smoke.js   (exits non-zero on any failed assertion)

import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";

const ok = (c, m) => { if (!c) { console.error("✗ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✓", m); };

function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.listen(0, () => { const p = srv.address().port; srv.close(() => res(p)); });
    srv.on("error", rej);
  });
}

async function makeJwk(kid) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  jwk.kid = kid;
  return JSON.stringify(jwk);
}

function kidOf(authHeader) {
  const jwt = String(authHeader || "").replace(/^ApiKey /, "");
  try { return JSON.parse(Buffer.from(jwt.split(".")[0], "base64url")).kid; } catch { return null; }
}

// --- Mock Bron API + OAuth redirect catcher -------------------------------
let bronCalls = []; // { path, kid }
const codesByState = {};

function startMock(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, `http://localhost:${port}`);
      const p = u.pathname;
      // OAuth redirect lands here (registered redirect_uri); capture the code.
      if (p === "/cb") {
        codesByState[u.searchParams.get("state")] = u.searchParams.get("code");
        res.writeHead(200, { "content-type": "text/plain" }); return res.end("connected");
      }
      // Every Bron call is signed; record which key signed it.
      bronCalls.push({ path: p, kid: kidOf(req.headers.authorization) });
      const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (/^\/workspaces\/[^/]+$/.test(p)) return json({ workspaceId: p.split("/")[2], name: "Mock Workspace" });
      if (/^\/workspaces\/[^/]+\/accounts$/.test(p))
        return json({ accounts: [{ accountId: "acc1", accountName: "Main Vault", accountType: "vault", status: "active" }] });
      if (/^\/workspaces\/[^/]+\/balances$/.test(p))
        return json({ balances: [{ accountId: "acc1", assetId: "a-usdc", symbol: "USDC", networkId: "ETH", totalBalance: "1000", withdrawableBalance: "1000" }] });
      if (p === "/dictionary/asset-market-prices") return json({ prices: [{ baseAssetId: "a-usdc", quoteSymbolId: "s09", price: "1" }] });
      // Intents (swap) endpoints — quote first (it also matches the /:id shape).
      if (/^\/workspaces\/[^/]+\/intents\/quote$/.test(p))
        return json({ fromAssetId: "a-usdc", toAssetId: "a-eth", fromAmount: "100", toAmount: "0.03", minToAmount: "0.0299", minPrice: "0.000299", solverFeePercent: "0.1", oracleFeePercent: "0.05" });
      if (/^\/workspaces\/[^/]+\/intents$/.test(p))
        return json({ status: "user-initiated", fromAmount: "100", toAmount: "0.03" });
      if (/^\/workspaces\/[^/]+\/intents\/[^/]+$/.test(p))
        // Solver has priced it (auction-in-progress + price) → tool creates the signable tx.
        return json({ status: "auction-in-progress", fromAmount: "100", toAmount: "0.03", price: "0.0003", userSettlementDeadline: Date.now() + 120000 });
      if (/^\/workspaces\/[^/]+\/transactions$/.test(p))
        return json({ transactionId: "tx-smoke-1", status: "signing-required" });
      res.writeHead(404); res.end("{}");
    });
    srv.listen(port, () => resolve(srv));
  });
}

async function waitReady(base, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(base + "/"); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become ready");
}

const form = (o) => new URLSearchParams(o).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function rpc(base, token, id, method, params) {
  const r = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`/mcp ${method} returned non-JSON (status ${r.status}): ${text.slice(0, 200)}`); }
  return { status: r.status, body };
}

async function runUser(base, mockBase, jwk, wsId, expectKid, label) {
  console.log(`\n--- ${label} ---`);
  // 1) Dynamic Client Registration
  const reg = await (await fetch(base + "/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [`${mockBase}/cb`], client_name: "Smoke" }),
  })).json();
  ok(!!reg.client_id, "DCR issued a client_id");

  // 2) PKCE
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomUUID();

  // 3) Authorize → JWK paste page
  const authUrl = base + "/oauth/authorize?" + form({
    response_type: "code", client_id: reg.client_id, redirect_uri: `${mockBase}/cb`,
    code_challenge: challenge, code_challenge_method: "S256", state, scope: "bron",
  });
  const authResp = await fetch(authUrl);
  const authHtml = await authResp.text();
  ok(authResp.status === 200 && /name="jwk"/.test(authHtml), "authorize served the JWK-paste page");

  // 4) Callback (paste JWK) → 302 to redirect_uri, caught by the mock
  const cbResp = await fetch(base + "/oauth/callback", {
    method: "POST", headers: FORM,
    body: form({
      client_id: reg.client_id, redirect_uri: `${mockBase}/cb`, state,
      code_challenge: challenge, code_challenge_method: "S256", scope: "bron",
      jwk, workspaceId: wsId,
    }),
  });
  ok(cbResp.ok, "callback completed and followed the redirect back");
  const code = codesByState[state];
  ok(!!code, "authorization code delivered to redirect_uri");

  // 5) Token exchange (PKCE)
  const tok = await (await fetch(base + "/oauth/token", {
    method: "POST", headers: FORM,
    body: form({ grant_type: "authorization_code", code, redirect_uri: `${mockBase}/cb`, client_id: reg.client_id, code_verifier: verifier }),
  })).json();
  ok(!!tok.access_token && tok.token_type === "Bearer", "token endpoint issued a Bearer access token");

  // Wrong PKCE verifier must be rejected (re-issue a fresh code first).
  // (skipped re-mint here; covered by unit tests)

  // 6) MCP over the issued token
  const init = await rpc(base, tok.access_token, 1, "initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" },
  });
  ok(init.body.result?.serverInfo?.name === "bronkit", "MCP initialize → serverInfo.name = bronkit");
  ok(typeof init.body.result?.instructions === "string" && init.body.result.instructions.length > 100, "initialize carries the instructions block");

  const list = await rpc(base, tok.access_token, 2, "tools/list", {});
  ok(Array.isArray(list.body.result?.tools) && list.body.result.tools.length === 30, `tools/list → 30 tools (got ${list.body.result?.tools?.length})`);
  ok(list.body.result.tools.some((t) => t.name === "bron_tx_swap"), "bron_tx_swap is present");
  ok(list.body.result.tools.some((t) => t.name === "strategy_run"), "strategy tools are present");
  ok(list.body.result.tools.some((t) => t.name === "scheduler_setup_text"), "scheduler_setup_text (metronome) is present");

  bronCalls = []; // isolate this user's downstream Bron calls
  const call = await rpc(base, tok.access_token, 3, "tools/call", { name: "bron_accounts_overview", arguments: {} });
  const payloadText = call.body.result?.content?.[0]?.text || "";
  let payload = {};
  try { payload = JSON.parse(payloadText); } catch { /* leave empty */ }
  ok(Array.isArray(payload.accounts) && payload.accounts.length === 1, "tools/call bron_accounts_overview returned data through the full pipeline");
  ok(payload.accounts[0].totalUsd === 1000, "accounts_overview computed the USD total from the (mock) Bron data");

  // Isolation: every Bron request this user triggered was signed with THEIR key.
  ok(bronCalls.length > 0, "the tool call actually hit (mock) Bron");
  const kids = [...new Set(bronCalls.map((c) => c.kid))];
  ok(kids.length === 1 && kids[0] === expectKid, `all ${bronCalls.length} Bron calls signed with ${expectKid} (saw ${kids.join(",")})`);

  // Swap (intent) tool: create → bounded poll reports transitions, surfaces the
  // user-action stage + settlement deadline, all signed with this user's key.
  bronCalls = [];
  const swap = await rpc(base, tok.access_token, 4, "tools/call", { name: "bron_tx_swap", arguments: { action: "create", accountId: "acc1", fromAssetId: "a-usdc", toAssetId: "a-eth", fromAmount: "100", maxWaitSeconds: 5 } });
  let sp = {};
  try { sp = JSON.parse(swap.body.result?.content?.[0]?.text || "{}"); } catch { /* leave empty */ }
  ok(!!sp.intentId, "swap create returned an intent id");
  ok(sp.solverPriced === true, "swap detected the solver price (auction-in-progress)");
  ok(sp.signableTransactionId === "tx-smoke-1", "swap created the SIGNABLE transaction (step 3) once priced");
  ok(!!sp.userSettlementDeadline && typeof sp.userSettlementDeadline.epochMs === "number", "swap surfaced the settlement deadline");
  // The signable tx went through POST /transactions as transactionType intents.
  ok(bronCalls.some((c) => /\/transactions$/.test(c.path)), "swap hit POST /transactions for the signable tx");
  const swapKids = [...new Set(bronCalls.map((c) => c.kid))];
  ok(swapKids.length === 1 && swapKids[0] === expectKid, `swap Bron calls (incl. signable tx) signed with ${expectKid}`);

  // Strategy layer: create a dca strategy, list it, fire it → prepares a swap
  // (signable tx) through the full pipeline. Per-user (scoped to this token).
  const sc = await rpc(base, tok.access_token, 5, "tools/call", { name: "strategy_create", arguments: { type: "dca", params: { accountId: "acc1", fromAssetId: "a-usdc", toAssetId: "a-eth", amount: "10", schedule: "0 9 * * *" } } });
  const strat = JSON.parse(sc.body.result.content[0].text);
  ok(!!strat.id && strat.enabled === true && strat.trigger.kind === "schedule", "strategy_create returned an enabled dca strategy");
  const sl = await rpc(base, tok.access_token, 6, "tools/call", { name: "strategy_list", arguments: {} });
  ok(JSON.parse(sl.body.result.content[0].text).strategies.length === 1, "strategy_list shows the strategy (per-user)");
  const sf = await rpc(base, tok.access_token, 7, "tools/call", { name: "strategy_run", arguments: { strategyId: strat.id } });
  const fired = JSON.parse(sf.body.result.content[0].text);
  ok(fired.fired === true && fired.prepared?.[0]?.kind === "swap", "strategy_run prepared a swap");
  ok(fired.prepared[0].result?.signableTransactionId === "tx-smoke-1", "fired strategy created a signable tx with rationale");
  ok(/strategy/.test(fired.prepared[0].description || ""), "prepared tx carries a rationale description");

  return { token: tok.access_token };
}

// --- Drive it -------------------------------------------------------------
const mockPort = await freePort();
const srvPort = await freePort();
const mockBase = `http://localhost:${mockPort}`;
const base = `http://localhost:${srvPort}`;
const storePath = join(tmpdir(), `bronkit-smoke-${randomUUID()}.json`);

const mock = await startMock(mockPort);
const child = spawn("node", ["src/server.js"], {
  env: {
    ...process.env,
    PORT: String(srvPort),
    PUBLIC_URL: base,
    BRON_BASE_URL: mockBase,
    BRONKIT_MASTER_KEY: "smoke-master-key",
    OAUTH_SIGNING_SECRET: "smoke-signing-secret",
    STORE_PATH: storePath,
    BRONKIT_POLL_INTERVAL_MS: "0", // no real-time delays in the bounded swap poll
  },
  stdio: ["ignore", "inherit", "inherit"],
});

let failed = false;
try {
  await waitReady(base);

  // Unauthorized /mcp must challenge with WWW-Authenticate (triggers OAuth discovery).
  const noAuth = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} }) });
  ok(noAuth.status === 401 && /Bearer/.test(noAuth.headers.get("www-authenticate") || ""), "unauthenticated /mcp → 401 + WWW-Authenticate");

  // Discovery metadata present.
  const prm = await (await fetch(base + "/.well-known/oauth-protected-resource")).json();
  ok(prm.authorization_servers?.[0] === base, "protected-resource metadata advertises this auth server");
  const asm = await (await fetch(base + "/.well-known/oauth-authorization-server")).json();
  ok(asm.authorization_endpoint === base + "/oauth/authorize", "auth-server metadata exposes the authorize endpoint");

  const jwkA = await makeJwk("kid-A");
  const jwkB = await makeJwk("kid-B");
  await runUser(base, mockBase, jwkA, "ws-A", "kid-A", "User A");
  await runUser(base, mockBase, jwkB, "ws-B", "kid-B", "User B");

  console.log("\nALL SMOKE CHECKS PASSED ✅");
} catch (e) {
  failed = true;
  console.error("\nSMOKE FAILED ❌:", e.message);
} finally {
  child.kill("SIGKILL");
  mock.close();
  rmSync(storePath, { force: true });
}
process.exit(failed || process.exitCode ? 1 : 0);
