import { dict, defaultLocale, supportedLocales, type Locale } from "@proovra/shared";

export const translations = dict;
export { defaultLocale, supportedLocales };
export type { Locale };

export function getDeviceLocale(): Locale {
  if (typeof navigator === "undefined") return defaultLocale;
  
  const lang = navigator.language.toLowerCase();
  
  // Check for exact matches first
  if (lang === "ar" || lang.startsWith("ar-")) return "ar";
  if (lang === "de" || lang.startsWith("de-")) return "de";
  if (lang === "en" || lang.startsWith("en-")) return "en";
  
  // Fallback to English
  return defaultLocale;
}

export function resolveInitialLocale(): Locale {
  // Try localStorage first
  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem("proovra-locale");
    if (stored && supportedLocales.includes(stored as Locale)) {
      return stored as Locale;
    }
  }
  
  // Fall back to device language
  return getDeviceLocale();
}
