"use client";

type CookieConsentApi = {
  run: (config: unknown) => void;
};

type CookieConsentImport = {
  default?: CookieConsentApi;
} & Partial<CookieConsentApi>;

function pickDefault<T>(mod: CookieConsentImport): T {
  return ((mod.default ?? mod) as unknown) as T;
}

export async function initCookieConsent(): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const w = window as unknown as { __PROOVRA_CC_INITIALIZED__?: boolean };
  if (w.__PROOVRA_CC_INITIALIZED__) return;
  w.__PROOVRA_CC_INITIALIZED__ = true;

  const mod = (await import("vanilla-cookieconsent")) as unknown as CookieConsentImport;
  const cc = pickDefault<CookieConsentApi>(mod);

  if (!cc || typeof cc.run !== "function") {
    console.warn("[cookie-consent] library loaded but .run is missing");
    return;
  }

  cc.run({
    guiOptions: {
      consentModal: { layout: "box", position: "bottom right" },
      preferencesModal: { layout: "box" },
    },
    categories: {
      necessary: {
        enabled: true,
        readOnly: true,
      },
    },
    language: {
      default: "en",
      translations: {
        en: {
          consentModal: {
            title: "We use cookies",
            description:
              "We use cookies to enable core functionality and (optionally) analytics. You can accept or manage your preferences.",
            acceptAllBtn: "Accept all",
            acceptNecessaryBtn: "Reject non-essential",
            showPreferencesBtn: "Manage preferences",
          },
          preferencesModal: {
            title: "Cookie preferences",
            acceptAllBtn: "Accept all",
            acceptNecessaryBtn: "Reject non-essential",
            savePreferencesBtn: "Save preferences",
            sections: [
              {
                title: "Necessary cookies",
                description: "Required for the website to function properly.",
                linkedCategory: "necessary",
              },
              {
                title: "Analytics cookies",
                description:
                  "Help us understand how visitors interact with the site (only after consent).",
                linkedCategory: "analytics",
              },
              {
                title: "Marketing cookies",
                description: "Advertising / marketing cookies (disabled by default).",
                linkedCategory: "marketing",
              },
            ],
          },
        },
      },
    },
  });
}