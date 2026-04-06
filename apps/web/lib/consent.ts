"use client";

export type ConsentCategory = "necessary" | "preferences" | "analytics" | "marketing";

type ConsentState = {
  necessary: boolean;
  preferences: boolean;
  analytics: boolean;
  marketing: boolean;
  consentVersion: string;
  updatedAt?: string;
};

const CONSENT_STORAGE_KEY = "proovra-cookie-consent-state";
export const CONSENT_VERSION = "2026-04-06";

function getDefaultConsentState(): ConsentState {
  return {
    necessary: true,
    preferences: false,
    analytics: false,
    marketing: false,
    consentVersion: CONSENT_VERSION,
  };
}

function readLocalConsent(): ConsentState {
  if (typeof window === "undefined") {
    return getDefaultConsentState();
  }

  try {
    const raw = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) {
      return getDefaultConsentState();
    }

    const parsed = JSON.parse(raw) as Partial<ConsentState>;

    return {
      necessary: true,
      preferences: parsed.preferences === true,
      analytics: parsed.analytics === true,
      marketing: parsed.marketing === true,
      consentVersion:
        typeof parsed.consentVersion === "string" && parsed.consentVersion.trim()
          ? parsed.consentVersion
          : CONSENT_VERSION,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    };
  } catch {
    return getDefaultConsentState();
  }
}

export function getConsentState(): ConsentState {
  return readLocalConsent();
}

export function hasNecessaryConsent(): boolean {
  return true;
}

export function hasPreferencesConsent(): boolean {
  return readLocalConsent().preferences === true;
}

export function hasAnalyticsConsent(): boolean {
  return readLocalConsent().analytics === true;
}

export function hasMarketingConsent(): boolean {
  return readLocalConsent().marketing === true;
}

export function saveConsentState(next: Omit<ConsentState, "updatedAt">): void {
  if (typeof window === "undefined") return;

  const value: ConsentState = {
    necessary: true,
    preferences: next.preferences === true,
    analytics: next.analytics === true,
    marketing: next.marketing === true,
    consentVersion: next.consentVersion || CONSENT_VERSION,
    updatedAt: new Date().toISOString(),
  };

  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // ignore
  }

  window.dispatchEvent(
    new CustomEvent("proovra:consent-updated", {
      detail: value,
    })
  );
}

export function openCookiePreferences(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("proovra:open-cookie-preferences"));
}