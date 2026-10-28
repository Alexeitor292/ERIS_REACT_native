import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api, ApiError, apiUrl } from "../api/client";
import { csrfHeaders } from "./token";

import type { Me } from "../api/types";

// The session is an HttpOnly cookie the browser sends by itself; this context
// never sees it. "Signed in" means the API answered /auth/me. The server ends
// idle and expired sessions, and the next request's 401 brings the person
// back to the sign-in page.
type AuthState = {
  me: Me | null;
  signedIn: boolean;
  isInitializing: boolean;
  login: (email: string, password: string) => Promise<Me>;
  finishEntra: () => Promise<Me>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

async function fetchMe(): Promise<Me | null> {
  try {
    return await api<Me>("/auth/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);

  async function refreshMe() {
    setMe(await fetchMe());
  }

  async function establish(): Promise<Me> {
    const data = await fetchMe();
    if (!data) throw new Error("Sign-in did not complete. Try again.");
    setMe(data);
    return data;
  }

  async function login(email: string, password: string) {
    // The response sets the session cookies; no credential reaches this code.
    await api("/auth/login", { method: "POST", headers: { "X-ERIS-Client": "web" }, body: JSON.stringify({ email, password }) });
    return establish();
  }

  async function finishEntra() {
    // The Entra callback already set the session cookies.
    return establish();
  }

  async function logout() {
    // End the session on the server (it clears the cookies), then locally.
    // Not through api(): a session that already expired is not an error here.
    try {
      await fetch(apiUrl("/auth/logout"), { method: "POST", credentials: "same-origin", headers: csrfHeaders("POST") });
    } catch {
      // Offline: the server ends the session at its idle timeout.
    }
    setMe(null);
    setIsInitializing(false);
    try {
      sessionStorage.setItem("eris_signed_out", "1");
    } catch {
      // Browser storage may be unavailable under hardened/private policies.
    }
    window.location.href = "/login";
  }

  useEffect(() => {
    let cancelled = false;
    try {
      // Earlier releases kept a bearer token in localStorage; remove any left behind.
      localStorage.removeItem("eris_token");
    } catch {
      // Storage may be unavailable under hardened/private policies.
    }
    fetchMe()
      .then((data) => {
        if (!cancelled) setMe(data);
      })
      .catch(() => {
        if (!cancelled) setMe(null);
      })
      .finally(() => {
        if (!cancelled) setIsInitializing(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(
    () => ({ me, signedIn: me != null, isInitializing, login, finishEntra, logout, refreshMe }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [me, isInitializing]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
