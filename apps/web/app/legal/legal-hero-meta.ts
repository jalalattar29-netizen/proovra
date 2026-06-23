/**
 * Per-slug hero metadata for /legal/[slug] and /trust.
 *
 * Source of truth for the hero label pill, headline, summary line, and
 * meta row text on every legal document page. Used by:
 *
 *   - apps/web/app/legal/[slug]/page.tsx
 *   - apps/web/app/trust/page.tsx (via the special "trust" key)
 *
 * Wording is intentionally restrained — no certifications, no
 * "tamper-evident" overclaims, no "court-ready". Where a slug is missing
 * from this map the legal page falls back to a generic label and the
 * title resolved by `titleFromSlug`.
 */

export type LegalHeroMeta = {
  label: string;
  title: string;
  summary: string;
  meta: string;
  /** Optional first phrase that the LegalHero should gradient-clip. */
  highlight?: string;
};

export const LEGAL_HERO_META: Record<string, LegalHeroMeta> = {
  // Public Trust Center hub — gradient sits on the MIDDLE phrase per
  // the design brief: "Trust, security," → navy, "privacy, and
  // verification" → gradient, "documentation." → navy.
  trust: {
    label: "Trust Center",
    title: "Trust, security, privacy, and verification documentation.",
    highlight: "privacy, and verification",
    summary:
      "Find PROOVRA's public policies, security practices, privacy documentation, evidence methodology, and governance resources in one place.",
    meta: "Public trust documentation · Current legal and security resources",
  },

  // Core legal documents — for one/two-line titles the gradient takes
  // only the final key phrase or final word so the H1 starts dark and
  // ends with a controlled accent.
  terms: {
    label: "Legal",
    title: "Terms of Service.",
    highlight: "Service.",
    summary:
      "The terms that govern access to and use of PROOVRA's digital evidence operations platform, including account responsibilities, acceptable use, evidence handling limitations, and service terms.",
    meta: "Legal document · Applies to use of PROOVRA services",
  },
  privacy: {
    label: "Privacy",
    title: "Privacy Policy.",
    highlight: "Policy.",
    summary:
      "How PROOVRA collects, uses, protects, and processes personal data across the website, accounts, evidence workflows, verification surfaces, and support interactions.",
    meta: "Privacy document · GDPR-aware processing information",
  },
  cookies: {
    label: "Privacy",
    title: "Cookie Policy.",
    highlight: "Policy.",
    summary:
      "Information about cookies and similar technologies used for security, authentication, preferences, analytics, and website operation.",
    meta: "Privacy document · Cookie and tracking technology information",
  },
  dpa: {
    label: "Data Processing",
    title: "Data Processing Addendum.",
    highlight: "Addendum.",
    summary:
      "Processor terms, data protection commitments, subprocessors, international transfer mechanisms, deletion/return handling, and customer instruction framework for enterprise use.",
    meta: "Enterprise document · Data protection terms",
  },
  subprocessors: {
    label: "Data Governance",
    title: "Subprocessors.",
    summary:
      "Service providers that may support PROOVRA infrastructure, hosting, payments, authentication, communications, monitoring, or AI-assisted features where configured.",
    meta: "Enterprise document · Vendor transparency",
  },
  toms: {
    label: "Security",
    title: "Technical and Organizational Measures.",
    highlight: "Organizational Measures.",
    summary:
      "Security, access control, audit logging, data protection, infrastructure, vendor, and operational measures used to support PROOVRA's evidence workflows.",
    meta: "Security document · Measures may vary by configuration",
  },
  security: {
    label: "Security",
    title: "Security Overview and Responsible Disclosure.",
    highlight: "Responsible Disclosure.",
    summary:
      "How PROOVRA approaches platform security, access control, monitoring, vulnerability reporting, and responsible disclosure for evidence operations.",
    meta: "Security document · Responsible disclosure information",
  },
  "incident-response": {
    label: "Security",
    title: "Incident Response.",
    highlight: "Response.",
    summary:
      "How PROOVRA prepares for, assesses, contains, remediates, and communicates security incidents where required by law or contractual commitments.",
    meta: "Security document · Incident handling overview",
  },
  transparency: {
    label: "Trust",
    title: "Transparency Policy.",
    highlight: "Policy.",
    summary:
      "How PROOVRA approaches government, law-enforcement, abuse, and disclosure-related requests with customer trust, legal review, and minimum necessary disclosure principles.",
    meta: "Trust document · Request handling principles",
  },
  "law-enforcement": {
    label: "Governance",
    title: "Law Enforcement Requests.",
    highlight: "Requests.",
    summary:
      "Guidance for law-enforcement, government, and legal requests involving PROOVRA accounts, records, or evidence-related materials.",
    meta: "Governance document · Legal request process",
  },
  "abuse-reporting": {
    label: "Governance",
    title: "Abuse Reporting.",
    highlight: "Reporting.",
    summary:
      "How users, reviewers, and third parties can report misuse, abusive content, impersonation, unlawful activity, or policy violations involving PROOVRA.",
    meta: "Governance document · Abuse reporting process",
  },
  aup: {
    label: "Governance",
    title: "Acceptable Use Policy.",
    highlight: "Policy.",
    summary:
      "Rules for using PROOVRA responsibly, including prohibited activity, misuse, unlawful evidence handling, harassment, unauthorized surveillance, and platform abuse.",
    meta: "Policy document · Platform use requirements",
  },
  "data-retention": {
    label: "Data Governance",
    title: "Data Retention Policy.",
    highlight: "Policy.",
    summary:
      "How PROOVRA describes retention, deletion, preservation, legal hold concepts, audit records, and customer-controlled evidence lifecycle decisions.",
    meta: "Data governance document · Retention and deletion principles",
  },
  "evidence-handling": {
    label: "Evidence",
    title: "Evidence Handling Policy.",
    highlight: "Policy.",
    summary:
      "How evidence records move through intake, upload, completion, hashing, timestamp context, custody events, reporting, verification packages, reviewer access, retention, and deletion.",
    meta: "Evidence document · Lifecycle and handling principles",
  },
  "verification-methodology": {
    label: "Verification",
    title: "Verification Methodology.",
    highlight: "Methodology.",
    summary:
      "What PROOVRA checks, records, signs, timestamps, packages, and exposes for reviewer inspection — and what PROOVRA does not determine.",
    meta: "Verification document · Recorded signals, not truth determination",
  },
  "verification-disclaimer": {
    label: "Verification",
    title: "Verification Disclaimer.",
    highlight: "Disclaimer.",
    summary:
      "A concise explanation of PROOVRA's verification limitations: recorded signals can support review, but do not determine factual truth, authorship, identity, liability, or legal admissibility.",
    meta: "Verification document · Limitation notice",
  },
  "ai-use-policy": {
    label: "AI Governance",
    title: "AI Use Policy.",
    highlight: "Policy.",
    summary:
      "How AI assistance may support evidence intake, product support, and reviewer preparation while remaining advisory, metadata-first where configured, and never a truth or admissibility decision-maker.",
    meta: "AI governance document · Advisory-only assistance",
  },
  "privacy-requests": {
    label: "Privacy",
    title: "Privacy Requests.",
    highlight: "Requests.",
    summary:
      "How individuals can submit privacy or data subject requests, how PROOVRA verifies requests, and when requests may need to be handled by the customer/controller.",
    meta: "Privacy document · Data subject request process",
  },
  "refund-policy": {
    label: "Billing",
    title: "Consumer Cancellation and Refund Policy.",
    highlight: "Refund Policy.",
    summary:
      "Cancellation, refund, and withdrawal information for eligible users, including limitations for digital services, completed transactions, evidence records, legal hold, and retention requirements.",
    meta: "Billing document · Consumer and subscription information",
  },
  accessibility: {
    label: "Accessibility",
    title: "Accessibility Statement.",
    highlight: "Statement.",
    summary:
      "PROOVRA's accessibility commitment, feedback process, and ongoing effort to improve usability across public pages and product experiences.",
    meta: "Accessibility document · Feedback and improvement process",
  },
  dmca: {
    label: "Legal",
    title: "Copyright and DMCA Policy.",
    highlight: "DMCA Policy.",
    summary:
      "How copyright owners can submit notices involving allegedly infringing content and how PROOVRA handles copyright-related requests.",
    meta: "Legal document · Copyright request process",
  },
  impressum: {
    label: "Legal",
    title: "Impressum.",
    summary:
      "Legal provider information and required contact details for PROOVRA's public website presence.",
    meta: "Legal document · Provider information",
  },
  "legal-changelog": {
    label: "Legal",
    title: "Legal Changelog.",
    highlight: "Changelog.",
    summary:
      "A record of material changes to PROOVRA's public legal, privacy, security, and trust documentation.",
    meta: "Legal document · Document change history",
  },
  support: {
    label: "Support",
    title: "Support Policy.",
    highlight: "Policy.",
    summary:
      "How users and organizations can contact PROOVRA for product, account, billing, security, and operational support.",
    meta: "Support document · Support scope and contact routes",
  },
};

/** Look up hero metadata for a slug, with a safe generic fallback. */
export function legalHeroFor(slug: string, fallbackTitle: string): LegalHeroMeta {
  return (
    LEGAL_HERO_META[slug] ?? {
      label: "Legal",
      title: `${fallbackTitle}.`,
      summary:
        "Governance, privacy, security, verification, and policy materials for PROOVRA.",
      meta: "Legal document · See Trust Center for the complete catalog",
    }
  );
}
