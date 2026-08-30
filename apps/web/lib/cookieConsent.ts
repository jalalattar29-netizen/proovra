"use client";

import { apiFetch } from "./api";
import {
  CONSENT_VERSION,
  clearNonEssentialStorage,
  getConsentState,
  saveConsentState,
} from "./consent";

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
  /** See the call site: bot-hiding also skips DOM creation entirely. */
  hideFromBots: boolean;
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
          footer?: string;
        };
        preferencesModal: {
          title: string;
          acceptAllBtn: string;
          acceptNecessaryBtn: string;
          savePreferencesBtn: string;
          closeIconLabel?: string;
          sections: Array<{
            title: string;
            description: string;
            linkedCategory?:
              | "necessary"
              | "preferences"
              | "analytics"
              | "marketing";
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
  const previous = getConsentState();
  const next = buildAcceptedState(categories);
  saveConsentState(next);

  clearNonEssentialStorage({
    preferences: previous.preferences && !next.preferences,
    analytics: previous.analytics && !next.analytics,
    marketing: previous.marketing && !next.marketing,
  });

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
    /** Outcome of the last open attempt, so a caller can report a failure. */
    __PROOVRA_CC_LAST_RESULT__?: { ok: boolean; error: string | null };
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
      /*
       * A FAILURE HERE USED TO BE INVISIBLE.
       *
       * This was `try { showPreferences() } catch { /* ignore *\/ }`, so when
       * the modal could not open the person who asked for it got nothing at
       * all: no dialog, no message, no console error. "I click it and nothing
       * happens" was the literal, complete behaviour.
       *
       * The outcome is reported back on the event so the surface that asked
       * can say so. Nothing is thrown at the window — this runs inside a
       * listener, where a throw would only reach the console.
       */
      const detail = w.__PROOVRA_CC_LAST_RESULT__ ?? { ok: false, error: null };
      try {
        const api = w.__PROOVRA_COOKIE_CONSENT__;
        if (!api || typeof api.showPreferences !== "function") {
          detail.ok = false;
          detail.error = "unavailable";
        } else {
          api.showPreferences();
          detail.ok = true;
          detail.error = null;
        }
      } catch (error) {
        detail.ok = false;
        detail.error = error instanceof Error ? error.message : "failed";
      }
      w.__PROOVRA_CC_LAST_RESULT__ = detail;
      window.dispatchEvent(
        new CustomEvent("proovra:cookie-preferences-result", { detail }),
      );
    };

    window.addEventListener(
      "proovra:open-cookie-preferences",
      w.__PROOVRA_CC_PREFS_HANDLER__
    );
  }

  cc.run({
    /*
     * BOT-HIDING OFF, DELIBERATELY.
     *
     * `hideFromBots` defaults to true in vanilla-cookieconsent v3, and it does
     * not merely suppress the AUTO-SHOWN banner: it skips building the consent
     * DOM at all. `showPreferences()` then throws
     * "Cannot read properties of undefined (reading 'addEventListener')"
     * because the modal it wants to open was never created.
     *
     * That breaks the one entry point a person has to their OWN cookie
     * preferences — Settings → Privacy & data → Manage cookie preferences —
     * for anybody the heuristic misfires on. The heuristic is
     * `navigator.webdriver` plus a user-agent pattern, so it catches
     * automation, some hardened and privacy-hardened browsers, and anything
     * presenting an unusual UA. Those are exactly the people most likely to
     * come looking for this control.
     *
     * Keeping a crawler out of a cookie banner is worth very little. Silently
     * denying a user the ability to review and change their own consent is
     * worth a great deal less, and it is a control we are obliged to keep
     * reachable. The banner itself is still gated by consent state, so this
     * does not show it to anyone who has already answered.
     */
    hideFromBots: false,
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
            title: "Privacy Preferences",
            description:
              "Manage how PROOVRA uses cookies and similar technologies. Strictly necessary technologies keep authentication, security, evidence verification, and core platform functions working. Optional technologies are used only with your consent.",
            acceptAllBtn: "Accept all",
            acceptNecessaryBtn: "Reject all",
            showPreferencesBtn: "Manage preferences",
            footer:
              '<a href="/legal/cookies">Cookie Policy</a>\n<a href="/legal/privacy">Privacy Policy</a>\n<a href="/trust">Trust Center</a>',
          },
          preferencesModal: {
            title: "Privacy Preferences",
            acceptAllBtn: "Accept all",
            acceptNecessaryBtn: "Reject all",
            savePreferencesBtn: "Save preferences",
            closeIconLabel: "Close privacy preferences",
            sections: [
              {
                title: "Manage your privacy",
                description:
                  'Manage how PROOVRA uses cookies and similar technologies. Strictly necessary technologies keep authentication, security, evidence verification, and core platform functions working. Optional technologies are used only with your consent. Learn more in our <a href="/legal/cookies">Cookie Policy</a>, <a href="/legal/privacy">Privacy Policy</a>, and at our <a href="/trust">Trust Center</a>.',
              },
              {
                title: "Strictly Necessary",
                description:
                  "Required for authentication, security, fraud prevention, evidence verification, session management, and essential platform functionality. These cannot be disabled.",
                linkedCategory: "necessary",
              },
              {
                title: "Functional Preferences",
                description:
                  "Remember language, interface preferences, dismissed guidance, and similar usability settings.",
                linkedCategory: "preferences",
              },
              {
                title: "Analytics",
                description:
                  "Help us understand product usage and improve performance using privacy-minimized analytics. Evidence content, verification tokens, filenames, hashes, GPS data, and case metadata are not used for analytics. Reliability and error monitoring used to detect and fix technical issues are included in this category; sensitive routes and identifiers are redacted before any report is sent.",
                linkedCategory: "analytics",
              },
              {
                title: "Marketing",
                description:
                  "Currently not used unless explicitly enabled in the future. Marketing trackers are off by default.",
                linkedCategory: "marketing",
              },
            ],
          },
        },
      },
    },
  });
}