/**
 * Cool slate / blue-white surface palette for PROOVRA public marketing pages.
 *
 * Each value is a CSS var reference defined in app/globals.css under :root.
 * Use these on public marketing surfaces only — authenticated dashboard pages
 * keep --surface / --surface-soft.
 *
 * Hex equivalents (for reference):
 *   pageBg:           #F8FAFC  (slate-50)
 *   pageBgSoft:       #F1F5F9  (slate-100)
 *   surface:          #FFFFFF  (pure white)
 *   surfaceSoft:      #F8FAFC  (slate-50)
 *   borderWarm:       #E2E8F0  (slate-200) — name retained from earlier warm iteration
 *   borderWarmStrong: #CBD5E1  (slate-300)
 *   borderWarmHover:  #CBD5E1  (slate-300)
 */
export const MARKETING_SURFACE = {
  pageBg: "var(--proovra-page-bg)",
  pageBgSoft: "var(--proovra-page-bg-soft)",
  surface: "var(--proovra-surface)",
  surfaceSoft: "var(--proovra-surface-soft)",
  borderWarm: "var(--proovra-border-warm)",
  borderWarmStrong: "var(--proovra-border-warm-strong)",
  borderWarmHover: "var(--proovra-border-warm-hover)",
} as const;

export const MARKETING_COLORS = {
  navy: "#0B1F5E",
  navyDeep: "#06112E",
  purple: "#7C3AED",
  purpleDeep: "#5B21B6",
  blue: "#2563EB",
  cyan: "#06B6D4",
  orange: "#F97316",
  pink: "#EC4899",
  background: "#FFFFFF",
  surface: "#F8FAFC",
  surfaceAlt: "#F1F5F9",
  border: "#E5E7EB",
  borderSoft: "#EEF1F5",
  textPrimary: "#0F172A",
  textSecondary: "#475569",
  textMuted: "#64748B",
  success: "#10B981",
  warning: "#F59E0B",
  error: "#EF4444",

  // Scoped accent tokens — used by specific Solutions / Technology
  // surfaces only (see app/technology/page.tsx and
  // components/use-case-page.tsx). Not applied globally.
  burgundy: "#7A1F3D",
  burgundyDark: "#5E1730",
  burgundySoft: "#F8EEF3",
  burgundyBorder: "rgba(122,31,61,0.22)",
  governanceGreen: "#0B6B53",
  governanceGreenDark: "#084C3C",
  governanceGreenSoft: "#EAF6F2",
  governanceGreenBorder: "rgba(11,107,83,0.22)",
} as const;

export const MARKETING_ASSETS = {
  brand: {
    logoHeader: "/assets/branding/proovra-logo-header.png",
    mark: "/assets/branding/proovra-mark.png",
  },
  industries: {
    insurance: "/assets/industries/industry-insurance.png",
    legal: "/assets/industries/industry-legal.png",
    government: "/assets/industries/industry-government.png",
    compliance: "/assets/industries/industry-compliance.png",
    investigations: "/assets/industries/industry-investigations.png",
    journalism: "/assets/industries/industry-journalism.png",
  },
  useCases: {
    carRentalReturn: "/assets/use-cases/verification-car-rental-return.png",
  },
} as const;

export const MARKETING_LINKS = {
  signIn: "/login",
  requestDemo: "/request-demo",
  contactSales: "/contact-sales",
  pricing: "/pricing",
  verifyDemo: "/verify/demo",
  verify: "/verify",
  sampleReport: "/brand/sample-report.pdf",
  support: "/support",

  trustCenter: "/trust",
  faq: "/faq",
  whyProovra: "/why-proovra",
  about: "/about",

  // Platform IA was consolidated into one /platform page with anchor
  // navigation. Old short sub-pages remain on disk but are no longer linked
  // from the marketing nav; these tokens now point at section anchors.
  platform: {
    overview: "/platform",
    capture: "/platform#lifecycle",
    evidenceRecords: "/platform#lifecycle",
    verification: "/platform#trust",
    reports: "/platform#modules",
    verificationPackages: "/platform#modules",
    cases: "/platform#modules",
    teams: "/platform#modules",
    governance: "/platform#governance",
    integrations: "/platform#integrations",
  },

  technology: {
    overview: "/technology",
    // Technology was consolidated into a single in-depth architecture
    // page at /technology. The five detail subpages (cryptographic-
    // hashing, digital-signatures, trusted-timestamps, opentimestamps,
    // chain-of-custody) were retired and permanently redirect to the
    // canonical destination with in-page anchors (#ai-architecture,
    // #verification-architecture, #security-architecture,
    // #governance-architecture). Old token keys point at the new
    // anchors so any unmigrated consumer still resolves to the right
    // place.
    aiArchitecture: "/technology#ai-architecture",
    verificationArchitecture: "/technology#verification-architecture",
    securityArchitecture: "/technology#security-architecture",
    governanceArchitecture: "/technology#governance-architecture",
    cryptographicHashing: "/technology#verification-architecture",
    digitalSignatures: "/technology#verification-architecture",
    trustedTimestamps: "/technology#verification-architecture",
    openTimestamps: "/technology#verification-architecture",
    chainOfCustody: "/technology#governance-architecture",
    // Canonical methodology lives at /legal/verification-methodology;
    // the old standalone /technology/verification-methodology page was
    // retired (a permanent redirect in next.config.js preserves old
    // indexed URLs). Body-content "Read methodology" CTAs on the
    // Technology pages route directly to the canonical destination.
    verificationMethodology: "/legal/verification-methodology",
  },

  // Canonical industry pages live under /for-*. The old /solutions/*
  // pages were retired and permanently redirect to the canonical
  // /for-* destinations (see next.config.js). Both this `solutions`
  // block and the `industries` block now resolve to the same canonical
  // routes.
  solutions: {
    legal: "/for-lawyers",
    insurance: "/for-insurance",
    corporateInvestigations: "/for-investigations",
    government: "/for-government",
    compliance: "/for-compliance",
    journalism: "/for-journalism",
  },

  industries: {
    insurance: "/for-insurance",
    legal: "/for-lawyers",
    government: "/for-government",
    compliance: "/for-compliance",
    investigations: "/for-investigations",
    journalism: "/for-journalism",
  },

  legal: {
    privacy: "/legal/privacy",
    terms: "/legal/terms",
    security: "/legal/security",
    subprocessors: "/legal/subprocessors",
    dpa: "/legal/dpa",
    cookies: "/legal/cookie-policy",
    methodology: "/legal/verification-methodology",
  },
} as const;

export const MARKETING_COPY = {
  brandName: "PROOVRA",
  brandTagline: "Evidence. Trust. Integrity.",
  supportEmail: "support@proovra.com",
} as const;
