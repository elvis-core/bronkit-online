// Persistence for the OAuth provider. POC-grade: an in-memory state with
// best-effort JSON file persistence so connections survive a restart during
// mobile testing. The plaintext JWK is NEVER stored — only its ciphertext
// (see crypto.js). Everything goes through the Store interface below, so
// swapping this for Postgres/Redis later is a single-file change.
//
// State shape:
//   clients:   { [clientId]:  { client_id, redirect_uris[], client_name, created_at } }
//   users:     { [userId]:    { id, jwkCiphertext, workspaceId, created_at } }
//   authCodes: { [code]:      { userId, clientId, redirectUri, codeChallenge,
//                               codeChallengeMethod, expiresAt } }
//
// "user" here = one stored JWK identity. A connector access token maps to exactly
// one user id; resolving a token yields only that user's JWK. Users never mix.

import { randomUUID, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { storePath } from "../env.js";

function newId() {
  return randomUUID();
}

/** URL-safe opaque token (auth codes, client ids). */
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export class FileStore {
  constructor(path = storePath()) {
    this.path = path;
    this.state = { clients: {}, users: {}, authCodes: {} };
    this._load();
  }

  _load() {
    try {
      if (existsSync(this.path)) {
        const raw = JSON.parse(readFileSync(this.path, "utf8"));
        this.state = { clients: {}, users: {}, authCodes: {}, ...raw };
      }
    } catch (e) {
      // Corrupt/unreadable store → start clean rather than crash. No secret logged.
      process.stderr.write(`[store] could not load ${this.path}: ${e.message}; starting empty\n`);
    }
  }

  _save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.state), "utf8");
    } catch (e) {
      // Best-effort: in a read-only FS we keep running from memory.
      process.stderr.write(`[store] could not persist ${this.path}: ${e.message}; continuing in memory\n`);
    }
  }

  // --- OAuth clients (Dynamic Client Registration) ---
  createClient({ redirect_uris = [], client_name = "", token_endpoint_auth_method = "none" } = {}) {
    const client = {
      client_id: randomToken(16),
      redirect_uris,
      client_name,
      token_endpoint_auth_method,
      created_at: new Date().toISOString(),
    };
    this.state.clients[client.client_id] = client;
    this._save();
    return client;
  }

  getClient(clientId) {
    return this.state.clients[clientId] || null;
  }

  // --- Users (one stored, encrypted JWK each) ---
  createUser({ jwkCiphertext, workspaceId }) {
    const id = newId();
    this.state.users[id] = { id, jwkCiphertext, workspaceId, created_at: new Date().toISOString() };
    this._save();
    return id;
  }

  getUser(userId) {
    return this.state.users[userId] || null;
  }

  // --- Authorization codes (short-lived, single-use) ---
  saveAuthCode(code, data) {
    this.state.authCodes[code] = data;
    this._save();
  }

  /** Atomically read + delete a code (single-use). Returns null if absent. */
  consumeAuthCode(code) {
    const data = this.state.authCodes[code];
    if (!data) return null;
    delete this.state.authCodes[code];
    this._save();
    return data;
  }

  /** Housekeeping — drop expired auth codes. Safe to call opportunistically. */
  purgeExpired(now = Date.now()) {
    let changed = false;
    for (const [code, d] of Object.entries(this.state.authCodes)) {
      if (d.expiresAt && d.expiresAt < now) {
        delete this.state.authCodes[code];
        changed = true;
      }
    }
    if (changed) this._save();
  }
}
