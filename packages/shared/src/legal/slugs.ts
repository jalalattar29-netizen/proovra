/**
 * CANONICAL LEGAL DOCUMENT IDENTITY.
 *
 * The slug allow-list and the human titles for the legal corpus. This module
 * is the ONE authority for "which legal documents exist and what are they
 * called"; `apps/web/app/legal/legal-content.tsx` re-exports from here rather
 * than holding its own copy, and `services/api` reads the same list to bound
 * `GET /v1/legal/:slug`.
 *
 * The corpus itself lives in `apps/web/content/legal/en/*.md` and reaches this
 * package as `corpus.generated.ts` (see `apps/web/scripts/generate-legal-corpus.mjs`).
 */

/**
 * The only locale the product serves.
 *
 * `apps/web/content/legal/` also holds `ar/` and `de/` directories, but the web
 * loader has always read `en` unconditionally and nothing else references them.
 * Declaring a locale the corpus cannot actually satisfy for 21 of its 25
 * documents would be inventing a capability, so the contract states the one
 * locale that is real.
 */
export const LEGAL_LOCALE = "en" as const;

export type LegalLocale = typeof LEGAL_LOCALE;

/** Canonical ordered slug list. Order is the corpus order, not a menu order. */
export const LEGAL_SLUGS = [
  "privacy",
  "terms",
  "cookies",
  "security",
  "dpa",
  "law-enforcement",
  "aup",
  "dmca",
  "support",
  "transparency",
  "impressum",
  "evidence-handling",
  "verification-methodology",
  "subprocessors",
  "data-retention",
  "incident-response",
  "abuse-reporting",
  "toms",
  "legal-changelog",
  // Legal Center hardening — five standalone policy surfaces.
  "ai-use-policy",
  "verification-disclaimer",
  "privacy-requests",
  "refund-policy",
  "accessibility",
  // Capture-channel disclosure for the browser extension's Direct Web
  // Capture (UC-1) — a "how it works" page, NOT the install target.
  "direct-web-capture",
] as const;

export type LegalSlug = (typeof LEGAL_SLUGS)[number];

const LEGAL_SLUG_SET: ReadonlySet<string> = new Set<string>(LEGAL_SLUGS);

export function isLegalSlug(slug: string): slug is LegalSlug {
  return LEGAL_SLUG_SET.has(slug);
}

export const LEGAL_DOCUMENT_TITLES: Readonly<Record<LegalSlug, string>> = {
  privacy: "Privacy Policy",
  terms: "Terms of Service",
  cookies: "Cookie Policy",
  security: "Security & Responsible Disclosure",
  dpa: "Data Processing Agreement (DPA)",
  "law-enforcement": "Law Enforcement Request Policy",
  aup: "Acceptable Use Policy",
  dmca: "Copyright & DMCA Policy",
  support: "Support Policy",
  transparency: "Transparency Policy",
  impressum: "Impressum",
  "evidence-handling": "Evidence Handling Policy",
  "verification-methodology": "Evidence Verification Methodology",
  subprocessors: "Subprocessors",
  "data-retention": "Data Retention Policy",
  "incident-response": "Incident Response Policy",
  "abuse-reporting": "Abuse & Unlawful Content Reporting",
  toms: "Technical & Organizational Measures",
  "legal-changelog": "Legal Changelog",
  "ai-use-policy": "AI Use Policy",
  "verification-disclaimer": "Verification Disclaimer",
  "privacy-requests": "Privacy Requests",
  "refund-policy": "Consumer Cancellation and Refund Policy",
  accessibility: "Accessibility Statement",
  "direct-web-capture": "How Direct Web Capture Works",
};

export function titleFromSlug(slug: string): string {
  if (!slug) return "Legal";
  if (isLegalSlug(slug)) return LEGAL_DOCUMENT_TITLES[slug];
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}
