"use client";

/**
 * PHASE 13 — MFA lost-factor recovery: the CREATE leg.
 *
 * The verify leg (`/auth/mfa-recovery/verify`) and the admin approve /
 * reject legs (`/security-center/mfa-recovery`) were both already wired,
 * so a recovery request could be verified and approved — but no surface
 * in the product could ever CREATE one. This panel is that surface.
 *
 *   POST /v1/identity/mfa-admin/recovery-requests
 *     body   { teamId: uuid, reason: string (10..400, trimmed) }
 *     200    { ok: true, request: { id, status, expiresAt, … } }
 *     400    invalid reason / body
 *     403    the caller is not an ACTIVE member of that workspace
 *     409    a request is already in flight for (user, workspace)
 *     429    per-account throttle
 *
 * The route is behind `requireAuth`, and `requireAuth` explicitly REFUSES
 * MFA-pending tokens (services/api/src/middleware/auth.ts) — a browser
 * sitting on the login-time challenge has no session yet. So the panel
 * resolves its own eligibility instead of pretending:
 *
 *   - `teamId` supplied (authenticated surfaces) → act immediately.
 *   - no `teamId` (the challenge page) → probe `GET /v1/auth/session-light`
 *     and, when a real session is present, load the caller's workspaces so
 *     the required `teamId` can be chosen. When it is not, the submit
 *     control renders DISABLED with the reason spelled out — never a
 *     control that would 401 on click.
 *
 * Hard rules:
 *   - No token, verification link, or raw error body ever reaches the DOM.
 *   - Every request goes through the canonical `apiFetch` (the API is a
 *     different origin; a relative fetch would hit Next and 404).
 *
 * Batch J — acting on the request that is in flight:
 *
 *   POST /v1/identity/mfa/recovery-requests/:requestId/resend-email
 *     200 { nextResendAfter }   429 { details: { reason, nextResendAfter } }
 *   POST /v1/identity/mfa/recovery-requests/:requestId/cancel
 *     200 { ok }                409 already_approved
 *   GET  /v1/identity/mfa-admin/recovery-requests/detail/:requestId  (reread)
 *
 * Only one request may be in flight, so a lost verification email or a
 * mistaken request used to leave the user blocked. The request id comes from
 * the create response, or from the 409 `details.requestId`. Every outcome is
 * stated only after the request is reread.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";

import { apiFetch } from "../../lib/api";
import { formatUserDateTime } from "../../lib/date";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { useConfirmAction } from "../ui/ConfirmActionModal";

const REASON_MIN = 10;
const REASON_MAX = 400;

type Eligibility =
  | { kind: "resolving" }
  | { kind: "eligible" }
  | { kind: "no_session" }
  | { kind: "no_workspace" };

type Outcome =
  | { kind: "idle" }
  | { kind: "created"; expiresAt: string | null }
  | { kind: "already_pending" }
  | { kind: "denied" }
  | { kind: "throttled" }
  | { kind: "failed"; message: string };

type WorkspaceOption = { id: string; name: string };

type ErrorLike = {
  statusCode?: number;
  code?: string;
  details?: Record<string, unknown>;
};

/** Bounded projection of GET .../recovery-requests/detail/:requestId. */
type RequestDetail = {
  id: string;
  status: string;
  emailVerified: boolean;
  emailResendCount: number;
  expiresAt: string;
};

type DetailState =
  | { kind: "loading" }
  | { kind: "ready"; detail: RequestDetail }
  | { kind: "gone" }
  | { kind: "failed"; message: string };

/** Mirrors MFA_RECOVERY_EMAIL_MAX_SENDS on the server. */
const EMAIL_MAX_SENDS = 3;
const OPEN_STATUSES = ["EMAIL_VERIFICATION_PENDING", "PENDING_ADMIN_REVIEW"];

const STATUS_COPY: Record<string, string> = {
  EMAIL_VERIFICATION_PENDING: "Waiting for you to confirm the link we emailed you.",
  PENDING_ADMIN_REVIEW: "Your email is confirmed. A workspace administrator is reviewing the request.",
  APPROVED: "Approved. Sign in and enroll a new second factor.",
  COMPLETED: "Completed.",
  REJECTED: "An administrator declined this request.",
  CANCELLED: "Cancelled.",
  EXPIRED: "This request expired.",
};

function detailsOf(err: unknown): Record<string, unknown> {
  const d = (err as ErrorLike | null)?.details;
  return d && typeof d === "object" ? d : {};
}

function statusOf(err: unknown): number {
  const e = err as ErrorLike | null;
  return typeof e?.statusCode === "number" ? e.statusCode : 0;
}

export function MfaRecoveryRequestPanel({
  teamId = null,
  compact = false,
}: {
  /**
   * Active workspace id on authenticated surfaces. When null the panel
   * resolves the caller's workspaces itself (challenge page).
   */
  teamId?: string | null;
  compact?: boolean;
}) {
  const reasonFieldId = useId();
  const workspaceFieldId = useId();

  const [eligibility, setEligibility] = useState<Eligibility>(
    teamId ? { kind: "eligible" } : { kind: "resolving" },
  );
  const [workspaces, setWorkspaces] = useState<ReadonlyArray<WorkspaceOption>>(
    [],
  );
  const [selectedTeamId, setSelectedTeamId] = useState<string>(teamId ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const { confirm } = useConfirmAction();
  const [requestId, setRequestId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ kind: "loading" });
  const [requestBusy, setRequestBusy] = useState<"resend" | "cancel" | null>(null);
  const [requestNotice, setRequestNotice] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [nextResendAfter, setNextResendAfter] = useState<string | null>(null);

  // Stale-response protection: only the newest submission may write state,
  // and nothing writes after unmount.
  const mountedRef = useRef(true);
  const submitSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const readDetail = useCallback(async (id: string): Promise<RequestDetail | null | undefined> => {
    try {
      const res = await apiFetch(
        `/v1/identity/mfa-admin/recovery-requests/detail/${encodeURIComponent(id)}`,
        { method: "GET" },
      );
      const d = res?.detail as RequestDetail | undefined;
      if (!mountedRef.current) return undefined;
      if (!d) {
        setDetail({ kind: "gone" });
        return null;
      }
      setDetail({ kind: "ready", detail: d });
      return d;
    } catch (err) {
      if (!mountedRef.current) return undefined;
      if (statusOf(err) === 404) {
        setDetail({ kind: "gone" });
        return null;
      }
      setDetail({
        kind: "failed",
        message: toSafeUserError(err, {
          message: "Your recovery request could not be loaded. Refresh to try again.",
        }).message,
      });
      return undefined;
    }
  }, []);

  useEffect(() => {
    if (!requestId) return;
    setDetail({ kind: "loading" });
    void readDetail(requestId);
  }, [requestId, readDetail]);

  const onResend = useCallback(async () => {
    if (!requestId || requestBusy) return;
    setRequestBusy("resend");
    setRequestNotice(null);
    setRequestError(null);
    try {
      let after: string | null = null;
      try {
        const res = await apiFetch(
          `/v1/identity/mfa/recovery-requests/${encodeURIComponent(requestId)}/resend-email`,
          { method: "POST" },
        );
        after = typeof res?.nextResendAfter === "string" ? res.nextResendAfter : null;
      } catch (err) {
        if (!mountedRef.current) return;
        const status = statusOf(err);
        const details = detailsOf(err);
        if (status === 429) {
          const until = typeof details.nextResendAfter === "string" ? details.nextResendAfter : null;
          setNextResendAfter(until);
          setRequestError(
            details.reason === "resend_limit_reached"
              ? "No more verification emails can be sent for this request. Cancel it and file a new one."
              : until
                ? `A verification email was sent recently. You can request another after ${formatUserDateTime(until)}.`
                : "A verification email was sent recently. Wait a few minutes before requesting another.",
          );
        } else if (status === 403 || status === 404) {
          setRequestError("This recovery request is no longer available.");
        } else if (status === 400) {
          setRequestError("A new verification email cannot be sent for this request in its current state.");
        } else {
          setRequestError(
            toSafeUserError(err, {
              message: "The verification email could not be resent. Try again shortly.",
            }).message,
          );
        }
        await readDetail(requestId);
        return;
      }
      const reread = await readDetail(requestId);
      if (!mountedRef.current) return;
      setNextResendAfter(after);
      if (reread && reread.status === "EMAIL_VERIFICATION_PENDING") {
        setRequestNotice(
          after
            ? `A new verification link was sent to your email. You can request another after ${formatUserDateTime(after)}.`
            : "A new verification link was sent to your email.",
        );
      } else {
        setRequestError(
          reread === undefined
            ? "The email was requested, but your request could not be reloaded to confirm it. Refresh before trying again."
            : "The email was requested, but your request is no longer waiting for email confirmation.",
        );
      }
    } finally {
      if (mountedRef.current) setRequestBusy(null);
    }
  }, [readDetail, requestBusy, requestId]);

  const onCancelRequest = useCallback(async () => {
    if (!requestId || requestBusy) return;
    setRequestBusy("cancel");
    setRequestNotice(null);
    setRequestError(null);
    try {
      const ok = await confirm({
        title: "Cancel this recovery request?",
        description:
          "The request is withdrawn and any verification link stops working. You can file a new request afterwards.",
        confirmLabel: "Cancel request",
        cancelLabel: "Keep request",
        tone: "danger",
      });
      if (!ok || !mountedRef.current) return;
      try {
        await apiFetch(
          `/v1/identity/mfa/recovery-requests/${encodeURIComponent(requestId)}/cancel`,
          { method: "POST" },
        );
      } catch (err) {
        if (!mountedRef.current) return;
        const status = statusOf(err);
        setRequestError(
          status === 409
            ? "This request was already approved, so it cannot be cancelled. Sign in and enroll a new second factor to finish recovery."
            : status === 403 || status === 404
              ? "This recovery request is no longer available."
              : status === 400
                ? "This request can no longer be cancelled."
                : toSafeUserError(err, {
                    message: "The request could not be cancelled. Nothing was changed.",
                  }).message,
        );
        await readDetail(requestId);
        return;
      }
      const reread = await readDetail(requestId);
      if (!mountedRef.current) return;
      if (reread && reread.status === "CANCELLED") {
        // Back to idle: a new request can be filed.
        setRequestId(null);
        setOutcome({ kind: "idle" });
        setNextResendAfter(null);
        setRequestNotice("Your recovery request was cancelled. You can file a new one below.");
      } else {
        setRequestError(
          reread === undefined
            ? "The cancellation was sent, but your request could not be reloaded to confirm it. Refresh before filing a new one."
            : "The cancellation was sent, but your request does not show as cancelled yet. Refresh before filing a new one.",
        );
      }
    } finally {
      if (mountedRef.current) setRequestBusy(null);
    }
  }, [confirm, readDetail, requestBusy, requestId]);

  useEffect(() => {
    if (teamId) {
      setSelectedTeamId(teamId);
      setEligibility({ kind: "eligible" });
      return;
    }
    let cancelled = false;
    void (async () => {
      let authenticated = false;
      try {
        const probe = await apiFetch(
          "/v1/auth/session-light",
          { method: "GET" },
          { auth: false },
        );
        authenticated = Boolean(probe?.authenticated);
      } catch {
        authenticated = false;
      }
      if (cancelled || !mountedRef.current) return;
      if (!authenticated) {
        setEligibility({ kind: "no_session" });
        return;
      }
      try {
        const res = await apiFetch("/v1/teams", { method: "GET" });
        if (cancelled || !mountedRef.current) return;
        const rows: ReadonlyArray<WorkspaceOption> = Array.isArray(res?.teams)
          ? (res.teams as Array<{ id?: unknown; name?: unknown }>)
              .filter((t) => typeof t?.id === "string")
              .map((t) => ({
                id: String(t.id),
                name: typeof t.name === "string" ? t.name : "Workspace",
              }))
          : [];
        setWorkspaces(rows);
        if (rows.length === 0) {
          setEligibility({ kind: "no_workspace" });
          return;
        }
        setSelectedTeamId((prev) => prev || rows[0].id);
        setEligibility({ kind: "eligible" });
      } catch {
        if (cancelled || !mountedRef.current) return;
        setEligibility({ kind: "no_workspace" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const eligible = eligibility.kind === "eligible";

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (busy || !eligible) return;

      // Validation state for every required body field.
      const trimmed = reason.trim();
      let invalid = false;
      if (!selectedTeamId) {
        setWorkspaceError("Choose the workspace this account belongs to.");
        invalid = true;
      } else {
        setWorkspaceError(null);
      }
      if (trimmed.length < REASON_MIN) {
        setReasonError(
          `Describe what happened in at least ${REASON_MIN} characters so an administrator can judge the request.`,
        );
        invalid = true;
      } else if (trimmed.length > REASON_MAX) {
        setReasonError(`Keep the description under ${REASON_MAX} characters.`);
        invalid = true;
      } else {
        setReasonError(null);
      }
      if (invalid) return;

      const seq = ++submitSeqRef.current;
      setBusy(true);
      setOutcome({ kind: "idle" });
      try {
        const res = await apiFetch("/v1/identity/mfa-admin/recovery-requests", {
          method: "POST",
          body: JSON.stringify({ teamId: selectedTeamId, reason: trimmed }),
        });
        if (!mountedRef.current || seq !== submitSeqRef.current) return;
        const expiresAt =
          res && typeof res?.request?.expiresAt === "string"
            ? String(res.request.expiresAt)
            : null;
        setOutcome({ kind: "created", expiresAt });
        setReason("");
        setRequestNotice(null);
        setRequestError(null);
        if (res && typeof res?.request?.id === "string") setRequestId(String(res.request.id));
      } catch (err) {
        if (!mountedRef.current || seq !== submitSeqRef.current) return;
        const status = statusOf(err);
        if (status === 409) {
          setOutcome({ kind: "already_pending" });
          const pendingId = detailsOf(err).requestId;
          setRequestNotice(null);
          setRequestError(null);
          if (typeof pendingId === "string") setRequestId(pendingId);
        } else if (status === 403) {
          setOutcome({ kind: "denied" });
        } else if (status === 429) {
          setOutcome({ kind: "throttled" });
        } else if (status === 400 || status === 422) {
          setReasonError(
            "That description was not accepted. Rewrite it in plain language and try again.",
          );
          setOutcome({ kind: "idle" });
        } else {
          setOutcome({
            kind: "failed",
            message: toSafeUserError(err, {
              message:
                "The recovery request could not be filed. Nothing was changed on your account — try again shortly.",
            }).message,
          });
        }
      } finally {
        if (mountedRef.current && seq === submitSeqRef.current) setBusy(false);
      }
    },
    [busy, eligible, reason, selectedTeamId],
  );

  const disabledReason =
    eligibility.kind === "resolving"
      ? "Checking whether this browser can file a request…"
      : eligibility.kind === "no_session"
        ? "Filing a recovery request needs an active session. Sign in on a device that still works, or ask a workspace administrator to start the reset for you."
        : eligibility.kind === "no_workspace"
          ? "No workspace membership was found for this account, so there is no administrator who could approve a reset."
          : null;

  return (
    <section
      data-cc-mfa-recovery-request-panel
      data-cc-mfa-recovery-eligibility={eligibility.kind}
      aria-labelledby={`${reasonFieldId}-heading`}
      style={compact ? compactWrapStyle : wrapStyle}
    >
      <h2 id={`${reasonFieldId}-heading`} style={headingStyle}>
        Request an administrator reset
      </h2>
      <p style={mutedStyle}>
        If your authenticator and your recovery codes are both gone, file a
        request here. A workspace administrator reviews it. Approval only
        clears your second factor so you can enroll a new one — it never signs
        you in and never grants access on its own.
      </p>

      <form onSubmit={onSubmit} aria-busy={busy} noValidate>
        {!teamId ? (
          <div style={fieldStyle}>
            <label htmlFor={workspaceFieldId} style={labelStyle}>
              Workspace
            </label>
            <select
              id={workspaceFieldId}
              name="teamId"
              data-cc-mfa-recovery-request-workspace
              value={selectedTeamId}
              onChange={(e) => {
                setSelectedTeamId(e.target.value);
                setWorkspaceError(null);
              }}
              disabled={busy || !eligible}
              aria-invalid={workspaceError ? true : undefined}
              aria-describedby={
                workspaceError ? `${workspaceFieldId}-error` : undefined
              }
              style={inputStyle}
            >
              <option value="">Select a workspace…</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            {workspaceError ? (
              <p
                id={`${workspaceFieldId}-error`}
                role="alert"
                data-cc-mfa-recovery-request-workspace-error
                style={errorTextStyle}
              >
                {workspaceError}
              </p>
            ) : null}
          </div>
        ) : null}

        <div style={fieldStyle}>
          <label htmlFor={reasonFieldId} style={labelStyle}>
            What happened?
          </label>
          <textarea
            id={reasonFieldId}
            name="reason"
            rows={3}
            maxLength={REASON_MAX}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (reasonError) setReasonError(null);
            }}
            disabled={busy || !eligible}
            placeholder="e.g. My phone was replaced and the recovery codes were on it."
            data-cc-mfa-recovery-request-reason
            aria-invalid={reasonError ? true : undefined}
            aria-describedby={`${reasonFieldId}-hint${
              reasonError ? ` ${reasonFieldId}-error` : ""
            }`}
            style={{ ...inputStyle, resize: "vertical" }}
          />
          <p id={`${reasonFieldId}-hint`} style={hintStyle}>
            {REASON_MIN}–{REASON_MAX} characters. An administrator reads this.
            Do not include codes, passwords, or links.
          </p>
          {reasonError ? (
            <p
              id={`${reasonFieldId}-error`}
              role="alert"
              data-cc-mfa-recovery-request-reason-error
              style={errorTextStyle}
            >
              {reasonError}
            </p>
          ) : null}
        </div>

        <button
          type="submit"
          data-cc-mfa-recovery-request-submit
          disabled={busy || !eligible}
          style={{
            ...submitStyle,
            opacity: busy || !eligible ? 0.55 : 1,
            cursor: busy || !eligible ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Filing request…" : "File recovery request"}
        </button>

        {disabledReason ? (
          <p data-cc-mfa-recovery-request-blocked style={hintStyle}>
            {disabledReason}
          </p>
        ) : null}
      </form>

      {/* Screen-reader status channel for every terminal state. */}
      <div
        role="status"
        aria-live="polite"
        data-cc-mfa-recovery-request-status
        style={outcome.kind === "idle" && !busy ? srOnlyStyle : statusStyle}
      >
        {busy ? "Filing your recovery request…" : null}
        {!busy && outcome.kind === "created"
          ? "Request filed. Check your email for the verification link, then a workspace administrator reviews it."
          : null}
        {!busy && outcome.kind === "already_pending"
          ? "You already have a recovery request in flight for this workspace. Check your email for the verification link, or wait for an administrator to review it."
          : null}
        {!busy && outcome.kind === "denied"
          ? "This account is not an active member of that workspace, so a reset cannot be requested there."
          : null}
        {!busy && outcome.kind === "throttled"
          ? "Too many recovery requests from this account recently. Wait a while before filing another."
          : null}
        {!busy && outcome.kind === "failed" ? outcome.message : null}
      </div>

      {requestId ? (
        <PendingRequestSection
          detail={detail}
          busy={requestBusy}
          nextResendAfter={nextResendAfter}
          onResend={() => void onResend()}
          onCancel={() => void onCancelRequest()}
          onRetry={() => {
            setDetail({ kind: "loading" });
            void readDetail(requestId);
          }}
        />
      ) : null}
      {requestNotice ? (
        <p role="status" aria-live="polite" data-cc-mfa-recovery-request-notice style={hintStyle}>
          {requestNotice}
        </p>
      ) : null}
      {requestError ? (
        <p role="alert" data-cc-mfa-recovery-request-action-error style={errorTextStyle}>
          {requestError}
        </p>
      ) : null}
    </section>
  );
}

function PendingRequestSection({
  detail,
  busy,
  nextResendAfter,
  onResend,
  onCancel,
  onRetry,
}: {
  detail: DetailState;
  busy: "resend" | "cancel" | null;
  nextResendAfter: string | null;
  onResend: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const headingId = useId();
  const resendReasonId = useId();
  const cancelReasonId = useId();
  if (detail.kind === "loading") {
    return (
      <p role="status" style={hintStyle}>
        Loading your recovery request…
      </p>
    );
  }
  if (detail.kind === "gone") {
    return (
      <p role="alert" style={errorTextStyle}>
        This recovery request is no longer available.
      </p>
    );
  }
  if (detail.kind === "failed") {
    return (
      <p role="alert" style={errorTextStyle}>
        {detail.message}{" "}
        <button type="button" onClick={onRetry} style={secondaryStyle}>
          Retry
        </button>
      </p>
    );
  }
  const d = detail.detail;
  const open = OPEN_STATUSES.includes(d.status);
  const cooling = nextResendAfter !== null && new Date(nextResendAfter).getTime() > Date.now();
  const resendReason = busy
    ? null
    : d.status !== "EMAIL_VERIFICATION_PENDING"
      ? d.emailVerified
        ? "Your email is already confirmed, so no new link is needed."
        : "This request is no longer waiting for email confirmation."
      : d.emailResendCount >= EMAIL_MAX_SENDS
        ? "No more verification emails can be sent for this request. Cancel it and file a new one."
        : cooling
          ? `You can request another email after ${formatUserDateTime(nextResendAfter)}.`
          : null;
  const cancelReason = busy
    ? null
    : !open
      ? "Only a request that is still waiting can be cancelled."
      : null;
  return (
    <section
      aria-labelledby={headingId}
      aria-busy={busy !== null}
      data-cc-mfa-recovery-pending-request
      data-cc-mfa-recovery-pending-status={d.status}
      style={pendingStyle}
    >
      <h3 id={headingId} style={{ ...headingStyle, fontSize: 14 }}>
        Your recovery request
      </h3>
      <p style={mutedStyle}>
        {STATUS_COPY[d.status] ?? "Status unavailable."} Expires{" "}
        <time dateTime={d.expiresAt}>{formatUserDateTime(d.expiresAt)}</time>.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          type="button"
          onClick={onResend}
          disabled={busy !== null || resendReason !== null}
          aria-describedby={resendReason ? resendReasonId : undefined}
          data-cc-mfa-recovery-request-resend
          data-disabled-reason={resendReason ?? undefined}
          style={{ ...secondaryStyle, opacity: busy !== null || resendReason ? 0.55 : 1 }}
        >
          {busy === "resend" ? "Sending…" : "Resend verification email"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy !== null || cancelReason !== null}
          aria-describedby={cancelReason ? cancelReasonId : undefined}
          data-cc-mfa-recovery-request-cancel
          data-disabled-reason={cancelReason ?? undefined}
          style={{ ...dangerStyle, opacity: busy !== null || cancelReason ? 0.55 : 1 }}
        >
          {busy === "cancel" ? "Cancelling…" : "Cancel request"}
        </button>
      </div>
      {resendReason ? (
        <p id={resendReasonId} style={hintStyle}>
          {resendReason}
        </p>
      ) : null}
      {cancelReason ? (
        <p id={cancelReasonId} style={hintStyle}>
          {cancelReason}
        </p>
      ) : null}
    </section>
  );
}

const pendingStyle: CSSProperties = {
  marginTop: 12,
  padding: 12,
  border: "1px solid var(--border)",
  borderRadius: 10,
  overflowWrap: "anywhere",
};
const secondaryStyle: CSSProperties = {
  padding: "8px 14px",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "inherit",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 8,
  cursor: "pointer",
};
const dangerStyle: CSSProperties = {
  ...secondaryStyle,
  color: "var(--destructive)",
};

const wrapStyle: CSSProperties = {
  marginTop: 16,
  padding: 16,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const compactWrapStyle: CSSProperties = {
  marginTop: 24,
  padding: 16,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#f8fafc",
  textAlign: "left",
};
const headingStyle: CSSProperties = {
  margin: "0 0 6px",
  fontSize: 15,
  fontWeight: 650,
  color: "#0f172a",
};
const mutedStyle: CSSProperties = {
  margin: "0 0 12px",
  fontSize: 13,
  color: "#475569",
};
const fieldStyle: CSSProperties = { marginBottom: 12 };
const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#0f172a",
  marginBottom: 4,
};
const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  fontSize: 13,
  boxSizing: "border-box",
  fontFamily: "inherit",
};
const hintStyle: CSSProperties = {
  margin: "6px 0 0",
  fontSize: 12,
  color: "#64748b",
};
const errorTextStyle: CSSProperties = {
  margin: "6px 0 0",
  fontSize: 12,
  color: "#b91c1c",
};
const submitStyle: CSSProperties = {
  padding: "9px 16px",
  border: "1px solid #1d4ed8",
  background: "#1d4ed8",
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 8,
};
const statusStyle: CSSProperties = {
  marginTop: 12,
  padding: "8px 10px",
  background: "#f1f5f9",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  fontSize: 13,
  color: "#0f172a",
};
const srOnlyStyle: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};
