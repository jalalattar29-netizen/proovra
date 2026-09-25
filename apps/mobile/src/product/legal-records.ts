/**
 * POLICIES & CONSENT (T-14 PrivacySection B + LegalAcceptanceStatusCard) —
 * what this account has accepted, and what it still owes.
 *
 *   GET  /v1/users/legal-status      { requiresReacceptance, missingPolicies,
 *                                      acceptedVersions, requiredVersions }
 *   GET  /v1/users/legal-acceptance  { items: [{ id, policyKey, policyVersion, acceptedAt, source }] }
 *   POST /v1/users/legal-acceptance  (auth-api buildLegalAcceptanceBody; source "settings")
 *
 * Consent, contract acceptance and acknowledgement are legally distinct and
 * are labelled apart, exactly as the web does. Pure: no React, no fetch.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const strMap = (v: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(obj(v)).filter((e): e is [string, string] => typeof e[1] === "string"));

export const LEGAL_STATUS_PATH = "/v1/users/legal-status";
export const LEGAL_ACCEPTANCE_PATH = "/v1/users/legal-acceptance";

const POLICY_PRESENTATION: Record<string, { title: string; acceptanceType: string }> = {
  terms: { title: "Terms of Service accepted", acceptanceType: "Contract acceptance" },
  privacy: { title: "Privacy notice acknowledged", acceptanceType: "Acknowledgement" },
  cookies: { title: "Cookie policy accepted", acceptanceType: "Consent" },
};
const POLICY_LABEL: Record<string, string> = { terms: "Terms of Service", privacy: "Privacy notice", cookies: "Cookie policy" };

export function policyLabel(key: string): string {
  return POLICY_LABEL[key] ?? key;
}

export interface LegalAcceptanceRecord {
  id: string;
  policyKey: string;
  title: string;
  acceptanceType: string;
  version: string | null;
  acceptedAtIso: string | null;
}

export function parseLegalAcceptances(raw: unknown): LegalAcceptanceRecord[] {
  const items = obj(raw).items;
  return (Array.isArray(items) ? items : [])
    .map(obj)
    .filter((i) => str(i.id) && str(i.policyKey))
    .map((i) => {
      const key = i.policyKey as string;
      const p = POLICY_PRESENTATION[key] ?? { title: `${key} accepted`, acceptanceType: "Acceptance" };
      return { id: i.id as string, policyKey: key, title: p.title, acceptanceType: p.acceptanceType, version: str(i.policyVersion), acceptedAtIso: str(i.acceptedAt) };
    });
}

export interface LegalStatusView {
  requiresReacceptance: boolean;
  missing: Array<{ policyKey: string; line: string; requiredVersion: string | null }>;
}

export function parseLegalStatusView(raw: unknown): LegalStatusView {
  const d = obj(raw);
  const accepted = strMap(d.acceptedVersions);
  const required = strMap(d.requiredVersions);
  const missing = (Array.isArray(d.missingPolicies) ? d.missingPolicies : []).filter((k): k is string => typeof k === "string");
  return {
    requiresReacceptance: d.requiresReacceptance === true || missing.length > 0,
    missing: missing.map((k) => ({
      policyKey: k,
      requiredVersion: required[k] ?? null,
      line: accepted[k] ? `You accepted v${accepted[k]} · v${required[k]} is now required` : `Never accepted · v${required[k]} required`,
    })),
  };
}

/** How many acceptance rows show before "View N more" (web PolicyHistory FIRST). */
export const ACCEPTANCE_HISTORY_FIRST = 8;

export const LEGAL_RECORDS_COPY = {
  title: "Policies & consent",
  intro: "Review the policies currently accepted for this account and the history of recorded consent.",
  checking: "Checking which policies your account has accepted…",
  actionNeeded: "Action needed",
  locked: "Some parts of the product — including billing and checkout — stay locked until these are accepted.",
  accept: "I have read and accept these",
  current: "Your account has accepted every policy version currently required.",
  checkAgain: "Check again",
  showHistory: "View acceptance history",
  hideHistory: "Hide acceptance history",
  explicitOnly: "Records are written only when you explicitly accept — viewing a policy is never recorded as consent.",
  noRecords: "No acceptance records on this account yet.",
  referencesTitle: "Privacy actions & references",
  library:
    "The full legal library (DPA, subprocessors, retention, disclosure policies, …) lives in the public Trust Center and the site footer.",
  openTrust: "Open public Trust Center",
  opensOutside: "(opens in your browser — this app stays open).",
} as const;

/** The in-app reader slugs the web's reference list points at (settings/legal/[slug]). */
export const PRIVACY_REFERENCES: ReadonlyArray<{ label: string; slug: string }> = [
  { label: "Submit a privacy request", slug: "privacy-requests" },
  { label: "Privacy Policy", slug: "privacy" },
  { label: "Terms of Service", slug: "terms" },
  { label: "Cookie Policy", slug: "cookies" },
];

/* ------------------------------------------------ recorded cookie consent */

export const COOKIE_CONSENT_PATH = "/v1/users/cookie-consent/latest";

export interface CookieConsentView {
  version: string | null;
  recordedAtIso: string | null;
  /** "Necessary, Analytics" — or "Necessary only", the web's words. */
  categories: string;
}

/** `{ record: {...} | null }` (users.routes.ts). null = nothing recorded. */
export function parseCookieConsent(raw: unknown): CookieConsentView | null {
  const r = obj(obj(raw).record);
  if (Object.keys(r).length === 0) return null;
  const on = ([
    ["Necessary", r.necessary],
    ["Preferences", r.preferences],
    ["Analytics", r.analytics],
    ["Marketing", r.marketing],
  ] as const)
    .filter(([, v]) => v === true)
    .map(([label]) => label)
    .join(", ");
  return { version: str(r.consentVersion), recordedAtIso: str(r.createdAt), categories: on || "Necessary only" };
}

export const COOKIE_CONSENT_COPY = {
  title: "Privacy preferences",
  none: "No cookie consent recorded on this account yet.",
  // The web's "Manage cookie preferences" opens the browser consent manager;
  // cookies govern the website, so on the device the record is shown, and changed there.
  where: "Cookie preferences apply to the PROOVRA website and are changed there.",
} as const;
