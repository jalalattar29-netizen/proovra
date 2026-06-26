"use client";

export type ConsentCategory =
  | "necessary"
  | "preferences"
  | "analytics"
  | "marketing";

export type ConsentState = {
  necessary: boolean;
  preferences: boolean;
  analytics: boolean;
  marketing: boolean;
  consentVersion: string;
  updatedAt?: string;
};

const CONSENT_STORAGE_KEY = "proovra-cookie-consent-state";
const CONSENT_SYNC_PREFIX = "proovra-cookie-consent-synced:";
const CONSENT_EVENT_NAME = "proovra:consent-updated";

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
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    };
  } catch {
    return getDefaultConsentState();
  }
}

export function getConsentState(): ConsentState {
  return readLocalConsent();
}

export function readCookieConsentState(): ConsentState {
  return readLocalConsent();
}

export function getCookieConsentEventName(): string {
  return CONSENT_EVENT_NAME;
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
    new CustomEvent(CONSENT_EVENT_NAME, {
      detail: value,
    })
  );
}

export function isCookieConsentSyncedForUser(userId: string): boolean {
  if (typeof window === "undefined") return false;
  if (!userId.trim()) return false;

  try {
    const key = `${CONSENT_SYNC_PREFIX}${userId}`;
    const value = window.localStorage.getItem(key);
    return value === CONSENT_VERSION;
  } catch {
    return false;
  }
}

export function markCookieConsentSyncedForUser(userId: string): void {
  if (typeof window === "undefined") return;
  if (!userId.trim()) return;

  try {
    const key = `${CONSENT_SYNC_PREFIX}${userId}`;
    window.localStorage.setItem(key, CONSENT_VERSION);
  } catch {
    // ignore
  }
}

export function openCookiePreferences(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("proovra:open-cookie-preferences"));
}

const PREFERENCE_STORAGE_KEYS = [
  "proovra-locale",
  "proovra-locale-mode",
  "proovra-chat-hint-seen",
] as const;

const PREFERENCE_STORAGE_KEY_PREFIXES = [
  "proovra.persona-hint.dismissed:",
  "contextual-help-dismissed:",
  "proovra.persona-setup-dismissed:",
  "capture-readiness-dismissed:",
  "capture-workflow-guidance-dismissed:",
  "capture-suggestions-dismissed:",
  "proovra:search:recent:",
] as const;

const ANALYTICS_STORAGE_KEYS = ["visitor_id"] as const;
const ANALYTICS_SESSION_STORAGE_KEYS = ["session_id"] as const;

function removeMatchingKeys(
  store: Storage,
  exact: ReadonlyArray<string>,
  prefixes: ReadonlyArray<string> = [],
): void {
  for (const key of exact) {
    try {
      store.removeItem(key);
    } catch {
      // ignore
    }
  }

  if (prefixes.length === 0) return;

  const toRemove: string[] = [];
  for (let i = 0; i < store.length; i += 1) {
    const k = store.key(i);
    if (!k) continue;
    if (prefixes.some((prefix) => k.startsWith(prefix))) {
      toRemove.push(k);
    }
  }

  for (const k of toRemove) {
    try {
      store.removeItem(k);
    } catch {
      // ignore
    }
  }
}

export type ClearNonEssentialOptions = {
  preferences?: boolean;
  analytics?: boolean;
  marketing?: boolean;
};

/**
 * Removes non-essential client-side storage when the user withdraws
 * consent. Never touches auth/session, consent record, legal acceptance,
 * or OAuth-return temp state — those are strictly necessary.
 */
export function clearNonEssentialStorage(
  options: ClearNonEssentialOptions = {
    preferences: true,
    analytics: true,
    marketing: true,
  },
): void {
  if (typeof window === "undefined") return;

  try {
    if (options.preferences) {
      removeMatchingKeys(
        window.localStorage,
        PREFERENCE_STORAGE_KEYS,
        PREFERENCE_STORAGE_KEY_PREFIXES,
      );
    }

    if (options.analytics) {
      removeMatchingKeys(window.localStorage, ANALYTICS_STORAGE_KEYS);
      if (typeof window.sessionStorage !== "undefined") {
        removeMatchingKeys(
          window.sessionStorage,
          ANALYTICS_SESSION_STORAGE_KEYS,
        );
      }
    }
    // marketing currently writes no client storage; flag reserved for future
  } catch {
    // ignore
  }
}