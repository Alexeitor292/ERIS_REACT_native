import { getApiBaseUrl } from "./baseUrl";
import { router } from "expo-router";
import { clearToken, markOnlineAuthSuccess, setSessionExpiredNotice } from "../auth/tokenStore";

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

export async function apiFetch<T = any>(
  path: string,
  opts: { method?: string; token?: string; body?: any } = {}
): Promise<T> {
  const base = getApiBaseUrl();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${base}${normalizedPath}`;

  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

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
  return (await res.json()) as T;
}
