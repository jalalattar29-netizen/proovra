"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";

const CONSENT_KEY = "proovra_cookie_consent";
const CONSENT_VERSION = "2026-04-06";
const CONSENT_EVENT = "proovra:consent-updated";

type Consent = {
  consentVersion: string;
  necessary: true;
  preferences: boolean;
  analytics: boolean;
  marketing: boolean;
  updatedAt: string;
};

function readStoredConsent(): Consent | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Consent>;

    if (!parsed || typeof parsed !== "object") return null;

    return {
      consentVersion:
        typeof parsed.consentVersion === "string"
          ? parsed.consentVersion
          : CONSENT_VERSION,
      necessary: true,
      preferences: Boolean(parsed.preferences),
      analytics: Boolean(parsed.analytics),
      marketing: Boolean(parsed.marketing),
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function saveStoredConsent(consent: Consent) {
  localStorage.setItem(CONSENT_KEY, JSON.stringify(consent));
  window.dispatchEvent(new Event(CONSENT_EVENT));
}

export function CookieBanner() {
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);

  const [preferences, setPreferences] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    const existing = readStoredConsent();
    if (!existing || existing.consentVersion !== CONSENT_VERSION) {
      setVisible(true);
      if (existing) {
        setPreferences(existing.preferences);
        setAnalytics(existing.analytics);
        setMarketing(existing.marketing);
      }
    }
  }, []);

  const syncConsent = async (consent: Consent) => {
    try {
      await apiFetch("/v1/users/cookie-consent", {
        method: "POST",
        body: JSON.stringify({
          consentVersion: consent.consentVersion,
          necessary: consent.necessary,
          preferences: consent.preferences,
          analytics: consent.analytics,
          marketing: consent.marketing,
        }),
      });
    } catch {
      // local consent remains authoritative until user session sync succeeds
    }
  };

  const commitConsent = async (next: {
    preferences: boolean;
    analytics: boolean;
    marketing: boolean;
  }) => {
    const consent: Consent = {
      consentVersion: CONSENT_VERSION,
      necessary: true,
      preferences: next.preferences,
      analytics: next.analytics,
      marketing: next.marketing,
      updatedAt: new Date().toISOString(),
    };

    setSaving(true);
    try {
      saveStoredConsent(consent);
      await syncConsent(consent);
      setVisible(false);
    } finally {
      setSaving(false);
    }
  };

  const acceptAll = async () => {
    await commitConsent({
      preferences: true,
      analytics: true,
      marketing: true,
    });
  };

  const rejectOptional = async () => {
    await commitConsent({
      preferences: false,
      analytics: false,
      marketing: false,
    });
  };

  const savePreferences = async () => {
    await commitConsent({
      preferences,
      analytics,
      marketing,
    });
  };

  if (!visible) return null;

  return (
    <div className="cookie-banner" role="dialog" aria-modal="true" aria-labelledby="cookie-banner-title">
      <div className="cookie-box">
        <h3 id="cookie-banner-title" style={{ marginTop: 0, marginBottom: 10 }}>
          Cookie preferences
        </h3>

        <p style={{ margin: 0, lineHeight: 1.65 }}>
          We use strictly necessary cookies required for core functionality.
          Optional preferences, analytics, and marketing cookies are only enabled
          if you allow them. You can change your preferences at any time. Learn
          more in our{" "}
          <Link href="/legal/cookies">
            Cookie Policy
          </Link>.
        </p>

        {showPreferences && (
          <div
            style={{
              display: "grid",
              gap: 12,
              marginTop: 16,
              paddingTop: 12,
              borderTop: "1px solid rgba(255,255,255,0.12)",
            }}
          >
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontWeight: 700 }}>Strictly necessary</span>
              <span style={{ fontSize: 13, opacity: 0.82 }}>
                Required for security, authentication, and essential site functionality.
              </span>
              <input type="checkbox" checked readOnly disabled />
            </label>

            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontWeight: 700 }}>Preferences</span>
              <span style={{ fontSize: 13, opacity: 0.82 }}>
                Remembers display and usability choices.
              </span>
              <input
                type="checkbox"
                checked={preferences}
                onChange={(e) => setPreferences(e.target.checked)}
                disabled={saving}
              />
            </label>

            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontWeight: 700 }}>Analytics</span>
              <span style={{ fontSize: 13, opacity: 0.82 }}>
                Helps us understand usage and improve product performance.
              </span>
              <input
                type="checkbox"
                checked={analytics}
                onChange={(e) => setAnalytics(e.target.checked)}
                disabled={saving}
              />
            </label>

            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontWeight: 700 }}>Marketing</span>
              <span style={{ fontSize: 13, opacity: 0.82 }}>
                Supports optional campaign measurement and outreach.
              </span>
              <input
                type="checkbox"
                checked={marketing}
                onChange={(e) => setMarketing(e.target.checked)}
                disabled={saving}
              />
            </label>
          </div>
        )}

        <div className="cookie-actions" style={{ marginTop: 16 }}>
          <button type="button" onClick={acceptAll} disabled={saving}>
            Accept all
          </button>

          <button type="button" onClick={rejectOptional} disabled={saving}>
            Reject optional
          </button>

          <button
            type="button"
            onClick={() => {
              if (showPreferences) {
                void savePreferences();
              } else {
                setShowPreferences(true);
              }
            }}
            disabled={saving}
          >
            {showPreferences ? "Save preferences" : "Manage preferences"}
          </button>
        </div>
      </div>
    </div>
  );
}