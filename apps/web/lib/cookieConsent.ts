import CookieConsent from "vanilla-cookieconsent";

export function initCookieConsent() {
  CookieConsent.run({
    guiOptions: {
      consentModal: { layout: "box", position: "bottom right" },
      preferencesModal: { layout: "box" }
    },
    categories: {
  necessary: {
    enabled: true,
    readOnly: true
  }
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
            showPreferencesBtn: "Manage preferences"
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
                linkedCategory: "necessary"
              },
              {
                title: "Analytics cookies",
                description:
                  "Help us understand how visitors interact with the site (only after consent).",
                linkedCategory: "analytics"
              },
              {
                title: "Marketing cookies",
                description: "Advertising / marketing cookies (disabled by default).",
                linkedCategory: "marketing"
              }
            ]
          }
        }
      }
    }
  });
}