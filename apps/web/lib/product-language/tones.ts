/**
 * PHASE R4 — Canonical UX tone system.
 *
 * The bounded vocabulary of tones we use across operational copy.
 * Tones describe HOW a piece of copy reads — not what it does.
 *
 * Hard rules:
 *
 *   1. Bounded set. New tones require a CR-level review.
 *
 *   2. Tones are NOT severity. A "warning" tone may apply to a
 *      neutral operational state that needs attention; it is not
 *      automatically red.
 *
 *   3. Tones MAP to existing CSS classes in `app-shell-v2.css` /
 *      `cc-quick-action` / etc. — R4 does NOT introduce new
 *      styling, only the named vocabulary that future surfaces
 *      consume.
 *
 *   4. No marketing tones. No "exciting", no "revolutionary".
 */

export const UX_TONES = [
  // Calm operational language — the default for most surfaces.
  "operational",
  // Step-by-step copy for setup, onboarding, partial completion.
  "guidance",
  // Pending action / soft alert. Not red. Not panic.
  "warning",
  // Confirmation / completion / safe-state copy.
  "success",
  // Loading / pending-data / neutral system state copy.
  "neutral-system-state",
  // Governance / compliance / policy posture copy.
  "governance-compliance",
  // Verification / integrity / forensic-state copy.
  "verification-integrity",
  // Reviewer-ops queue / SLA / escalation copy.
  "reviewer-operations",
] as const;

export type UxTone = (typeof UX_TONES)[number];

/**
 * Forbidden tone styles. These describe COPY VOICES we explicitly
 * reject — marketing hype, panic, developer-facing slang, etc.
 * The R4 test suite scans key UX files for these phrases.
 */
export const FORBIDDEN_TONE_PATTERNS: ReadonlyArray<RegExp> = [
  // Marketing fluff
  /\brevolutionary\b/i,
  /\binnovative\s+platform\b/i,
  /\bnext[-\s]gen\b/i,
  /\bdisrupt(ing|ive)?\b/i,
  /\bbest[-\s]in[-\s]class\b/i,
  /\bworld[-\s]class\b/i,
  /\bsynergy\b/i,
  /\bsynergies\b/i,
  /\bgame[-\s]chang(er|ing)\b/i,
  // Empty AI hype
  /\bAI[-\s]powered\b/i,
  /\bintelligent\s+assistant\b/i,
  // Panic / dramatic
  /\bcritical\s+failure\s+detected\b/i,
  /\bemergency\s+condition\b/i,
  // Developer slang
  /\bobject\s+not\s+found\b/i,
  /\bnull\s+pointer\b/i,
  /\bundefined\s+state\b/i,
  /\boops!\b/i,
];
