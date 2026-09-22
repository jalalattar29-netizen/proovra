/**
 * MFA RECOVERY EMAIL VERIFICATION — pure projections.
 *
 * Ports `apps/web/app/auth/mfa-recovery/verify/page.tsx` over
 * `POST /v1/identity/mfa/recovery-requests/:id/verify-email`.
 *
 * A user who has lost their authenticator clicks a link in an email. The link
 * proves MAILBOX ACCESS and nothing else. The hard rules the web page states
 * are the rules here, and they are what this module exists to keep:
 *
 *   - the token is never persisted, never re-rendered, never logged;
 *   - the page does not issue a session and does not bypass MFA;
 *   - success only moves the request to PENDING_ADMIN_REVIEW — an
 *     administrator still has to act.
 *
 * A surface that got this wrong by implying the user was now signed in, or
 * that their second factor had been reset, would be telling someone locked out
 * of their account that they were back in. So the copy states the boundary
 * explicitly, and the tests pin it.
 *
 * Pure: no React, no react-native, no fetch.
 */

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

export const MFA_RECOVERY_PAGE_VIEWED_PATH =
  "/v1/identity/mfa/recovery-requests/analytics/page-viewed";

export const SESSION_LIGHT_PATH = "/v1/auth/session-light";

export function buildVerifyEmailPath(requestId: string): string {
  return `/v1/identity/mfa/recovery-requests/${encodeURIComponent(requestId)}/verify-email`;
}

export type MfaRecoveryFailure =
  | "missing_params"
  | "expired"
  | "invalid"
  | "wrong_user"
  | "already_handled"
  | "unknown";

/**
 * Map the bounded backend reason to a UI state.
 *
 * This reads the raw error message ON PURPOSE — it is internal control flow
 * matching known reason codes, exactly as the web page does it, and the raw
 * message is never rendered. `already_handled` deliberately collapses
 * verified / cancelled / rejected / approved / expired / completed into one
 * calm answer: telling an anonymous caller which of those a request is in
 * would disclose the state of someone else's account recovery.
 */
export function classifyVerifyFailure(err: unknown): MfaRecoveryFailure {
  const e = obj(err);
  const status = typeof e.statusCode === "number" ? e.statusCode : null;
  const message = str(e.message) ?? "";

  if (message === "token_expired" || message.includes("expired")) return "expired";
  if (message === "wrong_user") return "wrong_user";
  if (message === "request_not_in_email_pending") return "already_handled";
  if (message === "token_invalid" || status === 404) return "invalid";
  return "unknown";
}

/** What the user is told, per outcome. Bounded; never the raw error. */
export function failureMessage(reason: MfaRecoveryFailure): string {
  switch (reason) {
    case "missing_params":
      return "This link is incomplete. Open the most recent recovery email and tap the link again.";
    case "expired":
      return "This link has expired. Ask for a new recovery email and use the newest link.";
    case "invalid":
      return "This link is not valid. Open the most recent recovery email and tap the link again.";
    case "wrong_user":
      return "This link belongs to a different account than the one signed in on this device.";
    case "already_handled":
      return "This recovery request has already been handled. If you are still locked out, start a new one.";
    case "unknown":
      return "This link could not be confirmed. Try again, or ask for a new recovery email.";
  }
}

/**
 * The boundary statement. Shown on SUCCESS, not as fine print.
 *
 * Verifying the email confirms mailbox access. It does not sign the user in
 * and does not reset their second factor, and a user who believes otherwise
 * will sit waiting for an app that is never going to let them in.
 */
export const MFA_RECOVERY_BOUNDARY =
  "This confirmed your email only. It did not sign you in and did not change your two-factor authentication. " +
  "An administrator in your organization still has to review the request, and you will need to enrol a fresh " +
  "authenticator once they approve it.";

export function parseSessionProbe(payload: unknown): boolean {
  return obj(payload).authenticated === true;
}

/**
 * Pull `id` and `token` out of the link, whichever shape it arrives in.
 *
 * The emailed link is a web URL with a query string; the app may also receive
 * it as route params. Returns null when either half is missing, which is the
 * `missing_params` state — never a verify attempt with an empty token.
 */
export function parseRecoveryLink(
  input: string | { id?: unknown; token?: unknown },
): { requestId: string; token: string } | null {
  if (typeof input !== "string") {
    const id = str(input.id);
    const token = str(input.token);
    return id && token ? { requestId: id, token } : null;
  }

  try {
    const url = new URL(input);
    const id = url.searchParams.get("id");
    const token = url.searchParams.get("token");
    return id && token ? { requestId: id, token: token.trim() } : null;
  } catch {
    return null;
  }
}
