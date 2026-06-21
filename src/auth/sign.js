// Bronkit request signing — a faithful port of Bron's MIT-licensed Go SDK
// (bronlabs/bron-sdk-go: sdk/auth/auth.go + sdk/http/client.go).
//
// Scheme: ES256 (P-256) JWT, regenerated per request.
//   message = `${iat}\n${UPPER(METHOD)}\n${pathWithQuery}\n${body}`
//   hashHex = sha256(message) as lowercase hex
//   JWT     = { header:{alg:"ES256", kid}, payload:{iat, message:hashHex} }
//   header  → Authorization: ApiKey <jwt>
//
// The body is included RAW in the hashed message (it is NOT pre-hashed).
//
// Correctness rule (mirrors the Go client): sign the EXACT path+query and body
// bytes that are transmitted. The server reconstructs the message from what it
// receives, so we only need self-consistency with what we send — NOT
// byte-identical JSON-key or query ordering with Go.

import { createHash } from "node:crypto";
import { SignJWT, importJWK } from "jose";

/** Parse + validate a Bron EC P-256 private JWK (string or object). */
export function parseJwk(jwk) {
  const obj = typeof jwk === "string" ? safeParse(jwk) : jwk;
  if (!obj || typeof obj !== "object") throw new Error("invalid JWK");
  if (obj.kty !== "EC" || obj.crv !== "P-256") {
    throw new Error("unsupported JWK: need kty=EC, crv=P-256");
  }
  if (!obj.d) throw new Error("JWK missing private component 'd'");
  return obj;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new Error(`failed to parse JWK: ${e.message}`);
  }
}

/** The exact 4-line message that gets SHA-256'd (see auth.go GenerateBronJwt). */
export function canonicalMessage({ iat, method, pathWithQuery, body = "" }) {
  return `${iat}\n${String(method).toUpperCase()}\n${pathWithQuery}\n${body}`;
}

/**
 * Generate the per-request Bron JWT.
 * @param {{ method:string, pathWithQuery:string, body?:string, jwk:(string|object), iat?:number }} opts
 * @returns {Promise<string>} signed compact JWT
 */
export async function generateBronJwt({ method, pathWithQuery, body = "", jwk, iat }) {
  const parsed = parseJwk(jwk);
  const issuedAt = Number.isInteger(iat) ? iat : Math.floor(Date.now() / 1000);
  const message = canonicalMessage({ iat: issuedAt, method, pathWithQuery, body });
  const hashHex = createHash("sha256").update(message, "utf8").digest("hex");

  const key = await importJWK(parsed, "ES256");
  return new SignJWT({ iat: issuedAt, message: hashHex })
    .setProtectedHeader({ alg: "ES256", kid: parsed.kid })
    .sign(key);
}

/** Full `Authorization` header value: `ApiKey <jwt>`. */
export async function authHeader(opts) {
  return "ApiKey " + (await generateBronJwt(opts));
}
