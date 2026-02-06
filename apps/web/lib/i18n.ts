import { dict, defaultLocale, supportedLocales, type Locale } from "@proovra/shared";

export const translations = dict;

export function getDeviceLocale(): Locale {
  if (typeof window === "undefined") return defaultLocale;
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  const normalized = languages
    .filter(Boolean)
    .map((lang) => lang.slice(0, 2).toLowerCase());
  if (normalized.includes("en")) return "en";
  if (normalized.includes("de")) return "de";
  if (normalized.includes("ar")) return "ar";
  return defaultLocale;
}

export function resolveInitialLocale(): Locale {
  if (typeof window === "undefined") return defaultLocale;
  const deviceLocale = getDeviceLocale();
  const stored = localStorage.getItem("proovra-locale");
  if (stored && supportedLocales.includes(stored as Locale)) {
    const storedLocale = stored as Locale;
    if (storedLocale === "en" || storedLocale === deviceLocale) {
      return storedLocale;
    }
    localStorage.removeItem("proovra-locale");
  }
  return deviceLocale;
}
