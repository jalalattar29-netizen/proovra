/**
 * PHASE R4 — Forbidden wording.
 *
 * The exhaustive bounded set of phrases that MUST NOT appear in
 * user-visible copy on primary product surfaces. Three categories:
 *
 *   1. Engineering / architecture leakage — raw enums, debug copy,
 *      architecture terms ("Access", "Org", "UNKNOWN" outside the
 *      one safe fallback, "STATUS_PENDING" all-caps).
 *
 *   2. Marketing fluff — startup buzzwords, vague hype copy,
 *      empty AI claims.
 *
 *   3. Dramatic / panic copy — alarming wording for neutral state.
 *
 * The R4 test suite scans primary-shell + dashboard + sidebar +
 * key surfaces for matches. A new occurrence breaks the build.
 *
 * Forensic-trust terms (custody, verification, integrity, etc.)
 * are NOT forbidden — they are preserved verbatim by
 * `operationalTerminology.ts`.
 */

export const FORBIDDEN_ENGINEERING_PHRASES: ReadonlyArray<RegExp> = [
  // Raw architecture chips (R2 replaced via DEGRADATION_CHIP_LABELS;
  // R4 enforces continued absence).
  /\breturn\s+"Org"\s*;/,
  /\breturn\s+"Access"\s*;/,
  // Raw ALL_CAPS backend states surfacing to users.
  /\b"STATUS_PENDING"\b/,
  /\b"PERMISSION_DENIED"\b\s*[,;)]/,
  /\b"WORKSPACE_MEMBERSHIP_REQUIRED"\b\s*[,;)]/,
  // Debug-style fallbacks.
  /\bnull\s+pointer\b/i,
  /\bundefined\s+state\b/i,
  /\bobject\s+not\s+found\b/i,
];

export const FORBIDDEN_MARKETING_PHRASES: ReadonlyArray<RegExp> = [
  /\brevolutionary\b/i,
  /\bnext[-\s]gen(eration)?\b/i,
  /\bdisrupt(ing|ive|ion)?\b/i,
  /\bbest[-\s]in[-\s]class\b/i,
  /\bworld[-\s]class\b/i,
  /\bsynerg(y|ies)\b/i,
  /\bgame[-\s]chang(er|ing)\b/i,
  /\bAI[-\s]powered\b/i,
  /\bintelligent\s+assistant\b/i,
  /\binnovation\s+platform\b/i,
];

export const FORBIDDEN_DRAMATIC_PHRASES: ReadonlyArray<RegExp> = [
  /\bcritical\s+failure\s+detected\b/i,
  /\bemergency\s+condition\b/i,
  /\bcatastrophic\s+failure\b/i,
  /\boops!?\b/i,
];

export const ALL_FORBIDDEN_PHRASES: ReadonlyArray<RegExp> = [
  ...FORBIDDEN_ENGINEERING_PHRASES,
  ...FORBIDDEN_MARKETING_PHRASES,
  ...FORBIDDEN_DRAMATIC_PHRASES,
];
