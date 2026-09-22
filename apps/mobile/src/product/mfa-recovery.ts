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

// ---------------------------------------------------------------------------
// The CREATE leg
// ---------------------------------------------------------------------------

/**
 * Filing the recovery request in the first place.
 *
 * The verify leg above and the admin approve/reject legs were wired long
 * before anything in the product could CREATE one. Native had neither: it
 * could not file a request and could not land on the emailed link.
 *
 * The route sits behind `requireAuth`, and `requireAuth` explicitly REFUSES
 * MFA-pending tokens — a client sitting on the login-time challenge has no
 * session yet. So eligibility is resolved rather than assumed, and the submit
 * control is disabled with the reason spelled out instead of being a control
 * that would 401 on tap.
 */
export const MFA_RECOVERY_CREATE_PATH = "/v1/identity/mfa-admin/recovery-requests";

export function buildRecoveryResendPath(requestId: string): string {
  return `/v1/identity/mfa/recovery-requests/${encodeURIComponent(requestId)}/resend-email`;
}

export function buildRecoveryCancelPath(requestId: string): string {
  return `/v1/identity/mfa/recovery-requests/${encodeURIComponent(requestId)}/cancel`;
}

/** The reason bounds the route enforces: 10..400 characters, trimmed. */
export const RECOVERY_REASON_MIN = 10;
export const RECOVERY_REASON_MAX = 400;

export function isValidRecoveryReason(reason: string): boolean {
  const v = reason.trim();
  return v.length >= RECOVERY_REASON_MIN && v.length <= RECOVERY_REASON_MAX;
}

export function recoveryReasonHint(reason: string): string | null {
  const v = reason.trim();
  if (v.length === 0) return `Describe what happened (at least ${RECOVERY_REASON_MIN} characters).`;
  if (v.length < RECOVERY_REASON_MIN) {
    return `${RECOVERY_REASON_MIN - v.length} more character(s) needed.`;
  }
  if (v.length > RECOVERY_REASON_MAX) {
    return `${v.length - RECOVERY_REASON_MAX} character(s) too many.`;
  }
  return null;
}

export function buildRecoveryRequestBody(teamId: string, reason: string) {
  return { teamId, reason: reason.trim() };
}

export interface RecoveryRequestRef {
  id: string;
  status: string | null;
  expiresAtIso: string | null;
}

export function parseRecoveryRequest(payload: unknown): RecoveryRequestRef | null {
  const r = obj(obj(payload).request ?? payload);
  const id = str(r.id);
  if (!id) return null;
  return { id, status: str(r.status), expiresAtIso: str(r.expiresAt) };
}

/**
 * A 409 means a request is ALREADY in flight, and it carries that request's
 * id. That is not a failure — it is the answer, and it is the only way a user
 * who lost the verification email can reach the resend control. Dropping it
 * would leave them blocked with no way forward, which is the state this whole
 * family exists to get them out of.
 */
export function inFlightRequestIdFrom(err: unknown): string | null {
  const e = obj(err);
  if (typeof e.statusCode === "number" && e.statusCode !== 409) return null;
  return str(obj(e.details).requestId);
}

export type RecoveryCreateFailure =
  | "not_eligible"
  | "invalid_reason"
  | "not_a_member"
  | "throttled"
  | "unknown";

export function classifyCreateFailure(err: unknown): RecoveryCreateFailure {
  const e = obj(err);
  const status = typeof e.statusCode === "number" ? e.statusCode : null;
  if (status === 400) return "invalid_reason";
  if (status === 401) return "not_eligible";
  if (status === 403) return "not_a_member";
  if (status === 429) return "throttled";
  return "unknown";
}

export function createFailureMessage(reason: RecoveryCreateFailure): string {
  switch (reason) {
    case "not_eligible":
      return "Filing a recovery request needs a signed-in session, and a two-factor challenge is not one yet. Sign in on a device that still works, or contact your administrator.";
    case "invalid_reason":
      return "Describe what happened in a little more detail so an administrator can act on it.";
    case "not_a_member":
      return "You are not an active member of that workspace.";
    case "throttled":
      return "A recovery request was filed recently. Wait before filing another.";
    case "unknown":
      return "The recovery request could not be filed. Try again shortly.";
  }
}
