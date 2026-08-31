"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

import { isTrackablePublicPath, sanitizePublicPath } from "../../lib/analytics-public-paths";

/**
 * Public marketing page-view beacon.
 *
 * Mounts on public marketing pages (home, /platform, /pricing, /trust, /faq,
 * /login, /register, /request-demo, /contact-sales, /about, /technology, …).
 * On mount / path change it fires a single `page_view` AnalyticsEvent so the
 * admin dashboard's Countries + Top-pages panels populate.
 *
 * Guarantees:
 *   - Consent: delegates entirely to `trackEvent`, which no-ops unless
 *     hasAnalyticsConsent() is true. This component NEVER bypasses that gate.
 *     `trackEvent` is loaded lazily so no analytics code runs before consent
 *     even matters.
 *   - Token safety: only the SANITIZED route (query + hash stripped) is sent,
 *     and only when isTrackablePublicPath() allows it — the verify / share /
 *     intake / portal / auth / invite token families are never emitted. The
 *     server independently rejects them too (defense in depth).
 *   - No raw IP: the client sends no IP; the server derives countryCode from
 *     the edge header (cf-ipcountry / x-vercel-ip-country) at ingest.
 */
export default function PublicPageView() {
  const pathname = usePathname();
  const lastSent = useRef<string | null>(null);

  useEffect(() => {
    const path = sanitizePublicPath(pathname);
    if (!path) return;
    if (!isTrackablePublicPath(path)) return;
    // One event per logical route. `usePathname` does not change for
    // query-string or hash-only navigation, and the sanitizer strips both
    // anyway, so neither re-fires this.
    if (lastSent.current === path) return;

    /*
     * CLAIM THE PATH BEFORE SENDING, BUT BE ABLE TO GIVE IT BACK.
     *
     * Claiming first is what stops two overlapping effects racing out two
     * events for one navigation. On its own, though, it loses the event
     * entirely under `reactStrictMode`, which mounts, cleans up and mounts
     * again: the first pass claimed the path and was then cancelled mid-import
     * before it sent anything, and the second pass saw its own claim and
     * returned. Both passes did nothing, so a beacon that reads as "fires
     * once" actually fired never in development.
     *
     * So a claim that never became a send is released on cleanup, and the
     * remount sends exactly once.
     */
    const previous = lastSent.current;
    lastSent.current = path;

    let cancelled = false;
    let sent = false;
    void (async () => {
      try {
        const { trackEvent } = await import("../../lib/analytics");
        if (cancelled) return;
        sent = true;
        // trackEvent is consent-gated; it no-ops when analytics consent is off.
        await trackEvent("page_view", { path }, { pathname: path });
      } catch {
        // Analytics is best-effort; never surface to the user. `sent` stays
        // true: a failed beacon is not retried, it is dropped.
      }
    })();

    return () => {
      cancelled = true;
      if (!sent) lastSent.current = previous;
    };
  }, [pathname]);

  return null;
}
