import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { apiFetch, setAuthToken } from "./api";
import * as SecureStore from "expo-secure-store";

type AuthUser = { id: string; email?: string | null; displayName?: string | null };

type AuthContextValue = {
  token: string | null;
  user: AuthUser | null;
  ensureGuest: () => Promise<void>;
  setToken: (token: string | null) => void;
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

  const ensureGuest = async () => {
    if (token) return;
    const stored = await SecureStore.getItemAsync("proovra-token");
    if (stored) {
      setTokenState(stored);
      setAuthToken(stored);
      return;
    }
    const data = await apiFetch("/v1/auth/guest", { method: "POST" });
    setTokenState(data.token);
    setUser(data.user);
    setAuthToken(data.token);
    await SecureStore.setItemAsync("proovra-token", data.token);
  };

  const setToken = (next: string | null) => {
    setTokenState(next);
    setAuthToken(next);
    if (next) {
      void SecureStore.setItemAsync("proovra-token", next);
    } else {
      void SecureStore.deleteItemAsync("proovra-token");
    }
  };

  useEffect(() => {
    void ensureGuest();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ token, user, ensureGuest, setToken }),
    [token, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
