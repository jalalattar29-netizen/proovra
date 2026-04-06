"use client";

import { apiFetch } from "./api";
import { CONSENT_VERSION, saveConsentState } from "./consent";

type CookieConsentApi = {
  run: (config: unknown) => void;
  showPreferences: () => void;
  getUserPreferences?: () => {
    acceptType?: string;
    acceptedCategories?: string[];
  };
};

type CookieConsentImport = {
  default?: CookieConsentApi;
} & Partial<CookieConsentApi>;

function pickDefault<T>(mod: CookieConsentImport): T {
  return ((mod.default ?? mod) as unknown) as T;
}

function buildAcceptedState(categories: string[] = []) {
  return {
    necessary: true,
    preferences: categories.includes("preferences"),
    analytics: categories.includes("analytics"),
    marketing: categories.includes("marketing"),
    consentVersion: CONSENT_VERSION,
  };
}

async function persistConsent(categories: string[] = []) {
  const next = buildAcceptedState(categories);
  saveConsentState(next);

  try {
    await apiFetch("/v1/users/cookie-consent", {
      method: "POST",
      body: JSON.stringify(next),
    });
  } catch {
    // keep local consent even if backend persistence fails
  }
}

export async function initCookieConsent(): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const w = window as unknown as {
    __PROOVRA_CC_INITIALIZED__?: boolean;
    __PROOVRA_COOKIE_CONSENT__?: CookieConsentApi;
  };

  if (w.__PROOVRA_CC_INITIALIZED__) return;
  w.__PROOVRA_CC_INITIALIZED__ = true;

  const mod = (await import("vanilla-cookieconsent")) as unknown as CookieConsentImport;
  const cc = pickDefault<CookieConsentApi>(mod);

  if (!cc || typeof cc.run !== "function") {
    console.warn("[cookie-consent] library loaded but .run is missing");
    return;
  }

  w.__PROOVRA_COOKIE_CONSENT__ = cc;

  window.addEventListener("proovra:open-cookie-preferences", () => {
    try {
      w.__PROOVRA_COOKIE_CONSENT__?.showPreferences();
    } catch {
      // ignore
    }
  });

  cc.run({
    revision: 1,
    guiOptions: {
      consentModal: {
        layout: "box",
        position: "bottom right",
        equalWeightButtons: true,
      },
      preferencesModal: {
        layout: "box",
        equalWeightButtons: true,
      },
    },
    categories: {
      necessary: {
        enabled: true,
        readOnly: true,
      },
      preferences: {
        enabled: false,
        readOnly: false,
      },
      analytics: {
        enabled: false,
        readOnly: false,
      },
      marketing: {
        enabled: false,
        readOnly: false,
      },
    },
    onFirstConsent: async ({ cookie }: any) => {
      const accepted = Array.isArray(cookie?.categories) ? cookie.categories : [];
      await persistConsent(accepted);
    },
    onConsent: async ({ cookie }: any) => {
      const accepted = Array.isArray(cookie?.categories) ? cookie.categories : [];
      await persistConsent(accepted);
    },
    onChange: async ({ cookie }: any) => {
      const accepted = Array.isArray(cookie?.categories) ? cookie.categories : [];
      await persistConsent(accepted);
    },
    language: {
      default: "en",
      translations: {
        en: {
          consentModal: {
            title: "Cookie preferences",
            description:
              "We use necessary cookies to run PROOVRA. Optional preferences, analytics, and marketing cookies are only enabled if you allow them.",
            acceptAllBtn: "Accept all",
            acceptNecessaryBtn: "Reject optional",
            showPreferencesBtn: "Manage preferences",
          },
          preferencesModal: {
            title: "Manage cookie preferences",
            acceptAllBtn: "Accept all",
            acceptNecessaryBtn: "Reject optional",
            savePreferencesBtn: "Save preferences",
            sections: [
              {
                title: "Necessary cookies",
                description:
                  "Required for core website and account functionality. These cannot be disabled.",
                linkedCategory: "necessary",
              },
              {
                title: "Preferences cookies",
                description:
                  "Remember non-essential preferences such as display choices or other convenience settings.",
                linkedCategory: "preferences",
              },
              {
                title: "Analytics cookies",
                description:
                  "Help us understand product usage and improve performance, reliability, and usability.",
                linkedCategory: "analytics",
              },
              {
                title: "Marketing cookies",
                description:
                  "Used only if PROOVRA later enables campaign attribution or marketing-related technologies.",
                linkedCategory: "marketing",
              },
            ],
          },
        },
      },
    },
  });
}