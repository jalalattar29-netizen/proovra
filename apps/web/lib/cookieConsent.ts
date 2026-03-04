"use client";

type AnyRecord = Record<string, unknown>;

function getDefault<T>(m: any): T {
  return (m && typeof m === "object" && "default" in m ? m.default : m) as T;
}

export async function initCookieConsent(): Promise<void> {
  // ✅ لازم يكون متصفح
  if (typeof window === "undefined" || typeof document === "undefined") return;

  // ✅ لا تعيد تشغيله إذا اشتغل مرة
  if ((window as any).__PROOVRA_CC_INITIALIZED__) return;
  (window as any).__PROOVRA_CC_INITIALIZED__ = true;

  // ✅ حمّل المكتبة ديناميك
  const mod = await import("vanilla-cookieconsent");
  const cc: any = getDefault<any>(mod);

  if (!cc || typeof cc.run !== "function") {
    console.warn("[cookie-consent] library loaded but .run is missing", {
      moduleKeys: mod && typeof mod === "object" ? Object.keys(mod as AnyRecord) : [],
      ccKeys: cc && typeof cc === "object" ? Object.keys(cc as AnyRecord) : [],
    });
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
      // إذا بدك analytics/marketing فعلياً تضيفهم هون لاحقاً (مو ضروري الآن)
      // analytics: { enabled: false, readOnly: false },
      // marketing: { enabled: false, readOnly: false },
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