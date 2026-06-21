# Deploying Bronkit Online

A hosted, multi-user remote MCP server for Bron. Each user connects with their
own Bron ES256 JWK; no user ever touches the hosting platform. This is a **POC**
to test the mobile connect-and-use UX — security is intentionally not
production-grade (see [Caveats](#caveats--not-production)).

---

## 1. Environment variables

The host injects these at runtime. **Never commit any of them. Nothing here is
hardcoded in the image — all are read at runtime.**

| Variable | Required | What it is |
|---|---|---|
| `PORT` | injected by host | TCP port to bind. The app reads it at startup; do not hardcode. Falls back to `3000` only for local dev. |
| `PUBLIC_URL` | yes (after first deploy) | The public **https** base URL of this service, no trailing slash, e.g. `https://bronkit-online.example.app`. Used to build the OAuth redirect (`PUBLIC_URL + /oauth/callback`) and every discovery-metadata URL. **You usually don't know this until the first deploy issues a domain — see step 2.** |
| `BRONKIT_MASTER_KEY` | yes | Secret used to encrypt each stored JWK at rest (AES-256-GCM). Any high-entropy string; it is hashed to a 32-byte key. Rotating it makes existing stored JWKs undecryptable (users re-connect). |
| `OAUTH_SIGNING_SECRET` | yes | Secret used to sign/verify the connector's access & refresh tokens (HS256). Any high-entropy string. Rotating it invalidates outstanding tokens (users re-auth). |
| `STORE_PATH` | no | Where the encrypted store persists. Default `./data/store.json`. Point at a mounted volume to survive redeploys. |
| `BRON_BASE_URL` | no | Override the Bron API base (default `https://api.bron.org`). Only for testing against a mock. |

Generate the two secrets with, e.g.:

```bash
openssl rand -base64 48   # use one value for BRONKIT_MASTER_KEY, another for OAUTH_SIGNING_SECRET
```

---

## 2. Deploy order (the PUBLIC_URL chicken-and-egg)

`PUBLIC_URL` must equal the domain the host gives you, but you don't have that
domain until the first deploy. So:

1. **First deploy** with `BRONKIT_MASTER_KEY` and `OAUTH_SIGNING_SECRET` set
   (you can leave `PUBLIC_URL` unset for this pass). The host builds from the
   `Dockerfile`, injects `PORT`, and issues a domain.
2. **Set `PUBLIC_URL`** to that issued domain (e.g. `https://<your-domain>`).
3. **Redeploy.** Now the OAuth metadata and the redirect URL are correct.

The server logs a warning on boot if `PUBLIC_URL` is unset so you can tell which
pass you're on.

---

## 3. Register the connector on claude.ai

Add a **custom connector** and give it this URL (the MCP endpoint):

```
<PUBLIC_URL>/mcp
```

That's the only URL you enter. Claude discovers everything else automatically:
it gets a `401` from `/mcp`, reads the protected-resource metadata at
`<PUBLIC_URL>/.well-known/oauth-protected-resource`, follows it to the
authorization-server metadata, dynamically registers itself, and starts the
OAuth flow.

---

## 4. The connect flow a new user follows

1. **Add the connector** (`<PUBLIC_URL>/mcp`) in Claude (web, desktop, or mobile).
2. Claude opens the **authorize page** this server hosts.
3. The user **pastes their Bron API key (JWK JSON)** and their **workspace ID**, then taps **Connect**.
   - The JWK is validated, encrypted at rest, and mapped to a freshly issued access token.
   - *(Why a workspace ID too: the Bron API is workspace-scoped and the ported
     toolset has no "list my workspaces" call, so the page collects it. The JWK
     is the secret; the workspace ID is non-secret routing.)*
4. Claude completes the handshake and receives the access token.
5. The user can now use all Bron tools (balances, accounts overview, cost basis,
   staking, preview-first withdrawals, …). Each tool call carries that user's
   token; the server resolves it to that user's JWK, signs the Bron request, and
   discards the plaintext. **Calls from different users never mix keys.**

---

## 5. Run locally

```bash
npm ci
PORT=8080 \
PUBLIC_URL=http://localhost:8080 \
BRONKIT_MASTER_KEY=dev-master \
OAUTH_SIGNING_SECRET=dev-signing \
npm start
```

Then exercise the whole flow hermetically (boots the server against a mock Bron,
runs two users, checks isolation):

```bash
node scripts/smoke.js
```

Unit tests (crypto, store, tokens, PKCE, multi-tenant resolution):

```bash
npm test
```

---

## 6. Build the container

```bash
docker build -t bronkit-online .
docker run -p 8080:8080 \
  -e PORT=8080 \
  -e PUBLIC_URL=http://localhost:8080 \
  -e BRONKIT_MASTER_KEY=dev-master \
  -e OAUTH_SIGNING_SECRET=dev-signing \
  bronkit-online
```

For persistence across restarts, mount a volume and set `STORE_PATH` to it:

```bash
docker run ... -v bronkit-data:/app/data -e STORE_PATH=/app/data/store.json bronkit-online
```

---

## Caveats — not production

This is a POC for UX testing. Before real use, a dev team should harden:

- **Storage:** the encrypted store is a JSON file (or in-memory). Swap `FileStore`
  in `src/store/index.js` for a real database — the interface is small and
  isolated for exactly this.
- **Token lifecycle:** refresh tokens are stateless JWTs and cannot be revoked
  individually; there is no per-user logout/rotation.
- **Preferences:** the `bron_preferences` tool writes a single shared
  `~/.bron/preferences.json` (ported behaviour). In multi-tenant hosting this
  dust-threshold setting is shared across users — fine for a POC, fix before prod.
- **Secrets:** master-key rotation has no re-encryption migration.
- **Out of scope (by design):** replacing the JWK-paste page with a real Bron
  login (once Bron is an identity provider), and the intent/swap tool.
