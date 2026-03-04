export type LegalLink = { label: string; href: string };

export const LEGAL_LINKS: LegalLink[] = [
  { label: "Privacy Policy", href: "/privacy" },
  { label: "Terms of Service", href: "/terms" },

  { label: "Cookies", href: "/legal/cookies" },
  { label: "Security", href: "/legal/security" },
  { label: "Data Processing Agreement (DPA)", href: "/legal/dpa" },

  { label: "Law Enforcement Requests", href: "/legal/law-enforcement" },
  { label: "Acceptable Use Policy", href: "/legal/acceptable-use" },
  { label: "Copyright (DMCA)", href: "/legal/dmca" },

  { label: "Transparency", href: "/legal/transparency" },
  { label: "Verification", href: "/legal/verification" },
  { label: "Verification Methodology", href: "/legal/verification-methodology" },

  { label: "Evidence Handling", href: "/legal/evidence-handling" },
  { label: "Impressum", href: "/legal/impressum" }
];