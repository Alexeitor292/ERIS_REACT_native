import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { getToken, setToken, clearToken } from "./token";

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

  useEffect(() => {
    // On first load, if token exists try fetch /auth/me
    if (token) refreshMe().catch(() => logout());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo(() => ({ me, token, login, logout, refreshMe }), [me, token]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
