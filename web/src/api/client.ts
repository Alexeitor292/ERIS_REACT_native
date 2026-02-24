import { getToken, clearToken } from "../auth/token";

function requireEnv(name: string): string {
  const v = (import.meta as any).env?.[name];
  if (!v) {
    throw new Error(
      `Missing ${name}. Create web/.env and set ${name}=http://127.0.0.1:8000 (dev) or your prod URL.`
    );
  }
  return v;
}

const API_BASE = requireEnv("VITE_API_BASE");

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  const token = getToken();

  const headers = new Headers(init.headers || {});
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(url, { ...init, headers });

  if (res.status === 401 && normalizedPath !== "/auth/login") {
    clearToken();
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
    if (res.status >= 500) {
      msg = "Internal server error. Please try again later.";
    } else {
      try {
        const j = await res.json();
        msg = j?.detail || j?.message || msg;
      } catch {
        // ignore
      }
    }
    throw new Error(msg);
  }

  const text = await res.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}
