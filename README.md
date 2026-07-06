# Bronkit Online

A **hosted, multi-user** remote MCP server for the [Bron](https://bron.org)
treasury platform. It exposes the same Bron tools as local
[bronkit](https://github.com/elvis-core/bronkit) — balances, accounts overview,
cost basis & P&L, staking opportunities & rewards, transactions, address book,
and preview-first withdrawals — but reachable from Claude on **web, desktop, and
mobile**, with each user connecting via **their own Bron JWK**.

> **POC.** Built to test the mobile connect-and-use UX. Security is intentionally
> not production-grade; see [DEPLOY.md](DEPLOY.md#caveats--not-production).

## How it differs from local bronkit

| | Local bronkit (`.mcpb`) | Bronkit Online (this repo) |
|---|---|---|
| Transport | stdio (Claude Desktop only) | **Streamable HTTP** (web/desktop/mobile) |
| Users | one, local config | **many**, each with their own JWK |
| Credentials | JWK in OS keychain | JWK pasted once, **encrypted at rest** server-side |
| Auth to Claude | n/a (local) | **OAuth 2.0 + PKCE** (this server is the provider) |
| Tools | 22 | the same 22, behaviour unchanged |

The tool implementations (`src/tools`, `src/api`, `src/auth`, `src/util`,
`src/instructions.js`) are **ported verbatim** from bronkit 0.8.6. The only change
is how each request's JWK is supplied: instead of one key from local config, the
caller's OAuth access token resolves to that user's stored, encrypted JWK.

## Connect flow

```
Claude  ──add connector (PUBLIC_URL/mcp)──▶  this server
        ◀── 401 + metadata ── discovers OAuth ──▶
        ── authorize ──▶  JWK-paste page (hosted here)
                          user pastes Bron JWK + workspace id
        ◀── code ── encrypt + store + issue ──
        ── token ──▶  access token  ──▶  MCP tool calls
                                          token → that user's JWK → signed Bron request
```

The server never moves funds: withdrawal/staking tools only **create requests**;
final approval happens in the Bron app (biometric + MPC), exactly as in local
bronkit.

## Automatic strategies

Users can automate recurring/conditional treasury actions — DCA, idle→stake,
de-risk, price-target — set up and managed **entirely in chat** with the
`strategy_*` tools. Firing is driven by ONE recurring Cowork task (the
**metronome**) the user pastes in **once**: every hour it calls `strategy_run`
(no ids), which evaluates all their enabled strategies against live prices and
prepares any triggered transactions (each still signed in the Bron app). After
that one-time setup, adding/pausing/deleting strategies in chat changes what fires
on the next tick — no further Cowork visits. Full flow, tools, and types in
**[DEPLOY.md §7](DEPLOY.md#7-automatic-strategies-the-metronome)**.

## Layout

```
src/
  server.js          HTTP entry — Express, /mcp (Streamable HTTP), reads PORT/PUBLIC_URL
  mcp.js             builds an MCP Server bound to one user's ctx (tools + instructions)
  env.js             runtime config + key derivation from env vars
  oauth/
    router.js        discovery metadata, DCR, authorize, callback, token (PKCE)
    page.js          the mobile-first JWK-paste connect page
    tokens.js        access/refresh JWT mint+verify, PKCE check
  store/
    index.js         swappable store (encrypted JWKs, clients, auth codes)
    crypto.js        AES-256-GCM at-rest encryption (BRONKIT_MASTER_KEY)
  api/ auth/ util/ tools/ instructions.js   ← ported from bronkit 0.8.6, unchanged
test/                unit + multi-tenant isolation tests
scripts/smoke.js     hermetic end-to-end flow test (boots server vs a mock Bron)
```

## Develop

```bash
npm ci
npm test                 # unit + isolation tests
node scripts/smoke.js    # full OAuth + MCP flow against a mock Bron
```

Deploy instructions, env vars, and the claude.ai connector setup are in
**[DEPLOY.md](DEPLOY.md)**.

## Licence

MIT
