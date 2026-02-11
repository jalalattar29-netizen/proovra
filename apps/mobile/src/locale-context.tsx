import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { type Locale, type LocaleMode, translations, resolveInitialLocale } from "./i18n";

declare global {
  // eslint-disable-next-line no-var
  var __PROOVRA_LOCALE: Locale | undefined;
}

type LocaleContextValue = {
  locale: Locale;
  mode: LocaleMode;
  setLocale: (locale: Locale) => void;
  setLocaleMode: (mode: LocaleMode) => void;
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
  const [mode, setModeState] = useState<LocaleMode>("auto");
  const [ready, setReady] = useState(false);

  // Initialize from AsyncStorage on mount
  useEffect(() => {
    const initializeLocale = async () => {
      try {
        // Read both keys from AsyncStorage
        const storedMode = (await AsyncStorage.getItem("proovra-locale-mode")) as LocaleMode | null;
        const storedLocale = await AsyncStorage.getItem("proovra-locale");
        
        // Determine initial locale and mode
        let initialLocale: Locale = "en";
        let initialMode: LocaleMode = "auto";
        
        if (storedMode === "manual" && storedLocale) {
          // User set manual mode with a specific locale
          initialLocale = storedLocale as Locale;
          initialMode = "manual";
        } else if (storedMode === "auto" || !storedMode) {
          // Auto mode or first launch - resolve device language
          const { locale: deviceLocale } = resolveInitialLocale();
          initialLocale = deviceLocale;
          initialMode = "auto";
        }
        
        setLocaleState(initialLocale);
        setModeState(initialMode);
        globalThis.__PROOVRA_LOCALE = initialLocale;
        setReady(true);
      } catch (error) {
        // Fall back to EN if AsyncStorage fails
        console.warn("Failed to initialize locale from AsyncStorage:", error);
        setLocaleState("en");
        setModeState("auto");
        globalThis.__PROOVRA_LOCALE = "en";
        setReady(true);
      }
    };
    
    void initializeLocale();
  }, []);

  // Persist locale and mode to AsyncStorage whenever they change
  useEffect(() => {
    if (!ready) return;
    
    const persistLocale = async () => {
      try {
        await AsyncStorage.setItem("proovra-locale", locale);
        await AsyncStorage.setItem("proovra-locale-mode", mode);
      } catch (error) {
        console.warn("Failed to persist locale to AsyncStorage:", error);
      }
    };
    
    void persistLocale();
  }, [locale, mode, ready]);

  const setLocale = (newLocale: Locale) => {
    setLocaleState(newLocale);
    globalThis.__PROOVRA_LOCALE = newLocale;
  };

  const setLocaleMode = (newMode: LocaleMode) => {
    setModeState(newMode);
    if (newMode === "auto") {
      // When switching to auto mode, resolve device language
      const { locale: deviceLocale } = resolveInitialLocale();
      setLocaleState(deviceLocale);
      globalThis.__PROOVRA_LOCALE = deviceLocale;
    }
  };

  const value = useMemo<LocaleContextValue>(() => {
    const isRTL = locale === "ar";
    const currentTranslations = translations[locale] || translations.en;
    const t = (key: keyof (typeof translations)["en"]) =>
      (currentTranslations[key as keyof (typeof translations)[Locale]] as string) ||
      (translations.en[key] as string);
    const fontFamily = isRTL ? "Noto Sans Arabic" : "Inter";
    const fontFamilyBold = isRTL ? "Noto Sans Arabic" : "Inter";
    return { locale, mode, setLocale, setLocaleMode, t, isRTL, fontFamily, fontFamilyBold };
  }, [locale, mode]);

  if (!ready) {
    // Don't render until AsyncStorage is initialized
    return null;
  }

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
