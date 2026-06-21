// The connect page served by /oauth/authorize. The user pastes their own Bron
// ES256 JWK (and workspace id) once; on submit the server validates, encrypts,
// stores, and completes the OAuth handshake back to Claude. Built mobile-first —
// testing the mobile connect UX is the point of this POC.
//
// NOTE on the second field: the Bron API is workspace-scoped
// (/workspaces/{id}/...) and there is no "list my workspaces" endpoint in the
// ported toolset, so the page collects the workspace id alongside the JWK. The
// JWK is the secret (encrypted at rest); the workspace id is non-secret routing.

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const HIDDEN_FIELDS = [
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "resource",
];

/**
 * @param {{ actionUrl:string, params:object, error?:string }} opts
 * @returns {string} full HTML document
 */
export function renderConnectPage({ actionUrl, params = {}, error = "" }) {
  const hidden = HIDDEN_FIELDS.map(
    (k) => `<input type="hidden" name="${k}" value="${esc(params[k])}">`
  ).join("\n      ");

  const errorBlock = error
    ? `<div class="err" role="alert">${esc(error)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="robots" content="noindex">
  <title>Connect Bronkit</title>
  <style>
    :root { --bg:#0f0d17; --card:#1a1726; --fg:#ece9f5; --muted:#9a93b3; --accent:#7c5cff; --accent2:#a78bfa; --err:#ff6b6b; --ok:#34d399; --line:#2a2640; }
    * { box-sizing: border-box; }
    html,body { margin:0; padding:0; background:var(--bg); color:var(--fg);
      font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
    .wrap { max-width:560px; margin:0 auto; padding:24px 18px 56px; }
    .brand { display:flex; align-items:center; gap:12px; margin:8px 0 20px; }
    .logo { width:40px; height:40px; border-radius:10px;
      background:linear-gradient(135deg,var(--accent),#3b2d80); flex:0 0 auto; }
    h1 { font-size:22px; margin:0; }
    .sub { color:var(--muted); font-size:14px; margin:2px 0 0; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:20px; margin-top:18px; }
    label { display:block; font-weight:600; margin:0 0 6px; font-size:14px; }
    .hint { color:var(--muted); font-size:13px; margin:0 0 10px; }
    textarea, input[type=text] { width:100%; background:#100e1a; color:var(--fg);
      border:1px solid var(--line); border-radius:12px; padding:14px; font-size:15px;
      font-family:ui-monospace,SFMono-Regular,Menlo,monospace; -webkit-appearance:none; }
    textarea { min-height:160px; resize:vertical; line-height:1.4; }
    input[type=text] { font-family:inherit; }
    .field { margin-bottom:18px; }
    button { width:100%; border:0; border-radius:12px; padding:16px; font-size:17px; font-weight:700;
      color:#fff; background:linear-gradient(135deg,var(--accent),var(--accent2)); cursor:pointer; }
    button:active { transform:translateY(1px); }
    .err { background:rgba(255,107,107,.12); border:1px solid var(--err); color:#ffb4b4;
      border-radius:12px; padding:12px 14px; margin-bottom:16px; font-size:14px; }
    .privacy { color:var(--muted); font-size:12.5px; margin-top:16px; }
    .privacy b { color:var(--fg); }
    code { background:#100e1a; padding:1px 6px; border-radius:6px; border:1px solid var(--line); font-size:12.5px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand">
      <div class="logo" aria-hidden="true"></div>
      <div>
        <h1>Connect your Bron treasury</h1>
        <p class="sub">One-time setup. Your key stays encrypted on this server.</p>
      </div>
    </div>

    ${errorBlock}

    <form class="card" method="post" action="${esc(actionUrl)}" autocomplete="off">
      ${hidden}

      <div class="field">
        <label for="jwk">Bron API key (JWK JSON)</label>
        <p class="hint">Paste the full key file from the Bron app — the whole JSON, including the curly braces.</p>
        <textarea id="jwk" name="jwk" required spellcheck="false" autocapitalize="off"
          placeholder='{"kty":"EC","crv":"P-256","d":"...","x":"...","y":"...","kid":"..."}'></textarea>
      </div>

      <div class="field">
        <label for="workspaceId">Workspace ID</label>
        <p class="hint">The UUID of the Bron workspace this key operates in.</p>
        <input id="workspaceId" name="workspaceId" type="text" required spellcheck="false"
          autocapitalize="off" placeholder="00000000-0000-0000-0000-000000000000">
      </div>

      <button type="submit">Connect</button>

      <p class="privacy">
        <b>What happens to your key:</b> it is encrypted at rest with AES-256-GCM and only
        decrypted in memory to sign each Bron request, then discarded. It is never written in
        plaintext and never logged. Bronkit can only ever <b>create requests</b> — moving funds
        still requires your approval in the Bron app.
      </p>
    </form>
  </div>
</body>
</html>`;
}
