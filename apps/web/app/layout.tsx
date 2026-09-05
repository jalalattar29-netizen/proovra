import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { FONT_STRATEGY, headerFont, jakarta, notoArabic } from "./fonts";
import "./globals.css";
import { Providers } from "./providers";
import CookieConsentInit from "./CookieConsentInit";
import PrivacyPreferencesLauncher from "../components/privacy/PrivacyPreferencesLauncher";
import { apiBaseUrl } from "../lib/api";
import { directionFor, localeFromCookies } from "../lib/i18n";

/**
 * The API's ORIGIN, from the one authority that knows it.
 *
 * Never a literal and never an env read of its own: `apiBaseUrl()` is where
 * the base URL is decided, and a second opinion here would preconnect to the
 * wrong host in exactly the deployments where it matters most.
 */
const API_ORIGIN = (() => {
  try {
    return new URL(apiBaseUrl()).origin;
  } catch {
    return null;
  }
})();

// Browser-tab + Apple-touch + PWA icons all resolve through Next.js's
// app-router icon convention: `app/icon.png` → /icon, `app/apple-icon.png`
// → /apple-icon. Both files are byte-for-byte copies of the canonical
// brand mark (`public/assets/branding/proovra-mark.png`). The web
// manifest also points at the same source asset so the PWA install
// icon stays in lockstep with the browser tab icon.
/**
 * PHASE 12 — POINT 7 (final pass): a per-request nonce requires a per-request
 * render.
 *
 * The strict CSP is nonce-based, and the middleware mints a fresh nonce for
 * every response. A statically prerendered page is HTML produced at BUILD
 * time, when no request and therefore no nonce exists — `login.html` in the
 * build output literally recorded `"nonce":"$undefined"` on every script. The
 * browser was then told to require a nonce that the HTML it received could
 * never carry, so `script-src 'self' 'nonce-…'` blocked every inline script
 * and NOTHING hydrated anywhere in the app.
 *
 * `/login` merely made it visible: its whole body is `<Suspense
 * fallback={null}>` over a client component, so a page that could not hydrate
 * had nothing at all to show. `/` and `/legal/*` looked fine and were equally
 * non-interactive.
 *
 * CACHING CONSEQUENCE, recorded rather than glossed: this opts the app out of
 * static prerendering — 65 routes were `○ (Static)` before. That is the cost
 * of a nonce-based policy and it is the correct trade here, because this is an
 * authenticated evidence product whose pages are context-sensitive; the
 * marketing and legal pages are the only genuinely static ones, and shipping
 * them uncached is cheaper than shipping an application that does not run.
 * The alternative — `'unsafe-inline'` — is not a trade, it is the removal of
 * the protection.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: {
    default: "PROOVRA",
    template: "%s | PROOVRA",
  },
  description: "Digital evidence infrastructure for high-trust operations.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/assets/branding/proovra-mark.png",
    shortcut: "/assets/branding/proovra-mark.png",
    apple: "/assets/branding/proovra-mark.png",
  },
};

/**
 * PHASE 7 — THE DOCUMENT SHIPS WITH THE RIGHT DIRECTION ON IT.
 *
 * This element was `<html lang="en" dir="ltr">` unconditionally, and a client
 * effect in `providers.tsx` corrected it after hydration. `dir` drives every
 * logical property in the stylesheet, so for an Arabic operator the first
 * frame of every page — a cold load of an Admin URL included — was the entire
 * console laid out left-to-right, and then it mirrored: the sidebar crossed
 * the viewport, every table's columns reversed, every card's border-inline
 * rule moved side.
 *
 * The server cannot read `localStorage`, which is why the preference could
 * only be applied after hydration. It can read a COOKIE, so the locale is now
 * mirrored into one (same preferences-consent gate, same value, expired with
 * the stored keys when consent is withdrawn) and this renders from it.
 *
 * `force-dynamic` above is what makes this possible at all: a prerendered
 * document is HTML produced at build time, with no request and therefore no
 * cookie to read.
 */
export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const jar = await cookies();
  const { locale } = localeFromCookies((name) => jar.get(name)?.value);

  return (
    <html
      lang={locale}
      dir={directionFor(locale)}
      className={`${jakarta.variable} ${headerFont.variable} ${notoArabic.variable}`}
      // Which font strategy produced those variables. Rendered so a run can
      // ASSERT it rather than infer it from whether a request was blocked.
      data-font-strategy={FONT_STRATEGY}
    >
      <head>
        {/* Phase 32.5 — mobile viewport. Without this the iOS/Android
            browsers render at desktop-virtual-width and pinch-zoom,
            making touch targets and form inputs unusable. */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, viewport-fit=cover"
        />
        <meta name="theme-color" content="#FFFFFF" />
        {/*
          OPEN THE CONNECTION TO THE API WHILE THE BUNDLE IS STILL PARSING.

          The API is a different origin from the app, so the browser cannot
          reuse the document's connection for it. It also cannot START one
          until something asks: the first request is issued by a provider that
          mounts after the JavaScript has downloaded and parsed, so DNS, TCP
          and TLS all begin from there and land on the critical path.

          Measured in Chrome against a production build, from CDP rather than
          Resource Timing — which zeroes the connection phases for a
          cross-origin response with no `Timing-Allow-Origin`, and would have
          reported this as "0ms server time" and hidden it entirely:

            /v1/platform/context   queued 310ms · connect 309ms · waiting 51ms
            /v1/users/me           queued 310ms · connect 309ms · waiting 18ms

          Every later request showed connect 0ms — they reuse the pooled
          connection. Only the first pay for it, and both of the first two pay
          it in parallel. The server's own time was never the problem: 51ms,
          against a ~650ms observation.

          `preconnect` moves that work into HTML parse, in parallel with the
          script download. It is a hint, not a fetch: it sends no request,
          carries no credentials, and reveals nothing the next line of
          JavaScript would not.

          `crossOrigin` is REQUIRED and is not decoration — the API is called
          with credentials, and a connection opened anonymously is a different
          connection from the one a credentialed request needs, so without it
          the browser opens a second one and the hint buys nothing.
        */}
        {API_ORIGIN ? (
          <link rel="preconnect" href={API_ORIGIN} crossOrigin="use-credentials" />
        ) : null}
      </head>

      <body className="antialiased" style={{ fontFamily: "var(--font-jakarta)" }}>
        <CookieConsentInit />
        <Providers>{children}</Providers>
        <PrivacyPreferencesLauncher />
      </body>
    </html>
  );
}
