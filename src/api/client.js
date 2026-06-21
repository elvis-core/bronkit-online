// Signed HTTP client for the Bron public API — port of
// bronlabs/bron-sdk-go/sdk/http/client.go (MIT).
//
// Builds path+query and body, signs each request (ES256 JWT via ../auth/sign.js),
// sends `Authorization: ApiKey <jwt>`, and maps Bron's error envelope.
// Base URL: https://api.bron.org. Paths are workspace-scoped, e.g.
//   GET  /workspaces/{workspaceId}/balances
//   POST /workspaces/{workspaceId}/transactions

import { generateBronJwt, parseJwk } from "../auth/sign.js";

const DEFAULT_BASE_URL = "https://api.bron.org";
const USER_AGENT = "Bronkit/0.8.0";
const TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  constructor({ status, code, message, requestId }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export class BronApiClient {
  /** @param {{ apiKey:string, baseURL?:string, fetchImpl?:Function }} opts */
  constructor({ apiKey, baseURL = process.env.BRON_BASE_URL || DEFAULT_BASE_URL, fetchImpl } = {}) {
    if (!apiKey) throw new Error("BronApiClient: apiKey (JWK) is required");
    this.apiKey = apiKey;
    this.kid = parseJwk(apiKey).kid; // validates the JWK up front
    this.baseURL = baseURL.replace(/\/+$/, "");
    this.fetch = fetchImpl || globalThis.fetch;
  }

  /**
   * @param {{ method:string, path:string, query?:object, body?:object }} opts
   * @returns {Promise<any>} parsed JSON response (or null on empty body)
   */
  async request({ method, path, query, body }) {
    const pathWithQuery = path + encodeQuery(query);
    const bodyStr = body == null ? "" : JSON.stringify(body);
    const iat = Math.floor(Date.now() / 1000);
    const jwt = await generateBronJwt({ method, pathWithQuery, body: bodyStr, jwk: this.apiKey, iat });

    const headers = { Authorization: "ApiKey " + jwt, "User-Agent": USER_AGENT };
    const init = { method, headers };
    if (bodyStr) {
      headers["Content-Type"] = "application/json";
      init.body = bodyStr;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    init.signal = ctrl.signal;
    let resp;
    try {
      resp = await this.fetch(this.baseURL + pathWithQuery, init);
    } finally {
      clearTimeout(timer);
    }

    const text = await resp.text();
    if (resp.status >= 400) throw toApiError(resp, text);
    return text ? JSON.parse(text) : null;
  }

  get(path, query) {
    return this.request({ method: "GET", path, query });
  }
  post(path, body) {
    return this.request({ method: "POST", path, body });
  }
  del(path, query) {
    return this.request({ method: "DELETE", path, query });
  }
}

/**
 * Mirror Go's url.Values handling: skip null/undefined, join arrays with ",",
 * sort keys. (We sign the exact string we send, so this only needs to be
 * self-consistent — sorting matches Go's Encode for good measure.)
 */
export function encodeQuery(query) {
  if (!query) return "";
  const keys = Object.keys(query).filter((k) => query[k] != null).sort();
  if (keys.length === 0) return "";
  return (
    "?" +
    keys
      .map((k) => {
        const v = query[k];
        const val = Array.isArray(v) ? v.join(",") : String(v);
        return `${encodeURIComponent(k)}=${encodeURIComponent(val)}`;
      })
      .join("&")
  );
}

/** Map a non-2xx response to an ApiError (port of client.go parseAPIError). */
export function toApiError(resp, text) {
  let p = {};
  try {
    p = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON error body */
  }
  const message = p.message || p.error || p.error_description || text || resp.statusText;
  const code = p.code || p.error || resp.statusText;
  const requestId =
    resp.headers.get("Correlation-Id") ||
    resp.headers.get("X-Correlation-Id") ||
    resp.headers.get("X-Request-Id") ||
    p.id ||
    p.requestId ||
    "";
  return new ApiError({ status: resp.status, code, message, requestId });
}
