"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { type Locale, type LocaleMode, resolveInitialLocale, translations } from "../lib/i18n";
import { apiFetch } from "../lib/api";
import { initSentry } from "../lib/sentry";
import { ToastProvider } from "../components/ui";

type AuthUser = {
  id: string;
  email?: string | null;
  displayName?: string | null;
  provider: string;
  /** Server-authoritative role (e.g. admin). Omitted for non-admin users. */
  role?: string | null;

  firstName?: string | null;
  lastName?: string | null;
  avatarUrl?: string | null;
  locale?: string | null;
  timezone?: string | null;
  country?: string | null;
  bio?: string | null;

  createdAt?: string;
  updatedAt?: string;
};

type AuthContextValue = {
  token: string | null;
  user: AuthUser | null;
  ensureGuest: () => Promise<void>;
  setToken: (token: string | null) => void;

  refreshMe: () => Promise<void>;
  updateUser: (next: AuthUser | null) => void;

  authReady: boolean;
  hasSession: boolean;
};

type LocaleContextValue = {
  locale: Locale;
  mode: LocaleMode;
  setLocale: (locale: Locale) => void;
  setLocaleMode: (mode: LocaleMode) => void;
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

async function fetchMe(): Promise<AuthUser | null> {
  try {
    const me = await apiFetch("/v1/users/me", { method: "GET" });
    return (me?.user ?? null) as AuthUser | null;
  } catch {
    try {
      const me = await apiFetch("/v1/auth/me", { method: "GET" });
      return (me?.user ?? null) as AuthUser | null;
    } catch {
      return null;
    }
  }
}

function readStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem("proovra-token");
  } catch {
    return null;
  }
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");
  const [mode, setModeState] = useState<LocaleMode>("auto");

  const [token, setTokenState] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);

  const [authReady, setAuthReady] = useState(false);

  // Init sentry + initial locale
  useEffect(() => {
    initSentry();
    if (typeof window === "undefined") return;

    const { locale: resolvedLocale, mode: resolvedMode } = resolveInitialLocale();
    setLocaleState(resolvedLocale);
    setModeState(resolvedMode);
  }, []);

  // Persist locale
  useEffect(() => {
    if (typeof document === "undefined") return;

    const isRTL = locale === "ar";
    document.documentElement.lang = locale;
    document.documentElement.dir = isRTL ? "rtl" : "ltr";

    try {
      localStorage.setItem("proovra-locale", locale);
      localStorage.setItem("proovra-locale-mode", mode);
    } catch {
      // ignore
    }
  }, [locale, mode]);

  const localeValue = useMemo<LocaleContextValue>(() => {
    const isRTL = locale === "ar";
    const currentTranslations = translations[locale] || translations.en;

    const t = (key: keyof (typeof translations)["en"]) =>
      currentTranslations[key as keyof (typeof translations)[Locale]] || translations.en[key];

    const setLocale = (newLocale: Locale) => setLocaleState(newLocale);
    const setLocaleMode = (newMode: LocaleMode) => setModeState(newMode);

    return { locale, mode, setLocale, setLocaleMode, t, isRTL };
  }, [locale, mode]);

  // Auth context
  const authValue = useMemo<AuthContextValue>(() => {
    const setToken = (next: string | null) => {
      setTokenState(next);

      if (typeof window === "undefined") return;
      try {
        if (next) {
          localStorage.setItem("proovra-token", next);
        } else {
          localStorage.removeItem("proovra-token");
          setUser(null);
        }
      } catch {
        // ignore
      }
    };

    const updateUser = (next: AuthUser | null) => setUser(next);

    const refreshMe = async () => {
      // ✅ مهم: لا تفرّغ user/session إذا فشل الطلب مؤقتاً
      try {
        const meUser = await fetchMe();
        if (meUser) setUser(meUser);
      } catch {
        // keep previous user
      }
    };

    const ensureGuest = async () => {
      if (typeof window === "undefined") return;

      const stored = readStoredToken();
      if (stored) {
        setTokenState(stored);
        await refreshMe();
        return;
      }

      try {
        const data = await apiFetch("/v1/auth/guest", { method: "POST" });
        setToken(data?.token ?? null);
        setUser((data?.user ?? null) as AuthUser | null);
      } catch {
        setUser(null);
      }
    };

    // ✅ hasSession يعتمد أيضاً على localStorage لتجنب “لحظة false”
    const hasSession = Boolean(user || token || readStoredToken());

    return { token, user, ensureGuest, setToken, refreshMe, updateUser, authReady, hasSession };
  }, [token, user, authReady]);

  // Boot auth
  useEffect(() => {
    if (typeof window === "undefined") return;

    const stored = readStoredToken();
    if (stored) setTokenState(stored);

    void (async () => {
      try {
        // إذا في token، حاول هات me، بس لا تقتل session إذا رجع null
        const meUser = await fetchMe();
        if (meUser) setUser(meUser);
      } finally {
        setAuthReady(true);
      }
    })();
  }, []);

  return (
    <AuthContext.Provider value={authValue}>
      <LocaleContext.Provider value={localeValue}>
        <ToastProvider>{children}</ToastProvider>
      </LocaleContext.Provider>
    </AuthContext.Provider>
  );
}