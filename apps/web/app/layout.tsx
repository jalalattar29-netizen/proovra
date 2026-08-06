import type { Metadata } from "next";
import type { ReactNode } from "react";
import { FONT_STRATEGY, headerFont, jakarta, notoArabic } from "./fonts";
import "./globals.css";
import { Providers } from "./providers";
import CookieConsentInit from "./CookieConsentInit";
import PrivacyPreferencesLauncher from "../components/privacy/PrivacyPreferencesLauncher";

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

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html
      lang="en"
      dir="ltr"
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
      </head>

<body className="antialiased" style={{ fontFamily: "var(--font-jakarta)" }}>
        <CookieConsentInit />
        <Providers>{children}</Providers>
        <PrivacyPreferencesLauncher />
      </body>
    </html>
  );
}
