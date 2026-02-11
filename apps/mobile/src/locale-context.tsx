import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { type Locale, translations } from "./i18n";

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

  useEffect(() => {
    const load = async () => {
      setLocaleState("en");
    };
    void load();
  }, []);

  const setLocale = () => {
    setLocaleState("en");
    globalThis.__PROOVRA_LOCALE = "en";
  };

  const value = useMemo<LocaleContextValue>(() => {
    const isRTL = false;
    const t = (key: keyof (typeof translations)["en"]) =>
      translations.en[key];
    const fontFamily = isRTL ? "Noto Sans Arabic" : "Inter";
    const fontFamilyBold = isRTL ? "Noto Sans Arabic" : "Inter";
    return { locale, setLocale, t, isRTL, fontFamily, fontFamilyBold };
  }, [locale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
