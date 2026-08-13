import { getApiBaseUrl } from "./baseUrl";
import { router } from "expo-router";
import { clearToken, markOnlineAuthSuccess, setSessionExpiredNotice } from "../auth/tokenStore";
import { readSitePhotoMapCache, writeSitePhotoMapCache } from "../offline/sitePhotoMapCache";
import { authenticatedRequestHeaders } from "./authHeaders";

export class SessionExpiredError extends Error {
  constructor() {
    super("Session expired. Please sign in again.");
    this.name = "SessionExpiredError";
  }
}

export function isSessionExpiredError(error: unknown): error is SessionExpiredError {
  return error instanceof SessionExpiredError;
}

let handlingUnauthorized = false;

async function handleUnauthorized() {
  if (handlingUnauthorized) return;
  handlingUnauthorized = true;
  try {
    await clearToken();
    await setSessionExpiredNotice();
    router.replace("/(auth)/login");
  } finally {
    setTimeout(() => {
      handlingUnauthorized = false;
    }, 500);
  }
}

function sitePhotoMapSubmissionId(path: string, method: string): string | null {
  if (method !== "GET") return null;
  const match = path.match(/^\/submissions\/([^/]+)\/photo-map$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export async function apiFetch<T = any>(
  path: string,
  opts: { method?: string; token?: string; body?: any } = {}
): Promise<T> {
  const base = getApiBaseUrl();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const method = opts.method ?? "GET";
  const url = `${base}${normalizedPath}`;
  const photoMapSubmissionId = sitePhotoMapSubmissionId(normalizedPath, method);

  const headers: Record<string, string> = opts.token
    ? authenticatedRequestHeaders(opts.token)
    : {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (error) {
    // The Site Photo Map is a field workflow. Once an authenticated snapshot has
    // been obtained, lack of reception must not prevent reopening it. Explicit
    // server responses still go through the normal authorization/error handling
    // below and can never be bypassed by this cache.
    if (photoMapSubmissionId && opts.token) {
      const cached = await readSitePhotoMapCache(photoMapSubmissionId);
      if (cached) return cached as T;
    }
    throw error;
  }

  if (res.status === 401 && normalizedPath !== "/auth/login") {
    await handleUnauthorized();
    throw new SessionExpiredError();
  }

  if (!res.ok) {
    if (res.status >= 500) {
      throw new Error("Internal server error. Please try again later.");
    }
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  if (opts.token) {
    markOnlineAuthSuccess().catch(() => {});
  }
  const data = (await res.json()) as T;
  if (photoMapSubmissionId && opts.token) {
    await writeSitePhotoMapCache(photoMapSubmissionId, data).catch(() => {});
  }
  return data;
}
