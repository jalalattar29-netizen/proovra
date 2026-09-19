import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, setAuthToken } from "./api";
import { isAuthError } from "./errors/safe-error";
import {
  bootReducer,
  shouldClearToken,
  INITIAL_BOOT_STATE,
  type BootPhase,
  type BootState,
  type BootEvent,
} from "./bootstrap/bootstrap-machine";
import * as SecureStore from "expo-secure-store";

type AuthUser = { id: string; email?: string | null; displayName?: string | null };

// PHASE 10 (2026-07-23) — Guest Login was physically REMOVED from PROOVRA.
// "guest" is no longer an authentication mode; the only interactive ceremonies
// are the OAuth providers.
type AuthMode = "google" | "apple" | "email";

type AuthContextValue = {
  token: string | null;
  user: AuthUser | null;
  currentUser: AuthUser | null;
  authMode: AuthMode | null;
  setToken: (token: string | null) => void;
  setSession: (payload: { token: string; user?: AuthUser | null; mode: AuthMode }) => void;
  authReady: boolean;
  loading: boolean;
  /** Canonical boot phase driving root navigation (bootstrap machine). */
  bootPhase: BootPhase;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("AuthContext missing");
  return ctx;
}

/** Clear the stored token + auth mode from secure storage (fire-and-forget). */
function purgeStoredToken() {
  setAuthToken(null);
  void SecureStore.deleteItemAsync("proovra-token");
  void SecureStore.deleteItemAsync("proovra-auth-mode");
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  // The bootstrap machine is the SOLE authority for the boot phase AND the
  // token-clear decision (A3, Law of One). No hand-rolled "isAuthError → purge"
  // or bootPhase ternary — every transition goes through bootReducer, and the
  // dead-token purge happens exactly when shouldClearToken(prev,next) says so.
  const [bootState, setBootState] = useState<BootState>(INITIAL_BOOT_STATE);
  const bootRef = useRef<BootState>(INITIAL_BOOT_STATE);

  const dispatchBoot = useCallback((event: BootEvent) => {
    const prev = bootRef.current;
    const next = bootReducer(prev, event);
    if (shouldClearToken(prev, next)) {
      // EXPIRED reached: purge the dead token so boot routes to the gateway,
      // never an authenticated-looking dead shell (audit §I).
      setTokenState(null);
      setUser(null);
      setAuthMode(null);
      purgeStoredToken();
    }
    bootRef.current = next;
    setBootState(next);
  }, []);

  // Restore an existing signed-in session from secure storage on boot. There
  // is NO guest fallback: with no stored token the app stays signed out and
  // the user must authenticate (OAuth) — no silent global session is minted.
  const restoreSession = useCallback(async () => {
    const stored = await SecureStore.getItemAsync("proovra-token");
    if (!stored) {
      dispatchBoot({ type: "RESTORE_NO_TOKEN" });
      return;
    }
    setTokenState(stored);
    setAuthToken(stored);
    dispatchBoot({ type: "RESTORE_FOUND_TOKEN" });
    try {
      const me = await apiFetch("/v1/auth/me", { method: "GET" });
      setUser(me.user ?? null);
      setAuthMode((await SecureStore.getItemAsync("proovra-auth-mode")) as AuthMode | null);
      dispatchBoot({ type: "ME_OK" });
    } catch (err) {
      // The machine decides the outcome: auth failure → expired (purge);
      // network failure → offlineAuthed (token kept, offline ≠ invalid creds).
      setUser(null);
      dispatchBoot({ type: "ME_FAILED", reason: isAuthError(err) ? "auth" : "network" });
    }
  }, [dispatchBoot]);

  const setToken = useCallback(
    (next: string | null) => {
      setTokenState(next);
      setAuthToken(next);
      if (next) {
        void SecureStore.setItemAsync("proovra-token", next);
        dispatchBoot({ type: "SIGNED_IN" });
      } else {
        setUser(null);
        setAuthMode(null);
        void SecureStore.deleteItemAsync("proovra-token");
        void SecureStore.deleteItemAsync("proovra-auth-mode");
        dispatchBoot({ type: "SIGNED_OUT" });
      }
    },
    [dispatchBoot],
  );

  const setSession = useCallback(
    (payload: { token: string; user?: AuthUser | null; mode: AuthMode }) => {
      setTokenState(payload.token);
      setAuthToken(payload.token);
      setUser(payload.user ?? null);
      setAuthMode(payload.mode);
      void SecureStore.setItemAsync("proovra-token", payload.token);
      void SecureStore.setItemAsync("proovra-auth-mode", payload.mode);
      dispatchBoot({ type: "SIGNED_IN" });
    },
    [dispatchBoot],
  );

  useEffect(() => {
    void (async () => {
      try {
        await restoreSession();
      } catch {
        // A storage read that itself threw is treated as "no session".
        dispatchBoot({ type: "RESTORE_NO_TOKEN" });
      }
    })();
  }, [restoreSession, dispatchBoot]);

  // Boot phase + readiness are DERIVED from the machine — one authority.
  const bootPhase: BootPhase = bootState.phase;
  const authReady = bootState.phase !== "restoring";
  const loading = bootState.phase === "restoring";

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      user,
      currentUser: user,
      authMode,
      setToken,
      setSession,
      authReady,
      loading,
      bootPhase,
    }),
    [token, user, authMode, setToken, setSession, authReady, loading, bootPhase],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
