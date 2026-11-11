/**
 * AUD-0034 — which screens a signed-out person may open.
 *
 * The tabs redirect to sign-in without a session; the stack screens did not.
 * Opened signed out (a deep link, a restored route, `proovra://case/<id>`), 29
 * protected screens rendered with a "Signed in as Account" header and messages
 * like "You don't have access to this case" — a permission answer to a person
 * who simply is not signed in.
 *
 * This module is the ONE list. A route is public only if it is named here;
 * every other route needs a session (fail closed: a new screen is protected
 * until someone decides otherwise). Pure, so the decision is testable without
 * a router.
 */

/** First path segment (route groups such as `(stack)` removed) of every public screen. */
export const SIGNED_OUT_ROUTES: ReadonlySet<string> = new Set([
  // Signing in, and the steps around it.
  "auth",
  "register",
  "forgot-password",
  "reset-password",
  "verify-email",
  "mfa",
  "mfa-recovery-verify",
  "sso-complete",
  // Published documents.
  "legal",
  // Token-bearing public flows: the token is the authority, not a session.
  "intake",
  "invite",
  "org-invite",
  "portal",
  // Public Verify.
  "verify",
  // Unknown routes render the not-found screen.
  "+not-found",
]);

/** Expo Router segments, e.g. ["(stack)", "case", "[id]"] or ["verify", "[id]"]. */
export function routeNeedsSession(segments: readonly string[]): boolean {
  const path = segments.filter((s) => !(s.startsWith("(") && s.endsWith(")")));
  const first = path[0];
  // The root index decides for itself (it routes to sign-in or the tabs).
  if (!first || first === "index") return false;
  return !SIGNED_OUT_ROUTES.has(first);
}
