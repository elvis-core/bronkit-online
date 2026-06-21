// Runtime configuration — everything comes from environment variables the host
// injects. Nothing here is hardcoded to a deployment, and no secret is ever
// logged. Keys are derived lazily so tests can set process.env before first use.

import { createHash } from "node:crypto";

function required(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing required env var: ${name}`);
  return String(v);
}

/** Port the host tells us to bind to. Falls back to 3000 for local dev only. */
export function port() {
  return parseInt(process.env.PORT || "3000", 10);
}

/**
 * Public https base URL of this service (no trailing slash). Used to build the
 * OAuth redirect (PUBLIC_URL + /oauth/callback) and all metadata URLs. Read at
 * runtime — never baked in. For local dev it defaults to http://localhost:<port>.
 */
export function publicUrl() {
  const u = (process.env.PUBLIC_URL || `http://localhost:${port()}`).trim();
  // Strip trailing slashes/dots — a stray FQDN dot or paste artifact would
  // otherwise leak into every metadata URL and break Claude's URL matching.
  return u.replace(/[/.]+$/, "");
}

/** True once PUBLIC_URL is explicitly configured (i.e. after the first deploy). */
export function publicUrlConfigured() {
  return !!(process.env.PUBLIC_URL && process.env.PUBLIC_URL.trim());
}

let _master;
let _signing;

/** 32-byte key for AES-256-GCM at-rest encryption of stored JWKs. */
export function masterKey() {
  if (!_master) _master = createHash("sha256").update(required("BRONKIT_MASTER_KEY"), "utf8").digest();
  return _master;
}

/** 32-byte key for HS256 signing of access / refresh tokens. */
export function signingKey() {
  if (!_signing) _signing = createHash("sha256").update(required("OAUTH_SIGNING_SECRET"), "utf8").digest();
  return _signing;
}

/** Where the encrypted store persists. Default ./data/store.json (gitignored). */
export function storePath() {
  return process.env.STORE_PATH || "./data/store.json";
}

/** Fail fast at boot if a required secret is missing — clearer than a later 500. */
export function assertSecretsPresent() {
  masterKey();
  signingKey();
}
