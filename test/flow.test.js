// Unit / integration tests for the multi-tenant layer. No network, no server
// listener — these exercise crypto, the store, token signing, PKCE, and the
// core guarantee: a token resolves to exactly one user's JWK, and that JWK is
// the one that signs the Bron request. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";

// Env must be set before the lazily-initialised key derivations run.
process.env.BRONKIT_MASTER_KEY = "test-master-key-do-not-use-in-prod";
process.env.OAUTH_SIGNING_SECRET = "test-signing-secret-do-not-use";
process.env.PUBLIC_URL = "http://localhost:3000";
process.env.STORE_PATH = join(tmpdir(), `bronkit-store-${randomUUID()}.json`);

const { encryptSecret, decryptSecret } = await import("../src/store/crypto.js");
const { FileStore } = await import("../src/store/index.js");
const { mintAccessToken, mintRefreshToken, verifyToken, pkceVerify } = await import("../src/oauth/tokens.js");
const { BronApiClient } = await import("../src/api/client.js");

async function makeJwk(kid) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  jwk.kid = kid;
  return JSON.stringify(jwk);
}

test("crypto: round-trips and is tamper-evident", () => {
  const secret = '{"kty":"EC","crv":"P-256","d":"abc","x":"y","y":"z","kid":"k1"}';
  const blob = encryptSecret(secret);
  assert.notEqual(blob, secret);
  assert.ok(!blob.includes("abc"), "ciphertext must not leak plaintext");
  assert.equal(decryptSecret(blob), secret);

  const [iv, tag, ct] = blob.split(".");
  const tampered = [iv, tag, Buffer.from("garbage").toString("base64")].join(".");
  assert.throws(() => decryptSecret(tampered), "tampered ciphertext must fail to decrypt");
});

test("store: persists and reloads encrypted users + clients", () => {
  const path = join(tmpdir(), `bronkit-store-${randomUUID()}.json`);
  try {
    const s1 = new FileStore(path);
    const client = s1.createClient({ redirect_uris: ["https://claude.ai/cb"], client_name: "Claude" });
    const uid = s1.createUser({ jwkCiphertext: encryptSecret("secret-jwk"), workspaceId: "ws-1" });

    const s2 = new FileStore(path); // reload from disk
    assert.equal(s2.getClient(client.client_id).client_name, "Claude");
    const u = s2.getUser(uid);
    assert.equal(u.workspaceId, "ws-1");
    assert.equal(decryptSecret(u.jwkCiphertext), "secret-jwk");
  } finally {
    rmSync(path, { force: true });
  }
});

test("store: auth codes are single-use", () => {
  const path = join(tmpdir(), `bronkit-store-${randomUUID()}.json`);
  try {
    const s = new FileStore(path);
    s.saveAuthCode("code123", { userId: "u1", expiresAt: Date.now() + 60000 });
    assert.equal(s.consumeAuthCode("code123").userId, "u1");
    assert.equal(s.consumeAuthCode("code123"), null, "second consume must return null");
  } finally {
    rmSync(path, { force: true });
  }
});

test("tokens: access/refresh sign + verify, type is enforced", async () => {
  const access = await mintAccessToken("user-A");
  const refresh = await mintRefreshToken("user-A");
  assert.equal((await verifyToken(access, "access")).sub, "user-A");
  assert.equal((await verifyToken(refresh, "refresh")).sub, "user-A");
  await assert.rejects(() => verifyToken(access, "refresh"), "access token must not pass as refresh");
  await assert.rejects(() => verifyToken("not.a.jwt", "access"));
});

test("pkce: S256 accepts the right verifier, rejects wrong", () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(pkceVerify(verifier, challenge, "S256"), true);
  assert.equal(pkceVerify("wrong-verifier", challenge, "S256"), false);
  assert.equal(pkceVerify("", challenge, "S256"), false);
});

test("multi-tenant: each token resolves ONLY its own JWK, which signs the request", async () => {
  const path = join(tmpdir(), `bronkit-store-${randomUUID()}.json`);
  try {
    const store = new FileStore(path);
    const jwkA = await makeJwk("kid-A");
    const jwkB = await makeJwk("kid-B");
    const uA = store.createUser({ jwkCiphertext: encryptSecret(jwkA), workspaceId: "ws-A" });
    const uB = store.createUser({ jwkCiphertext: encryptSecret(jwkB), workspaceId: "ws-B" });
    const tokenA = await mintAccessToken(uA);
    const tokenB = await mintAccessToken(uB);

    // Mirror the server's resolveCtx: token -> user -> decrypt -> client.
    async function resolve(token) {
      const payload = await verifyToken(token, "access");
      const user = store.getUser(payload.sub);
      return { jwk: decryptSecret(user.jwkCiphertext), workspaceId: user.workspaceId };
    }

    const rA = await resolve(tokenA);
    const rB = await resolve(tokenB);
    assert.equal(JSON.parse(rA.jwk).kid, "kid-A");
    assert.equal(rA.workspaceId, "ws-A");
    assert.equal(JSON.parse(rB.jwk).kid, "kid-B");
    assert.equal(rB.workspaceId, "ws-B");

    // And the resolved JWK is the one that actually signs the Bron request.
    async function signingKid(jwk, wsId) {
      let captured;
      const mockFetch = async (_url, init) => {
        captured = init.headers.Authorization;
        return { status: 200, text: async () => "{}", headers: { get: () => null } };
      };
      const client = new BronApiClient({ apiKey: jwk, fetchImpl: mockFetch });
      await client.get(`/workspaces/${wsId}`);
      const jwt = captured.replace(/^ApiKey /, "");
      return JSON.parse(Buffer.from(jwt.split(".")[0], "base64url")).kid;
    }

    assert.equal(await signingKid(rA.jwk, rA.workspaceId), "kid-A");
    assert.equal(await signingKid(rB.jwk, rB.workspaceId), "kid-B");
  } finally {
    rmSync(path, { force: true });
  }
});
