// Dust filtering for balance rows. Reused logic: a balance is "dust" if it has
// no USD value (unpriced spam token) or its USD value is below the threshold.

import { getPreference } from "./preferences.js";

/**
 * Read the effective dust threshold (USD): bundled default (config/defaults.json)
 * overlaid by the user's ~/.bron/preferences.json. Falls back to 1 if missing or
 * non-numeric.
 */
export function readDustThreshold() {
  const v = getPreference("dustThreshold");
  return typeof v === "number" && Number.isFinite(v) ? v : 1;
}

/** Keep a balance row only if it carries a USD value at/above the threshold. */
export function keepBalance(row, dust) {
  const v = row && row._embedded ? row._embedded.usdValue : undefined;
  if (v === null || v === undefined) return false; // unpriced spam -> drop
  const n = Number(v);
  if (!Number.isFinite(n)) return true; // present but unparseable -> keep
  return n >= dust;
}
