"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  type Locale,
  defaultLocale,
  resolveInitialLocale,
  translations
} from "../lib/i18n";
import { apiFetch } from "../lib/api";

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
  const [locale, setLocale] = useState<Locale>(defaultLocale);
  const [token, setTokenState] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    const resolved = resolveInitialLocale();
    setLocale(resolved);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
    localStorage.setItem("proovra-locale", locale);
  }, [locale]);

  const value = useMemo<LocaleContextValue>(() => {
    const isRTL = locale === "ar";
    const t = (key: keyof (typeof translations)["en"]) =>
      translations[locale]?.[key] ?? translations.en[key];
    return { locale, setLocale, t, isRTL };
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

    return { token, user, ensureGuest, setToken, authReady };
  }, [token, user, authReady]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = localStorage.getItem("proovra-token");
    if (!stored) {
      setAuthReady(true);
      return;
    }
    setTokenState(stored);
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
