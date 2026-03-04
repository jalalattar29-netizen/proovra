"use client";

import { useEffect } from "react";

export default function CookieConsentInit() {
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const mod = await import("../lib/cookieConsent");
        if (cancelled) return;

        // يدعم export اسمه initCookieConsent أو default
        const init = (mod as any).initCookieConsent ?? (mod as any).default;
        if (typeof init === "function") {
          await init();
        } else {
          console.warn("[cookie-consent] init function not found in module");
        }
      } catch (err) {
        console.warn("[cookie-consent] init failed", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}