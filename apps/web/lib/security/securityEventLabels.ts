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
  // Lifecycle Phase 2 (2026-07-16) — identity/preference/membership events.
  "identity.profile_updated": {
    title: "Profile updated",
    description: "Your account profile details were changed.",
  },
  "identity.preferences_updated": {
    title: "Preferences updated",
    description: "Your language or timezone preference was changed.",
  },
  "identity.login_method_linked": {
    title: "Login method connected",
    description: "A new sign-in method was connected to your account.",
  },
  "identity.login_method_unlinked": {
    title: "Login method disconnected",
    description: "A sign-in method was disconnected from your account.",
  },
  "identity.password_added": {
    title: "Password added",
    description: "A password was added to your account.",
  },
  "identity.organization_left": {
    title: "Left an organization",
    description: "You left an organization and its workspaces.",
  },
  "identity.data_export_requested": {
    title: "Data export requested",
    description: "You requested a copy of your personal account data.",
  },
  "identity.data_export_ready": {
    title: "Data export ready",
    description: "Your personal data export finished and is ready to download.",
  },
  "identity.data_export_downloaded": {
    title: "Data export downloaded",
    description: "Your personal data export package was downloaded.",
  },
  "identity.data_export_failed": {
    title: "Data export failed",
    description: "Your personal data export could not be generated.",
  },
  "identity.account_closure_requested": {
    title: "Account closure requested",
    description:
      "You asked to close your account. It closes after the cancellation window unless you cancel.",
  },
  "identity.account_closure_blocked": {
    title: "Account closure blocked",
    description:
      "Your account could not be scheduled for closure — something still needs your attention.",
  },
  "identity.account_closure_cancelled": {
    title: "Account closure cancelled",
    description: "You cancelled the request to close your account.",
  },
  "identity.account_closure_completed": {
    title: "Account closed",
    description: "Your account was closed and personal details were anonymized.",
  },
  "identity.account_closure_failed": {
    title: "Account closure failed",
    description: "Closing your account did not complete. No data was lost.",
  },
  "identity.organization_ownership_transferred": {
    title: "Organization ownership transferred",
    description: "Ownership of an organization changed hands.",
  },
  "identity.organization_closure_requested": {
    title: "Organization closure requested",
    description:
      "You asked to close an organization. It closes after the cancellation window unless you cancel.",
  },
  "identity.organization_closure_blocked": {
    title: "Organization closure blocked",
    description:
      "An organization could not be scheduled for closure — something still needs attention.",
  },
  "identity.organization_closure_cancelled": {
    title: "Organization closure cancelled",
    description: "You cancelled the request to close an organization.",
  },
  "identity.organization_closure_completed": {
    title: "Organization closed",
    description:
      "An organization you requested to close was archived. Its evidence remains under governance.",
  },
  "identity.organization_closure_failed": {
    title: "Organization closure failed",
    description: "Closing an organization did not complete. Nothing was lost.",
  },
  "identity.workspace_closure_requested": {
    title: "Workspace closure requested",
    description:
      "You asked to close a workspace. It closes after the cancellation window unless you cancel.",
  },
  "identity.workspace_closure_blocked": {
    title: "Workspace closure blocked",
    description:
      "A workspace could not be scheduled for closure — something still needs attention.",
  },
  "identity.workspace_closure_cancelled": {
    title: "Workspace closure cancelled",
    description: "You cancelled the request to close a workspace.",
  },
  "identity.workspace_closure_completed": {
    title: "Workspace closed",
    description:
      "A workspace you requested to close was archived. Its evidence remains under governance.",
  },
  "identity.workspace_closure_failed": {
    title: "Workspace closure failed",
    description: "Closing a workspace did not complete. Nothing was lost.",
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
