// Client-generated Bron ids (intentId, transaction externalId). Bron requires ITS
// own format — 24-char lowercase base36 — NOT a UUID. A UUID in one of these slots
// makes Bron reject the create with a generic 409 "Something went wrong":
// confirmed live for intents' intentId (15 Jul 2026), and the create-transaction
// spec for externalId is identical ("unique per account", base32 example
// w2u573pjj5wl97p4v325z4a). So both must use this.

import { randomBytes } from "node:crypto";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function bronId(len = 24) {
  const b = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += ID_ALPHABET[b[i] % ID_ALPHABET.length];
  return s;
}
