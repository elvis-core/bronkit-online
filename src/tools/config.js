// Local configuration tool. Unlike the other tools this touches no API — it
// reads/writes the user's preferences file (~/.bron/preferences.json), layered
// over the bundled defaults (config/defaults.json). Call with no fields to view
// the effective config; pass a field to update it.

import { effectivePreferences, loadDefaults, loadUserPrefs, updatePreferences, userPrefsPath } from "../util/preferences.js";

export const preferencesTool = {
  name: "bron_preferences",
  title: "View / edit preferences",
  description:
    "View or change bronkit's local preferences (stored in ~/.bron/preferences.json, layered over the shipped defaults). Call with no fields to view the effective config and where each value comes from. Pass a field to change it. Today the only functional setting is dustThreshold (USD) — balances/portfolio hide rows worth less than this. Updating is state-changing — confirm with the user before changing a value.",
  inputSchema: {
    type: "object",
    properties: {
      dustThreshold: {
        type: "number",
        description: "USD threshold below which balances are treated as dust and hidden. Must be >= 0.",
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: (_ctx, a = {}) => {
    const hasUpdate = Object.values(a).some((v) => v !== undefined);
    if (hasUpdate) {
      const { path, effective, defaults, user } = updatePreferences(a);
      return { updated: true, path, effective, defaults, overrides: user };
    }
    return {
      updated: false,
      path: userPrefsPath(),
      effective: effectivePreferences(),
      defaults: loadDefaults(),
      overrides: loadUserPrefs(),
    };
  },
};

export const configTools = [preferencesTool];
