"use client";

/**
 * PHASE 13 — organization membership lifecycle (the reversible half).
 *
 *   POST /v1/orgs/:id/members/:memberId/suspend
 *   POST /v1/orgs/:id/members/:memberId/restore
 *
 * Both routes have existed since ARCH-004 and had no product surface: the
 * only membership control the console offered was DELETE, so "pause this
 * person's access" was performed as "remove and re-invite", which destroyed
 * the history. These are the controls that make the reversible transition
 * reachable.
 *
 * Contract, read from services/api/src/routes/organizations.routes.ts:1740:
 *
 *   body      { reason?: string(1..400), expectedGeneration?: int }
 *   200       { membershipId, status, generation, changed }
 *   403       caller is not ORG_ADMIN+, or an ORG_OWNER target acted on by a
 *             non-owner
 *   404       membership not found
 *   409       self-action · last ORG_OWNER · STALE_MEMBERSHIP_GENERATION ·
 *             ILLEGAL_MEMBERSHIP_TRANSITION
 *
 * Suspension is destructive (it revokes live sessions), so it requires an
 * explicit confirmation step AND a typed reason before the request leaves.
 * Restore is reversible and goes straight through.
 *
 * STATE: the roster projects the membership lifecycle (NEW-031), so this
 * component offers ONLY the transition that applies to the row's current
 * status — Suspend for ACTIVE, Restore for SUSPENDED, neither for REVOKED.
 * The server's ILLEGAL_MEMBERSHIP_TRANSITION conflict is still handled, but it
 * is now a RACE (someone else changed the row) rather than the normal way to
 * discover which button does anything.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../ui/Button";
import { apiFetch } from "../../lib/api";
// The ONE timestamp authority for the web app. Formatting a date inline here
// would use the browser's own locale and zone, which is how two people looking
// at the same suspension read two different dates — and it is what
// `timestamp-policy.contract.test.ts` refuses outside `lib/date`.
import { formatUserDate } from "../../lib/date";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";

type Action = "suspend" | "restore";

const MAX_REASON = 400;

export interface OrgMemberLifecycleControlsProps {
  orgId: string;
  membershipId: string;
  /** Display name / email — used in confirmation + announcement copy. */
  memberLabel: string;
  /** ORG_ADMIN+ projection from GET /v1/orgs/:id (callerRole). */
  canManage: boolean;
  /** The route refuses self-action with a 409; the control says so first. */
  isSelf: boolean;
  /** The membership's CURRENT lifecycle state, from the roster projection. */
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  suspendedAtUtc?: string | null;
  suspensionReason?: string | null;
  revokedAtUtc?: string | null;
  revocationReason?: string | null;
  /** Re-reads the roster. Never a local mutation. */
  onChanged: () => void | Promise<void>;
}

function denialCopy(err: unknown, action: Action): string {
  const e = err as { statusCode?: number; code?: string };
  const status = typeof e.statusCode === "number" ? e.statusCode : 0;
  const code = typeof e.code === "string" ? e.code : "";

  if (status === 403) {
    return "You don't have permission to change this member's status. Organization admins can suspend and restore members; only an owner can act on another owner.";
  }
  if (status === 404) {
    return "That membership no longer exists. The roster has been reloaded.";
  }
  if (code === "STALE_MEMBERSHIP_GENERATION") {
    return "This membership changed while you were looking at it. The roster has been reloaded — review it and try again.";
  }
  if (code === "ILLEGAL_MEMBERSHIP_TRANSITION") {
    return action === "suspend"
      ? "This membership is not active, so it cannot be suspended."
      : "This membership is not suspended, so there is nothing to restore.";
  }
  if (status === 409) {
    return "That change isn't allowed: you cannot change your own membership, and the last remaining owner cannot be suspended.";
  }
  // >= 500 and anything unexpected — bounded, sanitized, never a raw body.
  return toSafeUserError(err, {
    message:
      action === "suspend"
        ? "Could not suspend this member. Nothing was changed."
        : "Could not restore this member. Nothing was changed.",
  }).message;
}

export function OrgMemberLifecycleControls({
  orgId,
  membershipId,
  memberLabel,
  canManage,
  isSelf,
  status,
  suspendedAtUtc = null,
  suspensionReason = null,
  revokedAtUtc = null,
  revocationReason = null,
  onChanged,
}: OrgMemberLifecycleControlsProps) {
  const [busy, setBusy] = useState<Action | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Stale-response protection: a response is applied only when it belongs to
  // the newest request AND the component is still mounted.
  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(
    async (action: Action) => {
      const trimmed = reason.trim();
      if (action === "suspend") {
        if (trimmed.length === 0) {
          setValidationError("Give a reason — it is recorded on the audit event.");
          return;
        }
        if (trimmed.length > MAX_REASON) {
          setValidationError(`Keep the reason under ${MAX_REASON} characters.`);
          return;
        }
      }
      setValidationError(null);
      setError(null);
      setNotice(null);
      setBusy(action);
      const seq = ++seqRef.current;

      try {
        await apiFetch(`/v1/orgs/${orgId}/members/${membershipId}/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            action === "suspend" && trimmed ? { reason: trimmed } : {},
          ),
        });
        if (!mountedRef.current || seq !== seqRef.current) return;
        setConfirming(false);
        setReason("");
        setNotice(
          action === "suspend"
            ? `${memberLabel} is suspended. Their sessions have been revoked; the membership is kept and can be restored.`
            : `${memberLabel} is active again.`,
        );
        await onChanged();
      } catch (err) {
        if (!mountedRef.current || seq !== seqRef.current) return;
        setError(denialCopy(err, action));
        const e = err as { statusCode?: number; code?: string };
        if (e.statusCode === 404 || e.code === "STALE_MEMBERSHIP_GENERATION") {
          await onChanged();
        }
      } finally {
        if (mountedRef.current && seq === seqRef.current) setBusy(null);
      }
    },
    [reason, orgId, membershipId, memberLabel, onChanged],
  );

  const disabled = !canManage || isSelf || busy !== null;

  /**
   * Which transition the CURRENT state admits.
   *
   * REVOKED offers neither transition here.
   *
   * PHASE 13 (NEW-038) — the previous version of this comment said the routes
   * answer `ILLEGAL_MEMBERSHIP_TRANSITION` for restore-from-revoked. They do
   * not: `restoreOrganizationMembership` explicitly PERMITS `REVOKED -> ACTIVE`
   * and its own docblock calls it "a real administrative need (a mistaken
   * removal)". So the reason for withholding the control is a PRODUCT decision
   * — revocation is presented to an administrator as terminal, and undoing one
   * is a deliberate act that should not sit one click away from the roster —
   * and not a server constraint. Stated correctly, because a comment that
   * invents a server rule is how the next reader concludes the API is missing a
   * capability it already has.
   *
   * The consequence is real and worth naming: an administrator who revokes in
   * error has no product path back today, while the API supports one.
   */
  const canSuspend = status === "ACTIVE";
  const canRestore = status === "SUSPENDED";

  return (
    <div
      data-org-member-lifecycle={membershipId}
      aria-busy={busy !== null}
      style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {canSuspend ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || confirming}
          loading={busy === "suspend"}
          onClick={() => {
            setError(null);
            setNotice(null);
            setValidationError(null);
            setConfirming(true);
          }}
          data-action="suspend-org-member"
          data-testid={`member-suspend-${membershipId}`}
          aria-label={`Suspend ${memberLabel}`}
        >
          Suspend…
        </Button>
        ) : null}
        {canRestore ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          loading={busy === "restore"}
          onClick={() => void run("restore")}
          data-action="restore-org-member"
          data-testid={`member-restore-${membershipId}`}
          aria-label={`Restore ${memberLabel}`}
        >
          Restore
        </Button>
        ) : null}
      </div>

      {/* Why no transition is offered, said plainly rather than left blank. */}
      {status === "REVOKED" ? (
        <p
          data-state="revoked-terminal"
          style={{ margin: 0, fontSize: 12, color: "var(--ink-muted, #94a3b8)" }}
        >
          This membership was revoked
          {revokedAtUtc ? ` on ${formatUserDate(revokedAtUtc)}` : ""}
          {revocationReason ? ` — ${revocationReason}` : ""}. Revoking is final;
          invite the person again to restore access.
        </p>
      ) : null}
      {status === "SUSPENDED" && (suspendedAtUtc || suspensionReason) ? (
        <p
          data-state="suspended-detail"
          style={{ margin: 0, fontSize: 12, color: "var(--ink-muted, #94a3b8)" }}
        >
          Suspended
          {suspendedAtUtc ? ` on ${formatUserDate(suspendedAtUtc)}` : ""}
          {suspensionReason ? ` — ${suspensionReason}` : ""}.
        </p>
      ) : null}

      {!canManage ? (
        <p data-state="forbidden" style={{ margin: 0, fontSize: 12, color: "var(--ink-muted, #94a3b8)" }}>
          You don&apos;t have permission to change member status.
        </p>
      ) : null}
      {canManage && isSelf ? (
        <p data-state="self-action-blocked" style={{ margin: 0, fontSize: 12, color: "var(--ink-muted, #94a3b8)" }}>
          You can&apos;t change your own membership status.
        </p>
      ) : null}

      {/* Explicit confirmation step — the request does not leave until the
          operator confirms AND supplies a reason. */}
      {confirming ? (
        <div
          data-org-member-suspend-confirm={membershipId}
          style={{
            marginTop: 4,
            padding: "10px 12px",
            border: "1px solid var(--border-default, rgba(15,23,42,0.14))",
            borderRadius: 10,
            background: "var(--surface-card, #ffffff)",
            maxWidth: 420,
          }}
        >
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-secondary, #475569)" }}>
            Suspend <strong>{memberLabel}</strong>? Their organization access
            stops immediately and their signed-in sessions are revoked. The
            membership and its history are kept, and you can restore it later.
          </p>
          <label
            htmlFor={`suspend-reason-${membershipId}`}
            style={{ display: "block", marginTop: 8, fontSize: 12, fontWeight: 600, color: "var(--ink-secondary, #475569)" }}
          >
            Reason (recorded on the audit event)
          </label>
          <input
            id={`suspend-reason-${membershipId}`}
            type="text"
            value={reason}
            maxLength={MAX_REASON}
            onChange={(e) => {
              setReason(e.target.value);
              if (validationError) setValidationError(null);
            }}
            disabled={busy !== null}
            data-testid={`member-suspend-reason-${membershipId}`}
            aria-invalid={validationError ? true : undefined}
            style={{
              marginTop: 4,
              width: "100%",
              minHeight: 34,
              padding: "0 10px",
              fontSize: 13,
              border: "1px solid var(--border-default, rgba(15,23,42,0.14))",
              borderRadius: 8,
              background: "var(--surface-card, #ffffff)",
              color: "var(--ink-primary, #0f172a)",
            }}
          />
          {validationError ? (
            <p
              data-state="invalid"
              style={{ margin: "6px 0 0", fontSize: 12, color: "var(--status-risk-fg, #991b1b)" }}
            >
              {validationError}
            </p>
          ) : null}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              loading={busy === "suspend"}
              disabled={busy !== null}
              onClick={() => void run("suspend")}
              data-action="confirm-suspend-org-member"
              data-testid={`member-suspend-confirm-${membershipId}`}
            >
              Confirm suspension
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                setConfirming(false);
                setReason("");
                setValidationError(null);
              }}
              data-action="cancel-suspend-org-member"
            >
              Keep active
            </Button>
          </div>
        </div>
      ) : null}

      {/* One announcement region for both outcomes. */}
      <div
        role="status"
        aria-live="polite"
        data-org-member-lifecycle-status={membershipId}
        style={{ fontSize: 12, color: error ? "var(--status-risk-fg, #991b1b)" : "var(--ink-secondary, #475569)" }}
      >
        {busy === "suspend"
          ? "Suspending…"
          : busy === "restore"
            ? "Restoring…"
            : error
              ? error
              : notice
                ? notice
                : ""}
      </div>
    </div>
  );
}

export default OrgMemberLifecycleControls;
