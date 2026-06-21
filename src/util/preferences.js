// Preferences resolution. Two layers:
//   1. Bundled defaults — config/defaults.json, shipped inside the .mcpb (the
//      canonical defaults, read-only at runtime).
//   2. User overrides — ~/.bron/preferences.json (shared with the old bron CLI),
//      written by the bron_preferences tool. Only keys the user sets appear here.
// The effective config is { ...defaults, ...user }: a user value overrides the
// shipped default; anything the user hasn't set falls back to the default.
//
// USER_PATH can be redirected with BRON_PREFS_PATH (used by tests so they never
// touch the real home directory).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULTS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "defaults.json");

// Last-resort fallback if the bundled defaults file is missing/corrupt — the
// server must never crash just because config/defaults.json couldn't be read.
const HARDCODED_DEFAULTS = { dustThreshold: 1 };

export function userPrefsPath() {
  return process.env.BRON_PREFS_PATH || join(homedir(), ".bron", "preferences.json");
}

function readJson(path) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    /* fall through */
  }
  return null;
}

export function loadDefaults() {
  return readJson(DEFAULTS_PATH) || { ...HARDCODED_DEFAULTS };
}

export function loadUserPrefs() {
  return readJson(userPrefsPath()) || {};
}

/** The merged config the rest of the app should read: defaults overlaid by user. */
export function effectivePreferences() {
  return { ...loadDefaults(), ...loadUserPrefs() };
}

export function getPreference(key) {
  return effectivePreferences()[key];
}

// Validators for known, functional keys. Unknown keys are rejected so a typo
// can't silently store an inert value the user thinks is doing something.
const VALIDATORS = {
  dustThreshold: (v) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error("dustThreshold must be a number >= 0");
    }
    return v;
  },
};

/**
 * Merge `patch` into the user prefs file and write it back. Validates each key.
 * @returns {{ path:string, effective:object, defaults:object, user:object }}
 */
export function updatePreferences(patch = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const validate = VALIDATORS[k];
    if (!validate) throw new Error(`Unknown preference: ${k}`);
    clean[k] = validate(v);
  }
  const path = userPrefsPath();
  const user = { ...loadUserPrefs(), ...clean };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(user, null, 2) + "\n", "utf8");
  return { path, effective: { ...loadDefaults(), ...user }, defaults: loadDefaults(), user };
}
