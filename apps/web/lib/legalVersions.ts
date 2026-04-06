export const REQUIRED_LEGAL_VERSIONS = {
  terms: "2026-04-06",
  privacy: "2026-04-06",
  cookies: "2026-04-06",
} as const;

export type RequiredLegalPolicyKey = keyof typeof REQUIRED_LEGAL_VERSIONS;