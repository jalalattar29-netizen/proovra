/**
 * AUD-026 — which pages the browser will not let an extension capture, decided
 * BEFORE a capture starts so the user gets a stable sentence instead of the
 * generic failure that `chrome.scripting.executeScript` throwing used to become.
 *
 * Pure: the popup calls it with the tab URL, the background calls it again
 * (defence in depth), and a scripting refusal the URL check could not foresee
 * (no URL visible) is classified by `isRestrictedScriptingError`.
 *
 * Hosts are compared EXACTLY — never by substring — so `chromewebstore.google
 * .com.example.net` is an ordinary web page and is not mislabelled.
 */
export type PageRestriction = "BROWSER_INTERNAL_PAGE" | "EXTENSION_STORE_PAGE" | "NOT_A_WEB_PAGE";

const BROWSER_INTERNAL_SCHEMES = new Set([
  "chrome:",
  "chrome-extension:",
  "chrome-search:",
  "chrome-untrusted:",
  "devtools:",
  "edge:",
  "extension:",
  "about:",
  "view-source:",
]);

/** Store pages browsers refuse to script, as exact host + path prefix. */
const EXTENSION_STORES: ReadonlyArray<{ host: string; pathPrefix: string }> = [
  { host: "chromewebstore.google.com", pathPrefix: "/" },
  { host: "chrome.google.com", pathPrefix: "/webstore" },
  { host: "microsoftedge.microsoft.com", pathPrefix: "/addons" },
];

/** null = capturable as far as the URL shows (or the URL is not visible). */
export function pageRestriction(url: string | null | undefined): PageRestriction | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "NOT_A_WEB_PAGE";
  }
  if (BROWSER_INTERNAL_SCHEMES.has(parsed.protocol)) return "BROWSER_INTERNAL_PAGE";
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "NOT_A_WEB_PAGE";
  const host = parsed.hostname.toLowerCase();
  for (const store of EXTENSION_STORES) {
    if (host === store.host && parsed.pathname.startsWith(store.pathPrefix)) return "EXTENSION_STORE_PAGE";
  }
  return null;
}

/** The browser's own refusal to script a page, recognised by its stable wording. */
export function isRestrictedScriptingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return (
    /Cannot access a (chrome|edge|about|chrome-extension|devtools|view-source)[-a-z]*:/i.test(message) ||
    /extensions gallery cannot be scripted/i.test(message) ||
    /Cannot access contents of url "(chrome|edge|about|view-source)/i.test(message)
  );
}

export const RESTRICTED_PAGE_COPY: Record<PageRestriction, string> = {
  BROWSER_INTERNAL_PAGE:
    "This is a browser page (settings, new tab, extensions or similar). Browsers do not let extensions capture these pages. Open the web page you want to preserve and try again.",
  EXTENSION_STORE_PAGE:
    "Browsers do not let extensions capture extension store pages. Open the web page you want to preserve and try again.",
  NOT_A_WEB_PAGE:
    "Only web pages (http or https) can be captured. Open the web page you want to preserve and try again.",
};
