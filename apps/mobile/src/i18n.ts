import { dict, defaultLocale, supportedLocales, type Locale } from "@proovra/shared";

export type { Locale };
export type LocaleMode = "auto" | "manual";
export const translations = dict;

export function getDeviceLocale(): Locale {
  try {
    // Try to use expo-localization if available
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Localization = require("expo-localization");
    const locale = Localization.getLocales()[0]?.languageCode?.toLowerCase();
    if (!locale) return defaultLocale;
    
    if (locale === "ar" || locale.startsWith("ar-")) return "ar";
    if (locale === "de" || locale.startsWith("de-")) return "de";
    if (locale === "fr" || locale.startsWith("fr-")) return "fr";
    if (locale === "es" || locale.startsWith("es-")) return "es";
    if (locale === "tr" || locale.startsWith("tr-")) return "tr";
    if (locale === "ru" || locale.startsWith("ru-")) return "ru";
    if (locale === "en" || locale.startsWith("en-")) return "en";
    
    return defaultLocale;
  } catch {
    // Fallback if expo-localization is not available
    return defaultLocale;
  }
}

export function resolveInitialLocale(deviceLocale?: string): { locale: Locale; mode: LocaleMode } {
  // Use provided device locale or auto-detect
  const lang = deviceLocale ? deviceLocale.slice(0, 2).toLowerCase() : getDeviceLocale();
  
  if (supportedLocales.includes(lang as Locale)) {
    return { locale: lang as Locale, mode: "auto" };
  }
  
  return { locale: defaultLocale, mode: "auto" };
}
