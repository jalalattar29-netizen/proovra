/**
 * INTERNAL TESTING BYPASS — server-side only.
 *
 * Centralized allow-list of authenticated user emails that bypass
 * pricing/plan limits (evidence record cap, capture session count,
 * upload/storage caps, evidence parts, report generation gate,
 * verification package gate, AI advisory monthly cap, completion-credit
 * deduction). Used for internal QA/development on a single tester
 * account.
 *
 * Hard rules (read these before touching this file):
 *
 *   1. **Server-only.** The email passed into `isInternalUnlimitedTester`
 *      MUST be sourced from authenticated session data (req.user.email
 *      populated by `middleware/auth.ts`) and looked up against the
 *      `users` table by the resolver in `billing-enforcement.service.ts`.
 *      NEVER pass a value read from a request body, header, or query
 *      string. A client cannot self-elect into the bypass.
 *
 *   2. **Tiny allow-list.** Add to `INTERNAL_UNLIMITED_TEST_EMAILS` only
 *      when an internal tester account legitimately needs unmetered
 *      access. Do not expand to "all admins" or "anyone @proovra.com" —
 *      that would weaken customer billing enforcement.
 *
 *   3. **Bypass scope.** This helper short-circuits ONLY billing/plan
 *      enforcement assertions (the `assertWorkspaceAllows*` /
 *      `consumeWorkspaceCompletionCredits` functions in
 *      `billing-enforcement.service.ts`). It does NOT bypass
 *      authentication, role checks, RBAC, tenant isolation, or any
 *      route-level authorization. Those layers remain enforced.
 *
 *   4. **No customer impact.** Real customers — including PRO/TEAM and
 *      future Enterprise — continue to receive normal limit errors from
 *      the assertion functions. The bypass is a per-row early-return,
 *      not a tier change, so plan capabilities, Stripe/PayPal billing,
 *      seat counts, and storage caps are untouched for everyone else.
 */

const INTERNAL_UNLIMITED_TEST_EMAILS = new Set<string>([
  "jalal.attar@proovra.com",
]);

/**
 * Returns true when the supplied email is one of the internal-tester
 * accounts allowed to bypass billing/plan limits. The comparison is
 * case-insensitive and trims surrounding whitespace; the input is
 * expected to come from `users.email` resolved against the
 * authenticated session, never from client-controlled input.
 */
export function isInternalUnlimitedTester(
  email?: string | null,
): boolean {
  if (!email) return false;
  return INTERNAL_UNLIMITED_TEST_EMAILS.has(email.toLowerCase().trim());
}
