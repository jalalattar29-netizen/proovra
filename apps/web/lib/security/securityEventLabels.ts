/**
 * Canonical presentation mapping for PERSONAL security events (2026-07-16).
 *
 * The backend stores canonical internal audit keys (`auth.google_login`,
 * `identity_security.password_change`, …) in `AdminAuditLog` and returns them
 * verbatim from `GET /v1/identity-security/security-events`. Those keys are
 * the forensic record and MUST NOT change — but they are internal audit codes
 * and were previously rendered as the primary user-facing copy.
 *
 * This module is the ONE place that turns an internal key into human copy.
 * It is pure + exported so the mapping is runtime-testable.
 *
 * Rules:
 *   1. The internal key is NEVER the title. Unknown keys are humanized
 *      (namespace stripped, underscores → spaces, sentence case) so a new
 *      backend event can never leak a raw dotted key into the UI.
 *   2. Forensic detail is not removed — the exact key, IP, user agent and
 *      resource stay available behind an explicit technical-details
 *      disclosure (see SecurityEventsCard).
 *   3. Only keys proven to exist in the codebase get a curated label; the
 *      rest rely on the humanizing fallback rather than invented copy.
 */

export type SecurityEventPresentation = {
  /** Human-readable row title. Never a raw internal key. */
  title: string;
  /** Short plain-language description. Optional. */
  description?: string;
};

/**
 * Curated labels for internal audit keys proven present in the repo
 * (auth.routes.ts + identity-security.routes.ts emitters).
 */
const CURATED: Record<string, SecurityEventPresentation> = {
  "auth.google_login": {
    title: "Signed in with Google",
    description: "A sign-in completed using your Google account.",
  },
  "auth.apple_login": {
    title: "Signed in with Apple",
    description: "A sign-in completed using your Apple account.",
  },
  "auth.email_login": {
    title: "Signed in with email and password",
    description: "A sign-in completed using your email address and password.",
  },
  "auth.login": {
    title: "Signed in",
    description: "A sign-in completed on your account.",
  },
  "auth.logout": {
    title: "Signed out",
    description: "A session on your account was signed out.",
  },
  "auth.mfa_verify": {
    title: "Two-factor verification",
    description: "A second factor was verified during sign-in.",
  },
  "identity_security.password_change": {
    title: "Password changed",
    description: "The password on your account was changed.",
  },
};

/**
 * Humanize an unknown internal key WITHOUT inventing meaning:
 * "identity_security.password_change" → "Password change".
 * Falls back to the trimmed key only if it cannot be humanized at all.
 */
export function humanizeEventKey(action: string): string {
  const raw = (action ?? "").trim();
  if (!raw) return "Security event";
  // Drop the internal namespace ("auth.", "identity_security.", …).
  const tail = raw.includes(".") ? raw.slice(raw.lastIndexOf(".") + 1) : raw;
  const words = tail.replace(/[_-]+/g, " ").trim();
  if (!words) return "Security event";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The canonical key → human presentation mapping. */
export function presentSecurityEvent(action: string): SecurityEventPresentation {
  const curated = CURATED[action];
  if (curated) return curated;
  return { title: humanizeEventKey(action) };
}

/**
 * Outcome → human status word. The backend emits lowercase outcomes
 * ("success" / "failure" / "blocked"); the UI previously rendered them
 * upper-cased raw.
 */
export function presentOutcome(outcome: string | null | undefined): string | null {
  if (!outcome) return null;
  switch (outcome.toLowerCase()) {
    case "success":
      return "Succeeded";
    case "failure":
      return "Failed";
    case "blocked":
      return "Blocked";
    default:
      return humanizeEventKey(outcome);
  }
}
