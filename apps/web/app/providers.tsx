"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  type Locale,
  resolveInitialLocale,
  translations
} from "../lib/i18n";
import { apiFetch } from "../lib/api";
import { initSentry } from "../lib/sentry";

type AuthUser = {
  id: string;
  email?: string | null;
  displayName?: string | null;
  provider: string;
};

type AuthContextValue = {
  token: string | null;
  user: AuthUser | null;
  ensureGuest: () => Promise<void>;
  setToken: (token: string | null) => void;
  authReady: boolean;
  hasSession: boolean;
};

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: keyof (typeof translations)["en"]) => string;
  isRTL: boolean;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);
const AuthContext = createContext<AuthContextValue | null>(null);

export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("LocaleContext missing");
  return ctx;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("AuthContext missing");
  return ctx;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");
  const [token, setTokenState] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    initSentry();
    const resolved = resolveInitialLocale();
    setLocaleState(resolved);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = "en";
    document.documentElement.dir = "ltr";
    localStorage.setItem("proovra-locale", "en");
  }, [locale]);

  const value = useMemo<LocaleContextValue>(() => {
    const isRTL = false;
    const t = (key: keyof (typeof translations)["en"]) =>
      translations.en[key];
    const setLocale = () => {
      setLocaleState("en");
    };
    return { locale: "en", setLocale, t, isRTL };
  }, [locale]);

  const authValue = useMemo<AuthContextValue>(() => {
    const setToken = (next: string | null) => {
      setTokenState(next);
      if (next) localStorage.setItem("proovra-token", next);
      else localStorage.removeItem("proovra-token");
    };

    const ensureGuest = async () => {
      const stored = localStorage.getItem("proovra-token");
      if (stored) {
        setTokenState(stored);
        try {
          const me = await apiFetch("/v1/auth/me", { method: "GET" });
          setUser(me.user ?? null);
        } catch {
          setUser(null);
        }
        return;
      }
      try {
        const data = await apiFetch("/v1/auth/guest", {
          method: "POST"
        });
        setToken(data.token);
        setUser(data.user);
      } catch {
        setUser(null);
      }
    };

    const hasSession = Boolean(user || token);
    return { token, user, ensureGuest, setToken, authReady, hasSession };
  }, [token, user, authReady]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = localStorage.getItem("proovra-token");
    if (stored) setTokenState(stored);
    void (async () => {
      try {
        const me = await apiFetch("/v1/auth/me", { method: "GET" });
        setUser(me.user ?? null);
      } catch {
        setUser(null);
      } finally {
        setAuthReady(true);
      }
    })();
  }, []);

  return (
    <AuthContext.Provider value={authValue}>
      <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
    </AuthContext.Provider>
  );
}
