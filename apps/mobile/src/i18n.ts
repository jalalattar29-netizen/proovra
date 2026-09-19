import { NativeModules, Platform } from "react-native";
import { dict, defaultLocale, supportedLocales, type Locale } from "@proovra/shared";

export type { Locale };
export type LocaleMode = "auto" | "manual";
export const translations = dict;

/**
 * Read the device's preferred language subtag (e.g. "en", "ar") from React
 * Native's built-in locale settings: `SettingsManager` on iOS, `I18nManager`
 * elsewhere. Both are React Native core native modules that are always present,
 * so this needs no extra dependency and stays statically analyzable — unlike the
 * previous expo-localization dynamic module lookup, which referenced a package
 * that is NOT installed. Metro baked that unresolved dependency into the bundle
 * as `undefined`, so at runtime Hermes threw `Requiring unknown module
 * "undefined"` (a build-time-resolution failure a surrounding try/catch cannot
 * intercept).
 */
function deviceLanguageCode(): string | undefined {
  try {
    let raw: string | undefined;
    if (Platform.OS === "ios") {
      const settings = NativeModules.SettingsManager?.settings;
      raw = settings?.AppleLocale ?? settings?.AppleLanguages?.[0];
    } else {
      raw = NativeModules.I18nManager?.localeIdentifier;
    }
    // raw is like "en_US" / "ar-SA" / "de_DE" — take the language subtag.
    return raw ? raw.toLowerCase().split(/[-_]/)[0] : undefined;
  } catch {
    return undefined;
  }
}

export function getDeviceLocale(): Locale {
  const code = deviceLanguageCode();
  if (code && supportedLocales.includes(code as Locale)) return code as Locale;
  return defaultLocale;
}

export function resolveInitialLocale(deviceLocale?: string): { locale: Locale; mode: LocaleMode } {
  // Use provided device locale or auto-detect
  const lang = deviceLocale ? deviceLocale.slice(0, 2).toLowerCase() : getDeviceLocale();
  
  if (supportedLocales.includes(lang as Locale)) {
    return { locale: lang as Locale, mode: "auto" };
  }
  
  return { locale: defaultLocale, mode: "auto" };
}
