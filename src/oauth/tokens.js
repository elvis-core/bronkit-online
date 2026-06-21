// Access / refresh token minting + verification, and PKCE checking. Tokens are
// stateless signed JWTs (HS256 with the key derived from OAUTH_SIGNING_SECRET):
// the payload's `sub` is the store user id whose JWK the token unlocks. We never
// put the JWK (or any secret) inside the token.

import { createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { signingKey, publicUrl } from "../env.js";

const ACCESS_TTL = "1h";
const REFRESH_TTL = "30d";

async function mint(sub, typ, ttl) {
  return new SignJWT({ typ })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(publicUrl())
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(signingKey());
}

export function mintAccessToken(userId) {
  return mint(userId, "access", ACCESS_TTL);
}

export function mintRefreshToken(userId) {
  return mint(userId, "refresh", REFRESH_TTL);
}

/** Verify a token and assert its type. Returns the payload or throws. */
export async function verifyToken(token, expectedTyp) {
  const { payload } = await jwtVerify(token, signingKey(), { issuer: publicUrl() });
  if (expectedTyp && payload.typ !== expectedTyp) throw new Error("wrong token type");
  if (!payload.sub) throw new Error("token missing subject");
  return payload;
}

/**
 * PKCE verification. S256: BASE64URL(SHA256(verifier)) === challenge.
 * `plain` is accepted only as a fallback; Claude always uses S256.
 */
export function pkceVerify(verifier, challenge, method = "S256") {
  if (!verifier || !challenge) return false;
  if (method === "plain") return verifier === challenge;
  const hashed = createHash("sha256").update(verifier).digest("base64url");
  return hashed === challenge;
}
