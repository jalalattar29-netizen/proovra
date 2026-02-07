import { dict, defaultLocale, supportedLocales, type Locale } from "@proovra/shared";

export const translations = dict;
export { defaultLocale, supportedLocales };
export type { Locale };

export function getDeviceLocale(): Locale {
  return "en";
}

export function resolveInitialLocale(): Locale {
  return "en";
}
