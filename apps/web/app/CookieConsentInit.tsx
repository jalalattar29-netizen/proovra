"use client";

import { useEffect } from "react";

type CookieConsentModule = {
  initCookieConsent?: () => Promise<void> | void;
  default?: () => Promise<void> | void;
};

export default function CookieConsentInit() {
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const mod = (await import("../lib/cookieConsent")) as CookieConsentModule;
        if (cancelled) return;

        const init = mod.initCookieConsent ?? mod.default;
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