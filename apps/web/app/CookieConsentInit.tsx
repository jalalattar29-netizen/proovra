"use client";

import { useEffect } from "react";

type CookieConsentModule = {
  initCookieConsent?: () => Promise<void> | void;
  default?: () => Promise<void> | void;
};

export default function CookieConsentInit() {
  useEffect(() => {
    let isCancelled = false;

    async function loadOptionalServices() {
      try {
        if (isCancelled) return;

        const { hasAnalyticsConsent } = await import("../lib/consent");
        if (isCancelled) return;

        if (hasAnalyticsConsent()) {
          const { initAnalytics } = await import("../lib/analytics");
          if (isCancelled) return;
          await initAnalytics();
        }
      } catch (error) {
        console.warn("[cookie-consent] optional services init failed", error);
      }
    }

    async function run() {
      try {
        const mod = (await import("../lib/cookieConsent")) as CookieConsentModule;

        if (isCancelled) return;

        const init = mod.initCookieConsent ?? mod.default;

        if (typeof init !== "function") {
          console.warn("[cookie-consent] init function not found in ../lib/cookieConsent");
          return;
        }

        await init();

        if (isCancelled) return;

        await loadOptionalServices();
      } catch (error) {
        console.warn("[cookie-consent] initialization failed", error);
      }
    }

    const handleConsentUpdated = () => {
      void loadOptionalServices();
    };

    void run();
    window.addEventListener("proovra:consent-updated", handleConsentUpdated);

    return () => {
      isCancelled = true;
      window.removeEventListener("proovra:consent-updated", handleConsentUpdated);
    };
  }, []);

  return null;
}