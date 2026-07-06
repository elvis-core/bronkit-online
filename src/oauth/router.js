// OAuth 2.0 provider for the connector. This server IS the authorization server
// (Bron is not an OAuth provider yet), so the authorize step does not delegate
// anywhere — it serves the JWK-paste page and, on submit, completes the handshake
// back to Claude. Endpoints implemented: discovery metadata, Dynamic Client
// Registration, authorize, callback, token (authorization_code + refresh_token),
// all PKCE-protected.

import { publicUrl } from "../env.js";
import { parseJwk } from "../auth/sign.js";
import { encryptSecret } from "../store/crypto.js";
import { randomToken } from "../store/index.js";
import { renderConnectPage } from "./page.js";
import { mintAccessToken, mintRefreshToken, verifyToken, pkceVerify } from "./tokens.js";

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

// Diagnostic log for the OAuth handshake. NEVER logs the JWK, codes, verifiers,
// or tokens — only which branch each request took, so a stuck connect is visible.
const olog = (m) => process.stderr.write(`[oauth] ${m}\n`);

function cors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version");
}

function protectedResourceMetadata() {
  const base = publicUrl();
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ["bron"],
    bearer_methods_supported: ["header"],
    resource_documentation: base,
  };
}

function authServerMetadata() {
  const base = publicUrl();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["bron"],
  };
}

function htmlError(res, status, message) {
  res.status(status).type("html").send(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<body style="font:16px -apple-system,sans-serif;background:#0f0d17;color:#ece9f5;padding:40px;max-width:520px;margin:0 auto">` +
      `<h2>Couldn't start the connection</h2><p style="color:#9a93b3">${message}</p></body>`
  );
}

export function mountOAuth(app, store) {
  // --- Discovery metadata (RFC 9728 + RFC 8414). Served at root and /mcp-suffixed
  //     paths, plus an openid alias, since clients probe several shapes. ---
  const prMeta = (_req, res) => { cors(res); res.json(protectedResourceMetadata()); };
  const asMeta = (_req, res) => { cors(res); res.json(authServerMetadata()); };

  // CORS preflight for any well-known path (prefix middleware — no wildcard
  // route token, so it works the same across Express versions).
  app.use("/.well-known", (req, res, next) => {
    if (req.method === "OPTIONS") { cors(res); return res.status(204).end(); }
    next();
  });
  app.get("/.well-known/oauth-protected-resource", prMeta);
  app.get("/.well-known/oauth-protected-resource/mcp", prMeta);
  app.get("/.well-known/oauth-authorization-server", asMeta);
  app.get("/.well-known/oauth-authorization-server/mcp", asMeta);
  app.get("/.well-known/openid-configuration", asMeta);

  // --- Dynamic Client Registration (RFC 7591). Claude registers itself here. ---
  app.post("/oauth/register", (req, res) => {
    cors(res);
    const body = req.body || {};
    const redirect_uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter(Boolean) : [];
    if (redirect_uris.length === 0) {
      return res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris required" });
    }
    const client = store.createClient({
      redirect_uris,
      client_name: typeof body.client_name === "string" ? body.client_name : "",
      token_endpoint_auth_method: "none",
    });
    olog(`register: client ${client.client_id} redirects=${redirect_uris.join(" ")}`);
    return res.status(201).json({
      client_id: client.client_id,
      client_id_issued_at: Math.floor(Date.parse(client.created_at) / 1000),
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: client.client_name,
      scope: "bron",
    });
  });

  // --- Authorize: serve the JWK-paste page (no delegation to Bron). ---
  app.get("/oauth/authorize", (req, res) => {
    const q = req.query || {};
    const client = q.client_id && store.getClient(String(q.client_id));
    if (!client) {
      olog(`authorize: unknown client_id=${q.client_id || "(none)"}`);
      return htmlError(res, 400, "Unknown or unregistered client.");
    }
    if (!q.redirect_uri || !client.redirect_uris.includes(String(q.redirect_uri))) {
      olog(`authorize: redirect_uri mismatch for client ${q.client_id}: ${q.redirect_uri || "(none)"}`);
      return htmlError(res, 400, "redirect_uri does not match a registered value for this client.");
    }
    // From here redirect_uri is trusted — protocol errors go back to the client.
    const redirectErr = (code) => {
      olog(`authorize: protocol error ${code} (client ${q.client_id})`);
      const u = new URL(String(q.redirect_uri));
      u.searchParams.set("error", code);
      if (q.state) u.searchParams.set("state", String(q.state));
      res.redirect(302, u.toString());
    };
    if (q.response_type !== "code") return redirectErr("unsupported_response_type");
    if (!q.code_challenge || q.code_challenge_method !== "S256") return redirectErr("invalid_request");

    const params = {
      client_id: String(q.client_id),
      redirect_uri: String(q.redirect_uri),
      state: q.state ? String(q.state) : "",
      code_challenge: String(q.code_challenge),
      code_challenge_method: "S256",
      scope: q.scope ? String(q.scope) : "bron",
      resource: q.resource ? String(q.resource) : "",
    };
    olog(`authorize: JWK page served (client ${params.client_id})`);
    res.type("html").send(renderConnectPage({ actionUrl: `${publicUrl()}/oauth/callback`, params }));
  });

  // --- Callback: the connect form posts here. Validate JWK, encrypt, store,
  //     mint an auth code, redirect back to Claude. ---
  app.post("/oauth/callback", (req, res) => {
    const b = req.body || {};
    const client = b.client_id && store.getClient(String(b.client_id));
    if (!client) {
      olog(`callback: unknown client_id=${b.client_id || "(none)"}`);
      return htmlError(res, 400, "Unknown client.");
    }
    if (!b.redirect_uri || !client.redirect_uris.includes(String(b.redirect_uri))) {
      olog(`callback: redirect_uri mismatch for client ${b.client_id}`);
      return htmlError(res, 400, "redirect_uri mismatch.");
    }

    const params = {
      client_id: String(b.client_id),
      redirect_uri: String(b.redirect_uri),
      state: b.state ? String(b.state) : "",
      code_challenge: String(b.code_challenge || ""),
      code_challenge_method: "S256",
      scope: b.scope ? String(b.scope) : "bron",
      resource: b.resource ? String(b.resource) : "",
    };
    const reshow = (msg) =>
      res.status(400).type("html").send(
        renderConnectPage({ actionUrl: `${publicUrl()}/oauth/callback`, params, error: msg })
      );

    // Validate the JWK without ever logging it.
    const jwkRaw = typeof b.jwk === "string" ? b.jwk.trim() : "";
    try {
      parseJwk(jwkRaw);
    } catch {
      olog("callback: JWK failed shape validation — page reshown"); // never log the key itself
      return reshow("That doesn't look like a valid Bron ES256 JWK (need kty=EC, crv=P-256, with a private 'd'). Paste the full key JSON and try again.");
    }
    const workspaceId = typeof b.workspaceId === "string" ? b.workspaceId.trim() : "";
    if (!workspaceId) {
      olog("callback: missing workspaceId — page reshown");
      return reshow("Workspace ID is required.");
    }

    const userId = store.createUser({ jwkCiphertext: encryptSecret(jwkRaw), workspaceId });
    olog(`callback: code issued (client ${params.client_id}, user ${userId})`);
    const code = randomToken(32);
    store.saveAuthCode(code, {
      userId,
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      codeChallenge: params.code_challenge,
      codeChallengeMethod: "S256",
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });

    const u = new URL(params.redirect_uri);
    u.searchParams.set("code", code);
    if (params.state) u.searchParams.set("state", params.state);
    return res.redirect(302, u.toString());
  });

  // --- Token: authorization_code (PKCE) + refresh_token. ---
  app.post("/oauth/token", async (req, res) => {
    cors(res);
    const b = req.body || {};
    const grant = b.grant_type;

    if (grant === "authorization_code") {
      const code = b.code && store.consumeAuthCode(String(b.code));
      if (!code) {
        olog(`token: code unknown-or-already-used (client ${b.client_id || "(none)"})`);
        return res.status(400).json({ error: "invalid_grant", error_description: "unknown or used code" });
      }
      if (code.expiresAt < Date.now()) {
        olog(`token: code expired (client ${b.client_id})`);
        return res.status(400).json({ error: "invalid_grant", error_description: "code expired" });
      }
      if (String(b.client_id || "") !== code.clientId) {
        olog(`token: client mismatch (got ${b.client_id || "(none)"}, code was for ${code.clientId})`);
        return res.status(400).json({ error: "invalid_grant", error_description: "client mismatch" });
      }
      if (String(b.redirect_uri || "") !== code.redirectUri) {
        olog(`token: redirect_uri mismatch (got ${b.redirect_uri || "(none)"}, code had ${code.redirectUri})`);
        return res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
      }
      if (!pkceVerify(String(b.code_verifier || ""), code.codeChallenge, code.codeChallengeMethod)) {
        olog(`token: PKCE verification failed (client ${b.client_id})`);
        return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      }
      const [access_token, refresh_token] = await Promise.all([
        mintAccessToken(code.userId),
        mintRefreshToken(code.userId),
      ]);
      olog(`token: authorization_code ok (user ${code.userId})`);
      return res.json({ access_token, token_type: "Bearer", expires_in: 3600, refresh_token, scope: "bron" });
    }

    if (grant === "refresh_token") {
      let payload;
      try {
        payload = await verifyToken(String(b.refresh_token || ""), "refresh");
      } catch (e) {
        olog(`token: refresh rejected (${e.message})`);
        return res.status(400).json({ error: "invalid_grant", error_description: "invalid refresh token" });
      }
      const [access_token, refresh_token] = await Promise.all([
        mintAccessToken(payload.sub),
        mintRefreshToken(payload.sub),
      ]);
      olog(`token: refresh ok (user ${payload.sub})`);
      return res.json({ access_token, token_type: "Bearer", expires_in: 3600, refresh_token, scope: "bron" });
    }

    olog(`token: unsupported grant_type=${grant || "(none)"}`);
    return res.status(400).json({ error: "unsupported_grant_type" });
  });
}
