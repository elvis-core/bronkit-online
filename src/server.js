// Bronkit Online — hosted, multi-user remote MCP server.
//
// Transport: Streamable HTTP (the SDK's StreamableHTTPServerTransport) instead of
// stdio, so the server is a long-lived HTTP service reachable from Claude on web,
// desktop and mobile. Binds to the host-injected PORT.
//
// Auth: this server is its own OAuth provider (see oauth/router.js). Every /mcp
// request carries a Bearer access token that maps to one stored, encrypted JWK.
// We resolve token -> user -> decrypt JWK in memory -> build that user's client,
// then run the tool. Plaintext keys never persist and are never logged.

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { port, publicUrl, publicUrlConfigured, assertSecretsPresent } from "./env.js";
import { FileStore } from "./store/index.js";
import { decryptSecret } from "./store/crypto.js";
import { mountOAuth } from "./oauth/router.js";
import { verifyToken } from "./oauth/tokens.js";
import { buildServer } from "./mcp.js";
import { BronApiClient } from "./api/client.js";

assertSecretsPresent(); // fail fast if BRONKIT_MASTER_KEY / OAUTH_SIGNING_SECRET missing

const store = new FileStore();
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false, limit: "256kb" }));

// OAuth discovery + endpoints (well-known metadata, register, authorize, callback, token).
mountOAuth(app, store);

// --- MCP endpoint (Streamable HTTP) ---

function unauthorized(res) {
  res.set(
    "WWW-Authenticate",
    `Bearer resource_metadata="${publicUrl()}/.well-known/oauth-protected-resource"`
  );
  res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
}

// Resolve the Bearer access token to that user's request context. Returns null
// (caller sends 401) on any failure. Never logs the token or the JWK.
async function resolveCtx(req) {
  const header = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  let payload;
  try {
    payload = await verifyToken(m[1], "access");
  } catch {
    return null;
  }
  const user = store.getUser(payload.sub);
  if (!user) return null;
  let jwk;
  try {
    jwk = decryptSecret(user.jwkCiphertext);
  } catch {
    return null;
  }
  return { client: new BronApiClient({ apiKey: jwk }), workspaceId: user.workspaceId };
}

function mcpCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id");
}

app.options("/mcp", (_req, res) => { mcpCors(res); res.status(204).end(); });

app.post("/mcp", async (req, res) => {
  mcpCors(res);
  const ctx = await resolveCtx(req);
  if (!ctx) return unauthorized(res);

  // Stateless: a fresh server + transport per request, bound to this user's ctx.
  const server = buildServer(ctx);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    process.stderr.write(`[mcp] request error: ${e.message}\n`);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
});

// Streamable HTTP also defines GET (server-initiated SSE) and DELETE (session
// teardown). We run stateless, so neither is supported — advertise POST only.
const onlyPost = (_req, res) => res.status(405).set("Allow", "POST").end();
app.get("/mcp", onlyPost);
app.delete("/mcp", onlyPost);

// Liveness probe for the host.
app.get("/", (_req, res) => res.type("text").send("bronkit-online: ok"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

const PORT = port();
app.listen(PORT, () => {
  process.stderr.write(`[bronkit-online] listening on :${PORT}\n`);
  process.stderr.write(`[bronkit-online] public URL: ${publicUrl()}\n`);
  if (!publicUrlConfigured()) {
    process.stderr.write("[bronkit-online] WARNING: PUBLIC_URL not set — using localhost fallback (dev only)\n");
  }
});
