// At-rest encryption for stored secrets (each user's Bron JWK). AES-256-GCM
// with the master key derived from BRONKIT_MASTER_KEY. The plaintext JWK is only
// ever held in memory for the duration of a single signed Bron request; on disk
// and in the store it exists only as ciphertext. Never log either side.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { masterKey } from "../env.js";

// Serialised form: base64(iv) . base64(authTag) . base64(ciphertext)
const SEP = ".";

/** Encrypt a UTF-8 string. Returns an opaque token safe to persist. */
export function encryptSecret(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(SEP);
}

/** Decrypt a token produced by encryptSecret. Throws if tampered or wrong key. */
export function decryptSecret(blob) {
  const [ivB, tagB, ctB] = String(blob).split(SEP);
  if (!ivB || !tagB || !ctB) throw new Error("malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString("utf8");
}
