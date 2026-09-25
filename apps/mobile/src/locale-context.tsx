import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { type Locale, type LocaleMode, translations, resolveInitialLocale } from "./i18n";
import { familyFor, type FontWeightToken } from "./theme/fonts";

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
  /** Registered family for body weight (400). See src/theme/fonts.ts. */
  fontFamily: string;
  /** Registered family for bold weight (700). */
  fontFamilyBold: string;
  /** Registered family for a specific weight, script-aware. */
  familyForWeight: (weight: FontWeightToken) => string;
  /**
   * Non-null when the application faces failed to register. The app still
   * renders (in the platform face) rather than refusing to start, but the
   * failure is carried here so a surface can say so instead of silently
   * shipping the wrong typeface — which is precisely how RC-04 went unnoticed.
   */
  fontError: Error | null;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("LocaleContext missing");
  return ctx;
}

export function LocaleProvider({
  children,
  fontError = null,
}: {
  children: React.ReactNode;
  /** Passed down from the root layout, which owns font registration. */
  fontError?: Error | null;
}) {
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
    // T-04 / RC-04 — these were the literals "Inter" / "Noto Sans Arabic".
    // NOTHING was registered under either name, so React Native fell back to
    // the platform face on every screen. familyFor() returns the name of a face
    // this app actually loads (src/theme/fonts.ts), per weight and per script.
    const fontFamily = familyFor("400", isRTL);
    const fontFamilyBold = familyFor("700", isRTL);
    const familyForWeight = (weight: FontWeightToken) => familyFor(weight, isRTL);
    return {
      locale, mode, setLocale, setLocaleMode, t, isRTL,
      fontFamily, fontFamilyBold, familyForWeight, fontError,
    };
  }, [locale, mode, fontError]);

  if (!ready) {
    // Don't render until AsyncStorage is initialized
    return null;
  }

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
