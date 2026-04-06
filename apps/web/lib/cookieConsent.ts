"use client";

import { apiFetch } from "./api";
import { CONSENT_VERSION, saveConsentState } from "./consent";

type CookieConsentCategories = {
  categories?: string[];
};

type CookieConsentCallbackPayload = {
  cookie?: CookieConsentCategories;
};

type CookieConsentApi = {
  run: (config: CookieConsentConfig) => void;
  showPreferences: () => void;
  getUserPreferences?: () => {
    acceptType?: string;
    acceptedCategories?: string[];
  };
};

type CookieConsentImport = {
  default?: CookieConsentApi;
} & Partial<CookieConsentApi>;

type CookieConsentConfig = {
  revision: number;
  guiOptions: {
    consentModal: {
      layout: string;
      position: string;
      equalWeightButtons: boolean;
    };
    preferencesModal: {
      layout: string;
      equalWeightButtons: boolean;
    };
  };
  categories: {
    necessary: {
      enabled: boolean;
      readOnly: boolean;
    };
    preferences: {
      enabled: boolean;
      readOnly: boolean;
    };
    analytics: {
      enabled: boolean;
      readOnly: boolean;
    };
    marketing: {
      enabled: boolean;
      readOnly: boolean;
    };
  };
  onFirstConsent: (payload: CookieConsentCallbackPayload) => Promise<void>;
  onConsent: (payload: CookieConsentCallbackPayload) => Promise<void>;
  onChange: (payload: CookieConsentCallbackPayload) => Promise<void>;
  language: {
    default: string;
    translations: {
      en: {
        consentModal: {
          title: string;
          description: string;
          acceptAllBtn: string;
          acceptNecessaryBtn: string;
          showPreferencesBtn: string;
        };
        preferencesModal: {
          title: string;
          acceptAllBtn: string;
          acceptNecessaryBtn: string;
          savePreferencesBtn: string;
          sections: Array<{
            title: string;
            description: string;
            linkedCategory: "necessary" | "preferences" | "analytics" | "marketing";
          }>;
        };
      };
    };
  };
};

function pickDefault<T>(mod: CookieConsentImport): T {
  return (mod.default ?? mod) as unknown as T;
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

function extractAcceptedCategories(payload: CookieConsentCallbackPayload): string[] {
  return Array.isArray(payload.cookie?.categories) ? payload.cookie.categories : [];
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

  const w = window as Window & {
    __PROOVRA_CC_INITIALIZED__?: boolean;
    __PROOVRA_COOKIE_CONSENT__?: CookieConsentApi;
    __PROOVRA_CC_PREFS_HANDLER__?: () => void;
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

  if (!w.__PROOVRA_CC_PREFS_HANDLER__) {
    w.__PROOVRA_CC_PREFS_HANDLER__ = () => {
      try {
        w.__PROOVRA_COOKIE_CONSENT__?.showPreferences();
      } catch {
        // ignore
      }
    };

    window.addEventListener(
      "proovra:open-cookie-preferences",
      w.__PROOVRA_CC_PREFS_HANDLER__
    );
  }

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
    onFirstConsent: async (payload: CookieConsentCallbackPayload) => {
      await persistConsent(extractAcceptedCategories(payload));
    },
    onConsent: async (payload: CookieConsentCallbackPayload) => {
      await persistConsent(extractAcceptedCategories(payload));
    },
    onChange: async (payload: CookieConsentCallbackPayload) => {
      await persistConsent(extractAcceptedCategories(payload));
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