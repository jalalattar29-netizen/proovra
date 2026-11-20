import { directionFor } from "./i18n";

/**
 * PRO-PW-10 (DEC-31) — public pages whose body is English-only.
 *
 * These pages render English literals (no `t()`), built with physical
 * left/right utilities. Choosing Arabic set `<html dir="rtl">` around them, so
 * English copy was laid out right-to-left as if it were a translation. On these
 * routes the document keeps `lang="en" dir="ltr"` whatever the chosen locale,
 * and the language menu says the page is English-only (an honest, labelled
 * fallback). Translated surfaces (support, the lead forms, the app) are not
 * listed and follow the chosen locale.
 */
const ENGLISH_ONLY_PUBLIC_PREFIXES = [
  "/about",
  "/platform",
  "/technology",
  "/trust",
  "/why-proovra",
  "/faq",
  "/pricing",
  "/for-compliance",
  "/for-government",
  "/for-insurance",
  "/for-investigations",
  "/for-journalism",
  "/for-lawyers",
  "/legal",
  "/privacy",
  "/terms",
  "/data-retention",
  "/subprocessors",
  "/abuse-reporting",
] as const;

export function isEnglishOnlyPublicPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  if (pathname === "/") return true;
  return ENGLISH_ONLY_PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export { REQUEST_PATHNAME_HEADER } from "./request-pathname-header";

/**
 * PRO-PW-10 (DEC-31) — THE document language and direction for a locale on a
 * path. An English-only public page is `lang="en" dir="ltr"` whatever the
 * chosen locale; elsewhere the locale decides. The server (app/layout.tsx)
 * and the client (app/providers.tsx) both ask this, so the first frame and
 * the hydrated page agree.
 */
export function documentLanguage(
  locale: string,
  pathname: string | null | undefined,
): { lang: string; dir: "ltr" | "rtl" } {
  if (isEnglishOnlyPublicPath(pathname)) return { lang: "en", dir: "ltr" };
  return { lang: locale, dir: directionFor(locale) };
}
