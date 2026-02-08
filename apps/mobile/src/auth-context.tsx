import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { apiFetch, setAuthToken } from "./api";
import * as SecureStore from "expo-secure-store";

type AuthUser = { id: string; email?: string | null; displayName?: string | null };

type AuthMode = "guest" | "google" | "apple";

type AuthContextValue = {
  token: string | null;
  user: AuthUser | null;
  currentUser: AuthUser | null;
  authMode: AuthMode | null;
  ensureGuest: () => Promise<void>;
  setToken: (token: string | null) => void;
  setSession: (payload: { token: string; user?: AuthUser | null; mode: AuthMode }) => void;
  authReady: boolean;
  loading: boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("AuthContext missing");
  return ctx;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [authReady, setAuthReady] = useState(false);

  const ensureGuest = async () => {
    if (token) return;
    const stored = await SecureStore.getItemAsync("proovra-token");
    if (stored) {
      setTokenState(stored);
      setAuthToken(stored);
      try {
        const me = await apiFetch("/v1/auth/me", { method: "GET" });
        setUser(me.user ?? null);
        setAuthMode((await SecureStore.getItemAsync("proovra-auth-mode")) as AuthMode | null);
      } catch {
        setUser(null);
      } finally {
        setLoading(false);
        setAuthReady(true);
      }
      return;
    }
    const data = await apiFetch("/v1/auth/guest", { method: "POST" });
    setTokenState(data.token);
    setUser(data.user);
    setAuthToken(data.token);
    await SecureStore.setItemAsync("proovra-token", data.token);
    await SecureStore.setItemAsync("proovra-auth-mode", "guest");
    setAuthMode("guest");
    setLoading(false);
    setAuthReady(true);
  };

  const setToken = (next: string | null) => {
    setTokenState(next);
    setAuthToken(next);
    if (next) {
      void SecureStore.setItemAsync("proovra-token", next);
    } else {
      void SecureStore.deleteItemAsync("proovra-token");
      void SecureStore.deleteItemAsync("proovra-auth-mode");
      setAuthMode(null);
      setUser(null);
    }
  };

  const setSession = (payload: { token: string; user?: AuthUser | null; mode: AuthMode }) => {
    setTokenState(payload.token);
    setAuthToken(payload.token);
    setUser(payload.user ?? null);
    setAuthMode(payload.mode);
    void SecureStore.setItemAsync("proovra-token", payload.token);
    void SecureStore.setItemAsync("proovra-auth-mode", payload.mode);
  };

  useEffect(() => {
    void (async () => {
      try {
        await ensureGuest();
      } catch {
        setLoading(false);
        setAuthReady(true);
      }
    })();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      user,
      currentUser: user,
      authMode,
      ensureGuest,
      setToken,
      setSession,
      authReady,
      loading
    }),
    [token, user, authMode, authReady, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
