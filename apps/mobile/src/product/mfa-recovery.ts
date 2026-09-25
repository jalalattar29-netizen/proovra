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
/** Verbatim from the web (auth/mfa-recovery/verify/page.tsx:194). */
export const MFA_RECOVERY_BOUNDARY =
  "This step confirmed your email only. It did NOT log you in and did NOT change your two-factor authentication. " +
  "You will still need to enroll a fresh authenticator once an admin approves your reset.";
export const MFA_RECOVERY_VERIFYING = "Hold tight — we're confirming your recovery link…";
export const MFA_RECOVERY_NOT_YOU = "If you did not request an MFA recovery, contact your organization administrator immediately.";

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

/* ------------------------------------------ workspace choice (T-13 defect) */
//
// A recovery request needs a `teamId` — the workspace whose administrator
// reviews it. The MFA challenge screen has no active workspace, so the web
// panel resolves the caller's workspaces itself (GET /v1/teams) and asks.
// Native passed `teamId={null}` and never resolved one, so "File recovery
// request" could never be enabled there (MfaRecoveryRequestPanel.tsx:330-378).

export const RECOVERY_WORKSPACES_PATH = "/v1/teams";

export interface RecoveryWorkspace {
  id: string;
  name: string;
}

export function parseRecoveryWorkspaces(payload: unknown): RecoveryWorkspace[] {
  const teams = obj(payload).teams;
  return (Array.isArray(teams) ? teams : [])
    .map((t) => obj(t))
    .filter((t) => typeof t.id === "string" && (t.id as string).length > 0)
    .map((t) => ({ id: t.id as string, name: typeof t.name === "string" && t.name ? (t.name as string) : "Workspace" }));
}

export const NO_RECOVERY_WORKSPACE =
  "No workspace membership was found for this account, so there is no administrator who could approve a reset.";

/* --------------------------------------- the filed request's status (T-15) */
//
// GET /v1/identity/mfa-admin/recovery-requests/detail/:id — the caller's OWN
// request, bounded projection. Native filed requests but never read them
// back, so a user could not see whether the email was confirmed, whether an
// administrator was reviewing, or when the request expires; and Resend/Cancel
// were offered in every state (MfaRecoveryRequestPanel.tsx:84-128, 655-760).

export function buildRecoveryDetailPath(requestId: string): string {
  return `/v1/identity/mfa-admin/recovery-requests/detail/${encodeURIComponent(requestId)}`;
}

export interface RecoveryDetail {
  id: string;
  status: string;
  emailVerified: boolean;
  emailResendCount: number;
  expiresAt: string | null;
}

export function parseRecoveryDetail(payload: unknown): RecoveryDetail | null {
  const d = obj(obj(payload).detail);
  const id = str(d.id);
  if (!id) return null;
  return {
    id,
    status: str(d.status) ?? "",
    emailVerified: d.emailVerified === true,
    emailResendCount: typeof d.emailResendCount === "number" ? d.emailResendCount : 0,
    expiresAt: str(d.expiresAt),
  };
}

/** Mirrors MFA_RECOVERY_EMAIL_MAX_SENDS on the server. */
export const RECOVERY_EMAIL_MAX_SENDS = 3;
const OPEN_RECOVERY_STATUSES = ["EMAIL_VERIFICATION_PENDING", "PENDING_ADMIN_REVIEW"];

export const RECOVERY_STATUS_COPY: Record<string, string> = {
  EMAIL_VERIFICATION_PENDING: "Waiting for you to confirm the link we emailed you.",
  PENDING_ADMIN_REVIEW: "Your email is confirmed. A workspace administrator is reviewing the request.",
  APPROVED: "Approved. Sign in and enroll a new second factor.",
  COMPLETED: "Completed.",
  REJECTED: "An administrator declined this request.",
  CANCELLED: "Cancelled.",
  EXPIRED: "This request expired.",
};

export function recoveryStatusLine(d: RecoveryDetail): string {
  return RECOVERY_STATUS_COPY[d.status] ?? "Status unavailable.";
}

/** Why Resend is unavailable, or null — the web's order of reasons. */
export function recoveryResendBlocked(d: RecoveryDetail, nextResendAfter: string | null, nowMs: number, formatDate: (iso: string) => string): string | null {
  if (d.status !== "EMAIL_VERIFICATION_PENDING") {
    return d.emailVerified
      ? "Your email is already confirmed, so no new link is needed."
      : "This request is no longer waiting for email confirmation.";
  }
  if (d.emailResendCount >= RECOVERY_EMAIL_MAX_SENDS) {
    return "No more verification emails can be sent for this request. Cancel it and file a new one.";
  }
  if (nextResendAfter && Date.parse(nextResendAfter) > nowMs) {
    return `You can request another email after ${formatDate(nextResendAfter)}.`;
  }
  return null;
}

export function recoveryCancelBlocked(d: RecoveryDetail): string | null {
  return OPEN_RECOVERY_STATUSES.includes(d.status) ? null : "Only a request that is still waiting can be cancelled.";
}

function errStatus(err: unknown): number {
  const s = obj(err).statusCode;
  return typeof s === "number" ? s : 0;
}

/** The web's resend refusals, by status; `until` is the server's cooldown end when it sends one. */
export function recoveryResendFailure(err: unknown, formatDate: (iso: string) => string): { message: string; until: string | null } {
  const status = errStatus(err);
  const details = obj(obj(err).details);
  if (status === 429) {
    const until = str(details.nextResendAfter);
    return {
      until,
      message:
        details.reason === "resend_limit_reached"
          ? "No more verification emails can be sent for this request. Cancel it and file a new one."
          : until
            ? `A verification email was sent recently. You can request another after ${formatDate(until)}.`
            : "A verification email was sent recently. Wait a few minutes before requesting another.",
    };
  }
  if (status === 403 || status === 404) return { until: null, message: "This recovery request is no longer available." };
  if (status === 400) return { until: null, message: "A new verification email cannot be sent for this request in its current state." };
  return { until: null, message: "The verification email could not be resent. Try again shortly." };
}

export function recoveryCancelFailure(err: unknown): string {
  const status = errStatus(err);
  if (status === 409) {
    return "This request was already approved, so it cannot be cancelled. Sign in and enroll a new second factor to finish recovery.";
  }
  if (status === 403 || status === 404) return "This recovery request is no longer available.";
  if (status === 400) return "This request can no longer be cancelled.";
  return "The request could not be cancelled. Nothing was changed.";
}
