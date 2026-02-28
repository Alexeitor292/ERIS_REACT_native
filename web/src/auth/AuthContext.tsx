import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { getToken, setToken, clearToken, getTokenExpiryMs } from "./token";

import type { Me } from "../api/types";

type AuthState = {
  me: Me | null;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshMe: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState<string | null>(getToken());
  const [me, setMe] = useState<Me | null>(null);

  async function refreshMe() {
    if (!getToken()) {
      setMe(null);
      return;
    }
    const data = await api<Me>("/auth/me");
    setMe(data);
  }

  async function login(email: string, password: string) {
    const res = await api<{ access_token: string; token_type: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setToken(res.access_token);
    setTokenState(res.access_token);
    await refreshMe();
  }

  function logout() {
    clearToken();
    setTokenState(null);
    setMe(null);
  }

  function onSessionExpired() {
    clearToken();
    setTokenState(null);
    setMe(null);
    try {
      sessionStorage.setItem("eris_session_expired", "1");
    } catch {
      // ignore
    }
    if (window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
  }

  useEffect(() => {
    // On first load, if token exists try fetch /auth/me
    if (token) refreshMe().catch(() => logout());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!token) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = () => {
      const liveToken = getToken();
      if (!liveToken) return;
      const expMs = getTokenExpiryMs(liveToken);
      if (expMs == null) return;
      if (Date.now() >= expMs) {
        onSessionExpired();
        return;
      }
      const msUntilExpire = Math.max(expMs - Date.now(), 0);
      timer = setTimeout(check, msUntilExpire + 50);
    };

    check();
    const onVisible = () => check();
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [token]);

  const value = useMemo(() => ({ me, token, login, logout, refreshMe }), [me, token]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
