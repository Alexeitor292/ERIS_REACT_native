// Pure pieces of the mobile Entra sign-in (OAuth 2.0 for Native Apps, RFC 8252:
// authorization code + PKCE through the system browser, no client secret).
// Kept free of React Native imports so they run under node's test runner.

export type EntraMobileConfig = {
  /** e.g. https://login.microsoftonline.com/<tenant-id> */
  authority: string;
  /** The ERIS mobile app's own public client ID (not the web app's). */
  client_id: string;
  /** The ERIS API scope, e.g. api://<web-app-id>/access_as_user */
  scopes: string[];
};

const ALLOWED_AUTHORITY = /^https:\/\/login\.microsoftonline\.(com|us)\/[0-9a-f-]{36}$/i;

export function base64UrlEncode(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63];
  }
  return out;
}

export function asciiBytes(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(value.length));
  for (let i = 0; i < value.length; i += 1) bytes[i] = value.charCodeAt(i) & 0xff;
  return bytes;
}

/** Refuses anything but a Microsoft Entra tenant authority, so a tampered config cannot phish. */
export function checkedAuthority(config: EntraMobileConfig): string {
  const authority = config.authority.replace(/\/+$/, "");
  if (!ALLOWED_AUTHORITY.test(authority)) throw new Error("Unexpected Entra authority");
  return authority;
}

function form(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function scopeList(config: EntraMobileConfig): string {
  // openid/profile identify the person to Entra; the API scope is what ERIS checks.
  return ["openid", "profile", ...config.scopes].join(" ");
}

export function buildAuthorizeUrl(config: EntraMobileConfig, redirectUri: string, state: string, codeChallenge: string): string {
  return `${checkedAuthority(config)}/oauth2/v2.0/authorize?${form({
    client_id: config.client_id,
    response_type: "code",
    response_mode: "query",
    redirect_uri: redirectUri,
    scope: scopeList(config),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  })}`;
}

export function tokenEndpoint(config: EntraMobileConfig): string {
  return `${checkedAuthority(config)}/oauth2/v2.0/token`;
}

export function tokenRequestBody(config: EntraMobileConfig, redirectUri: string, code: string, codeVerifier: string): string {
  return form({
    client_id: config.client_id,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    scope: scopeList(config),
  });
}

function parseQuery(url: string): Record<string, string> {
  const query = url.split("#")[0].split("?")[1] ?? "";
  const out: Record<string, string> = {};
  for (const part of query.split("&")) {
    if (!part) continue;
    const index = part.indexOf("=");
    const key = decodeURIComponent((index < 0 ? part : part.slice(0, index)).replace(/\+/g, " "));
    const value = index < 0 ? "" : decodeURIComponent(part.slice(index + 1).replace(/\+/g, " "));
    out[key] = value;
  }
  return out;
}

export class EntraSignInError extends Error {
  readonly reason: "cancelled" | "failed";

  constructor(message: string, reason: "cancelled" | "failed") {
    super(message);
    this.name = "EntraSignInError";
    this.reason = reason;
  }
}

/** The authorization code from the redirect, after checking it answers our own request. */
export function parseAuthorizationResponse(url: string, redirectUri: string, expectedState: string): string {
  if (!url.startsWith(redirectUri)) throw new EntraSignInError("Unexpected sign-in redirect.", "failed");
  const params = parseQuery(url);
  if (params.error) {
    // Entra's error code only; its free-text description is not shown.
    const cancelled = params.error === "access_denied" || params.error === "user_cancelled";
    throw new EntraSignInError(
      cancelled ? "Caltrans sign-in was not completed." : "Caltrans sign-in could not be completed.",
      cancelled ? "cancelled" : "failed",
    );
  }
  if (!params.state || params.state !== expectedState) {
    throw new EntraSignInError("Caltrans sign-in could not be verified. Try again.", "failed");
  }
  if (!params.code) throw new EntraSignInError("Caltrans sign-in returned no code.", "failed");
  return params.code;
}
