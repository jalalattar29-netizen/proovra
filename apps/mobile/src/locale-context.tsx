import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { type Locale, translations, resolveInitialLocale } from "./i18n";

declare global {
  // eslint-disable-next-line no-var
  var __PROOVRA_LOCALE: Locale | undefined;
}

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: keyof (typeof translations)["en"]) => string;
  isRTL: boolean;
  fontFamily: string;
  fontFamilyBold: string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("LocaleContext missing");
  return ctx;
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      // Initialize with device language detection
      const resolved = resolveInitialLocale();
      setLocaleState(resolved);
      globalThis.__PROOVRA_LOCALE = resolved;
      setReady(true);
    } catch (error) {
      // Fall back to EN if anything fails
      setLocaleState("en");
      globalThis.__PROOVRA_LOCALE = "en";
      setReady(true);
    }
  }, []);

  const setLocale = (newLocale: Locale) => {
    setLocaleState(newLocale);
    globalThis.__PROOVRA_LOCALE = newLocale;
    // Note: Persistence would require AsyncStorage dependency
    // For now, language resets on app restart (can be added if dependency is installed)
  };

  const value = useMemo<LocaleContextValue>(() => {
    const isRTL = locale === "ar";
    const currentTranslations = translations[locale] || translations.en;
    const t = (key: keyof (typeof translations)["en"]) =>
      (currentTranslations[key as keyof (typeof translations)[Locale]] as string) ||
      (translations.en[key] as string);
    const fontFamily = isRTL ? "Noto Sans Arabic" : "Inter";
    const fontFamilyBold = isRTL ? "Noto Sans Arabic" : "Inter";
    return { locale, setLocale, t, isRTL, fontFamily, fontFamilyBold };
  }, [locale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
