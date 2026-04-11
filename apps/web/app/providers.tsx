"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { type Locale, type LocaleMode, resolveInitialLocale, translations } from "../lib/i18n";
import { apiFetch } from "../lib/api";
import { initSentry } from "../lib/sentry";
import { ToastProvider } from "../components/ui";
import {
  getCookieConsentEventName,
  readCookieConsentState,
  hasAnalyticsConsent,
  isCookieConsentSyncedForUser,
  markCookieConsentSyncedForUser,
} from "../lib/consent";

type AuthUser = {
  id: string;
  email?: string | null;
  displayName?: string | null;
  provider: string;
  platformRole?: string | null;
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

function readStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem("proovra-token");
  } catch {
    return null;
  }
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

export function Providers({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");
  const [mode, setModeState] = useState<LocaleMode>("auto");

  const [token, setTokenState] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const { locale: resolvedLocale, mode: resolvedMode } = resolveInitialLocale();
      setLocaleState(resolvedLocale);
      setModeState(resolvedMode);
    }

    const maybeInitSentry = () => {
      if (hasAnalyticsConsent()) {
        initSentry();
      }
    };

    maybeInitSentry();

    if (typeof window === "undefined") return;

    const onConsentChanged = () => {
      maybeInitSentry();
    };

    const eventName = getCookieConsentEventName();
    window.addEventListener(eventName, onConsentChanged);

    return () => {
      window.removeEventListener(eventName, onConsentChanged);
    };
  }, []);

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
      currentTranslations[key as keyof typeof currentTranslations] || translations.en[key];

    const setLocale = (newLocale: Locale) => setLocaleState(newLocale);
    const setLocaleMode = (newMode: LocaleMode) => setModeState(newMode);

    return { locale, mode, setLocale, setLocaleMode, t, isRTL };
  }, [locale, mode]);

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
      try {
        const meUser = await fetchMe();
        setUser(meUser);
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

    const hasSession = Boolean(user || token);

    return {
      token,
      user,
      ensureGuest,
      setToken,
      refreshMe,
      updateUser,
      authReady,
      hasSession,
    };
  }, [token, user, authReady]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const stored = readStoredToken();
    if (stored) {
      setTokenState(stored);
    }

    void (async () => {
      try {
        const meUser = await fetchMe();
        setUser(meUser);
      } finally {
        setAuthReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!authReady || !user?.id) return;

    const consent = readCookieConsentState();
    if (!consent) return;

    if (isCookieConsentSyncedForUser(user.id)) {
      return;
    }

    void apiFetch("/v1/users/cookie-consent", {
      method: "POST",
      body: JSON.stringify({
        consentVersion: consent.consentVersion,
        necessary: consent.necessary,
        analytics: consent.analytics,
        marketing: consent.marketing,
        preferences: consent.preferences,
      }),
    })
      .then(() => {
        markCookieConsentSyncedForUser(user.id);
      })
      .catch(() => {
        // ignore
      });
  }, [authReady, user?.id]);

  return (
    <AuthContext.Provider value={authValue}>
      <LocaleContext.Provider value={localeValue}>
        <ToastProvider>{children}</ToastProvider>
      </LocaleContext.Provider>
    </AuthContext.Provider>
  );
}