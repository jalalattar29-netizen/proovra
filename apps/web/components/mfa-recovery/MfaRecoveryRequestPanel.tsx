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
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";

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

type ErrorLike = { statusCode?: number; code?: string };

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
      } catch (err) {
        if (!mountedRef.current || seq !== submitSeqRef.current) return;
        const status = statusOf(err);
        if (status === 409) {
          setOutcome({ kind: "already_pending" });
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
    </section>
  );
}

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
