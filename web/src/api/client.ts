import { csrfHeaders } from "../auth/token";
import { appConfig } from "../config";

const API_BASE = appConfig.apiBaseUrl;

/** A refused request: its status, and the server's detail as sent (a string, or an object for structured refusals). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly detail: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

/** The API's base URL, for requests that cannot go through `api` (a page closing). */
export const apiUrl = (path: string) => `${API_BASE}${path}`;

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  const headers = new Headers(init.headers || {});
  const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;
  if (!headers.has("Content-Type") && init.body && !isFormData) headers.set("Content-Type", "application/json");
  // The session travels in its HttpOnly cookie; writes also carry its CSRF token.
  for (const [name, value] of Object.entries(csrfHeaders(init.method))) headers.set(name, value);

  const res = await fetch(url, { ...init, headers, credentials: "same-origin" });

  // /auth/me is how the app asks "am I signed in?": a 401 there is an answer, not an expiry.
  if (res.status === 401 && normalizedPath !== "/auth/login" && normalizedPath !== "/auth/me") {
    try {
      sessionStorage.setItem("eris_session_expired", "1");
    } catch {
      // ignore
    }
    if (window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
    throw new Error("Session expired. Please sign in again.");
  }

  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    let detail: unknown = undefined;
    if (res.status >= 500) {
      msg = "Internal server error. Please try again later.";
    } else {
      try {
        const j = await res.json();
        detail = j?.detail;
        // A structured refusal (a save conflict, say) carries its message inside.
        const structured = detail && typeof detail === "object" ? (detail as { message?: string }).message : undefined;
        const validation = Array.isArray(detail) ? detail.map((item: { msg?: string }) => item.msg).filter(Boolean).join("; ") : "";
        msg = structured || validation || (typeof detail === "string" ? detail : "") || j?.message || msg;
      } catch {
        // ignore
      }
    }
    throw new ApiError(msg, res.status, detail);
  }

  const text = await res.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}
