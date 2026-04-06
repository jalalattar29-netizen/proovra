"use client";

import { useEffect, useState } from "react";

const CONSENT_KEY = "proovra_cookie_consent";

type Consent = {
  necessary: true;
  analytics: boolean;
};

export function CookieBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const existing = localStorage.getItem(CONSENT_KEY);
    if (!existing) setVisible(true);
  }, []);

  const saveConsent = async (consent: Consent) => {
    localStorage.setItem(CONSENT_KEY, JSON.stringify(consent));

    window.dispatchEvent(new Event("proovra:consent-updated"));

    try {
      await fetch("/v1/users/cookie-consent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          consentVersion: "2026-04-06",
          necessary: true,
          analytics: consent.analytics,
        }),
      });
    } catch {
      console.warn("cookie consent sync failed");
    }

    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="cookie-banner">
      <div className="cookie-box">
        <p>
          We use cookies for security and functionality. Analytics only with your consent.
        </p>

        <div className="cookie-actions">
          <button onClick={() => saveConsent({ necessary: true, analytics: false })}>
            Reject
          </button>

          <button onClick={() => saveConsent({ necessary: true, analytics: true })}>
            Accept All
          </button>
        </div>
      </div>
    </div>
  );
}