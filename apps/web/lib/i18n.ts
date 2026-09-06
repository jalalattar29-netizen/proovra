// Import from the dedicated `@proovra/shared/i18n` subpath, NOT the barrel.
// The `@proovra/shared` barrel re-exports `custody-hash` (and other Node-only
// modules) which `import "node:crypto"`. Webpack follows every barrel
// re-export into the client bundle and fails the build with:
//   UnhandledSchemeError: Reading from "node:crypto" is not handled by plugins.
// The direct subpath import keeps the client bundle to the pure-data i18n
// module (dict + Locale + supportedLocales — zero imports).
import { dict, defaultLocale, supportedLocales, type Locale } from "@proovra/shared/i18n";

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

    // Honour a persisted MANUAL choice (the only way to leave English).
    if (storedMode === "manual" && storedLocale && supportedLocales.includes(storedLocale as Locale)) {
      return { locale: storedLocale as Locale, mode: "manual" };
    }

    // Honour a previously, EXPLICITLY chosen "auto" mode (device
    // language). This is only ever set when a user opts into Auto in the
    // authenticated app switcher — it is never the first-visit default.
    if (storedMode === "auto") {
      return { locale: getDeviceLocale(), mode: "auto" };
    }
  }

  /**
   * THE COOKIE THE SERVER ALREADY RENDERED FROM.
   *
   * The server picks `dir` and `lang` from the mirrored COOKIE — it cannot see
   * localStorage — and this function picked them from localStorage alone. When
   * the two disagreed, the page arrived correctly in Arabic and then flipped
   * to English after hydration: the LTR flash this whole section exists to
   * remove, arriving one frame later than it used to.
   *
   * They normally agree, because a language choice writes both. They come
   * apart when storage is cleared or blocked and the cookie survives — a
   * private window, a browser configured to refuse site data, a person who
   * cleared "cached data" but not cookies. In every one of those the cookie is
   * still an explicit, persisted choice, and honouring it is what the server
   * already did.
   *
   * Read AFTER localStorage, so a live preference still wins, and only for a
   * supported locale.
   */
  if (typeof document !== "undefined") {
    const jar = document.cookie ?? "";
    const read = (name: string) =>
      jar
        .split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith(`${name}=`))
        ?.slice(name.length + 1);
    const cookieMode = read(LOCALE_MODE_COOKIE);
    const cookieLocale = read(LOCALE_COOKIE);
    if (
      cookieMode === "manual" &&
      cookieLocale &&
      supportedLocales.includes(cookieLocale as Locale)
    ) {
      return { locale: cookieLocale as Locale, mode: "manual" };
    }
    if (cookieMode === "auto") return { locale: getDeviceLocale(), mode: "auto" };
  }

  // First visit / no stored preference → ENGLISH. PROOVRA does NOT
  // auto-detect the browser language and never auto-switches away from
  // EN. Any other language is an explicit, persisted user choice.
  return { locale: defaultLocale, mode: "manual" };
}
/* ===========================================================================
 * THE DIRECTION HAS TO BE KNOWN BEFORE THE FIRST PAINT
 * ===========================================================================
 * The root layout rendered `<html dir="ltr">` unconditionally and a client
 * effect corrected it after hydration, so an Arabic operator's first frame of
 * every page — including a cold load of an Admin URL — was the whole console
 * laid out left-to-right, then mirrored. `dir` drives every logical property
 * in the stylesheet, so that is not a subtle flash: the sidebar, every table,
 * every card and every border-inline rule jump across the viewport.
 *
 * `localStorage` cannot fix this, because the server cannot read it. A COOKIE
 * can, so the locale is mirrored into one and the layout renders the correct
 * `dir` and `lang` in the HTML it sends.
 *
 * The cookie carries no more than the localStorage key it mirrors — a
 * language tag — and it is written under the SAME preferences consent gate.
 * Withdrawing that consent expires it along with the stored keys.
 * =========================================================================== */

export const LOCALE_COOKIE = "proovra-locale";
export const LOCALE_MODE_COOKIE = "proovra-locale-mode";

/** Right-to-left scripts among the supported locales. */
export function isRtlLocale(locale: string | null | undefined): boolean {
  return locale === "ar";
}

export function directionFor(locale: string | null | undefined): "ltr" | "rtl" {
  return isRtlLocale(locale) ? "rtl" : "ltr";
}

/**
 * The locale a REQUEST implies, from the mirrored cookies.
 *
 * Deliberately the same decision as `resolveInitialLocale`, minus the
 * `navigator` branch the server does not have: a persisted MANUAL choice wins;
 * an explicit AUTO mode cannot be resolved server-side and falls back to the
 * default, which the client corrects on hydration (the only case that can
 * still move, and it only moves for a user who opted into device-language).
 */
export function localeFromCookies(read: (name: string) => string | undefined): {
  locale: Locale;
  mode: LocaleMode;
} {
  const mode = read(LOCALE_MODE_COOKIE) as LocaleMode | undefined;
  const stored = read(LOCALE_COOKIE);
  if (
    mode === "manual" &&
    stored &&
    supportedLocales.includes(stored as Locale)
  ) {
    return { locale: stored as Locale, mode: "manual" };
  }
  if (mode === "auto") return { locale: defaultLocale, mode: "auto" };
  return { locale: defaultLocale, mode: "manual" };
}

/** One year. A language preference is not a session-scoped thing. */
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Mirror the locale into cookies so the SERVER can render the direction. */
export function writeLocaleCookies(locale: Locale, mode: LocaleMode): void {
  if (typeof document === "undefined") return;
  const attrs = `; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
  document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(locale)}${attrs}`;
  document.cookie = `${LOCALE_MODE_COOKIE}=${encodeURIComponent(mode)}${attrs}`;
}

/** Expire them, for a withdrawal of preferences consent. */
export function clearLocaleCookies(): void {
  if (typeof document === "undefined") return;
  for (const name of [LOCALE_COOKIE, LOCALE_MODE_COOKIE]) {
    document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
  }
}
