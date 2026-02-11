import { dict, defaultLocale, supportedLocales, type Locale } from "@proovra/shared";

export const translations = dict;
export { defaultLocale, supportedLocales };
export type { Locale };

export type LocaleMode = "auto" | "manual";

export function getDeviceLocale(): Locale {
  if (typeof navigator === "undefined") return defaultLocale;
  
  const lang = navigator.language.toLowerCase();
  
  // Check for exact matches first
  if (lang === "ar" || lang.startsWith("ar-")) return "ar";
  if (lang === "de" || lang.startsWith("de-")) return "de";
  if (lang === "fr" || lang.startsWith("fr-")) return "fr";
  if (lang === "es" || lang.startsWith("es-")) return "es";
  if (lang === "tr" || lang.startsWith("tr-")) return "tr";
  if (lang === "ru" || lang.startsWith("ru-")) return "ru";
  if (lang === "en" || lang.startsWith("en-")) return "en";
  
  // Fallback to default locale
  return defaultLocale;
}

export function resolveInitialLocale(): { locale: Locale; mode: LocaleMode } {
  // Try localStorage first
  if (typeof localStorage !== "undefined") {
    const storedMode = localStorage.getItem("proovra-locale-mode") as LocaleMode | null;
    const storedLocale = localStorage.getItem("proovra-locale");
    
    // If manual mode and valid locale stored, use it
    if (storedMode === "manual" && storedLocale && supportedLocales.includes(storedLocale as Locale)) {
      return { locale: storedLocale as Locale, mode: "manual" };
    }
    
    // If auto mode or no valid stored locale, resolve device language
    if (storedMode === "auto") {
      return { locale: getDeviceLocale(), mode: "auto" };
    }
  }
  
  // Default to auto mode with device language
  return { locale: getDeviceLocale(), mode: "auto" };
}


