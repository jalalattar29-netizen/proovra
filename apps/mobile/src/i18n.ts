import { dict, defaultLocale, supportedLocales, type Locale } from "@proovra/shared";

export const translations = dict;

export function resolveInitialLocale(deviceLocale?: string): Locale {
  const lang = deviceLocale?.slice(0, 2).toLowerCase();
  if (lang === "ar" || lang === "de") return lang;
  return defaultLocale;
}
