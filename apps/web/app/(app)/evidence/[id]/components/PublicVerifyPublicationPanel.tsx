"use client";

/**
 * PHASE 13 — Public verification publication controls.
 *
 * The evidence detail page could READ its publication posture (the
 * `publicVerificationSummary` envelope, plus GovernanceIndicators' call to
 * `/v1/governance/evidence/:id/status`) but had no way to change it. Both
 * registered write routes were unreachable from the product:
 *
 *   POST /v1/governance/evidence/:id/publish
 *   POST /v1/governance/evidence/:id/unpublish
 *     body  { teamId: uuid, reason?: string | null  (max 400) }
 *     200   { publication: { state, publishedAtUtc, publishedByUserId,
 *                            suspendedAtUtc, suspendedByUserId } }
 *     401   STEP_UP_REQUIRED  (purpose PUBLIC_VERIFY_PUBLISH / _UNPUBLISH)
 *     403   caller lacks `evidence.publish_verify`
 *     404   evidence_not_in_workspace (also the anti-enumeration answer)
 *     409   invalid_state_transition
 *     412   publication_approval_required
 *     422   reason_required
 *
 * Publishing exposes a record on the public verify route, so it is treated
 * as irreversible-in-effect: a typed confirmation is required before the
 * request is issued. Unpublishing is confirmed too — the policy copy in
 * WorkspaceGovernancePolicySection is explicit that turning the workspace
 * policy off does NOT unpublish anything, so this control is the only way
 * a published page comes down.
 *
 * The step-up gate is composed, not bypassed: the request runs through
 * `useStepUpAction`, so a 401 STEP_UP_REQUIRED opens the canonical
 * challenge modal and the action is retried once with the challenge id.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../components/identity-security/StepUpModal";
import type { ReviewWorkspaceResponse } from "../review-workspace-types";

const REASON_MAX = 400;

type Summary = ReviewWorkspaceResponse["publicVerificationSummary"];

type ErrorLike = { statusCode?: number; code?: string };

function statusOf(err: unknown): number {
  const e = err as ErrorLike | null;
  return typeof e?.statusCode === "number" ? e.statusCode : 0;
}

function isStepUpCancel(err: unknown): boolean {
  return (err as ErrorLike | null)?.code === "STEP_UP_CANCEL";
}

export default function PublicVerifyPublicationPanel({
  evidenceId,
  teamId,
  summary,
  publicVerifyIncluded,
  onChanged,
}: {
  evidenceId: string;
  teamId: string | null;
  summary: Summary;
  publicVerifyIncluded: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const reasonFieldId = useId();
  const { confirm } = useConfirmAction();
  const stepUp = useStepUpAction({ teamId });

  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [pending, setPending] = useState<"publish" | "unpublish" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // Stale-response protection: only the newest action may write state.
  const mountedRef = useRef(true);
  const seqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const published = summary.state === "PUBLISHED";
  const busy = pending !== null;

  // "Not permitted" is a real, visible state — not a hidden control.
  const blockedReason = !teamId
    ? "Open this record inside a workspace to change its public verification."
    : !publicVerifyIncluded
      ? "Public verification is not included in this workspace's plan."
      : !summary.enabled
        ? summary.disabledReason ||
          "Public verification is turned off for this workspace by policy."
        : !published && !summary.configured
          ? "This record has no publishable verification surface configured yet."
          : null;
  const permitted = blockedReason === null;

  const run = useCallback(
    async (action: "publish" | "unpublish") => {
      if (busy || !permitted || !teamId) return;

      // Validation state for the one optional-but-bounded body field.
      const trimmed = reason.trim();
      if (trimmed.length > REASON_MAX) {
        setReasonError(`Keep the note under ${REASON_MAX} characters.`);
        return;
      }
      setReasonError(null);

      const ok = await confirm(
        action === "publish"
          ? {
              title: "Publish this record to public verification?",
              description:
                "Anyone holding the verification link will be able to confirm this record's integrity without signing in. Internal notes, case context, and the capture note are never included. You can withdraw it again, but any link already shared will have been live.",
              confirmLabel: "Publish to public verify",
              cancelLabel: "Keep it internal",
              tone: "danger",
              requireConfirmText: "PUBLISH",
              testId: "evidence-public-verify-publish",
            }
          : {
              title: "Withdraw this record from public verification?",
              description:
                "The public verification page stops resolving immediately. Anyone holding the link will see that it is no longer available. The record itself, its custody chain, and its report are unaffected.",
              confirmLabel: "Withdraw from public verify",
              cancelLabel: "Leave it published",
              tone: "danger",
              testId: "evidence-public-verify-unpublish",
            },
      );
      if (!ok || !mountedRef.current) return;

      const seq = ++seqRef.current;
      setPending(action);
      setNotice(null);
      setProblem(null);
      try {
        await stepUp.runStepUpAction(async (headers) =>
          apiFetch(
            `/v1/governance/evidence/${encodeURIComponent(evidenceId)}/${action}`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                teamId,
                reason: trimmed ? trimmed : null,
              }),
            },
          ),
        );
        if (!mountedRef.current || seq !== seqRef.current) return;
        setReason("");
        setNotice(
          action === "publish"
            ? "This record is now published to public verification."
            : "This record has been withdrawn from public verification.",
        );
        // Success refreshes the underlying data.
        await onChanged();
      } catch (err) {
        if (!mountedRef.current || seq !== seqRef.current) return;
        if (isStepUpCancel(err)) {
          setProblem("Step-up verification was cancelled. Nothing changed.");
          return;
        }
        const status = statusOf(err);
        if (status === 403) {
          setProblem(
            "You do not have permission to change public verification for this workspace.",
          );
        } else if (status === 404) {
          setProblem(
            "This record could not be addressed in the active workspace. Switch workspace and try again.",
          );
        } else if (status === 409) {
          setProblem(
            "Public verification has already moved on. Reload the record to see its current state.",
          );
          await onChanged();
        } else if (status === 412) {
          setProblem(
            "Workspace policy requires a completed review before this record can be published.",
          );
        } else if (status === 422) {
          setReasonError("A note is required for this change. Add one and retry.");
        } else {
          setProblem(
            toSafeUserError(err, {
              message:
                "Public verification could not be changed. Nothing on this record was altered — try again shortly.",
            }).message,
          );
        }
      } finally {
        if (mountedRef.current && seq === seqRef.current) setPending(null);
      }
    },
    [
      busy,
      confirm,
      evidenceId,
      onChanged,
      permitted,
      reason,
      stepUp,
      teamId,
    ],
  );

  return (
    <section
      className="evidence-detail-section"
      data-evidence-section="public-verify-publication"
      data-cc-public-verify-state={summary.state}
      aria-labelledby={`${reasonFieldId}-heading`}
      aria-busy={busy}
    >
      <div className="evidence-detail-section-header">
        <h3 id={`${reasonFieldId}-heading`} style={headingStyle}>
          Public verification
        </h3>
      </div>
      <p style={mutedStyle}>
        Current state: <strong>{summary.state.replace(/_/g, " ")}</strong>.
        Publishing lets anyone with the link confirm this record&apos;s
        integrity without signing in. It does not assert legal admissibility.
      </p>

      <div style={fieldStyle}>
        <label htmlFor={reasonFieldId} style={labelStyle}>
          Internal note (optional)
        </label>
        <textarea
          id={reasonFieldId}
          name="reason"
          rows={2}
          maxLength={REASON_MAX}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            if (reasonError) setReasonError(null);
          }}
          disabled={busy || !permitted}
          placeholder="Why is this being published or withdrawn?"
          data-cc-public-verify-reason
          aria-invalid={reasonError ? true : undefined}
          aria-describedby={
            reasonError ? `${reasonFieldId}-error` : `${reasonFieldId}-hint`
          }
          style={textareaStyle}
        />
        <p id={`${reasonFieldId}-hint`} style={hintStyle}>
          Recorded in the custody chain only. Never shown on the public page.
          Up to {REASON_MAX} characters.
        </p>
        {reasonError ? (
          <p
            id={`${reasonFieldId}-error`}
            role="alert"
            data-cc-public-verify-reason-error
            style={errorTextStyle}
          >
            {reasonError}
          </p>
        ) : null}
      </div>

      <div style={buttonRowStyle}>
        {published ? (
          <button
            type="button"
            data-cc-public-verify-unpublish
            onClick={() => void run("unpublish")}
            disabled={busy || !permitted}
            style={{
              ...dangerButtonStyle,
              opacity: busy || !permitted ? 0.55 : 1,
              cursor: busy || !permitted ? "not-allowed" : "pointer",
            }}
          >
            {pending === "unpublish"
              ? "Withdrawing…"
              : "Withdraw from public verify"}
          </button>
        ) : (
          <button
            type="button"
            data-cc-public-verify-publish
            onClick={() => void run("publish")}
            disabled={busy || !permitted}
            style={{
              ...primaryButtonStyle,
              opacity: busy || !permitted ? 0.55 : 1,
              cursor: busy || !permitted ? "not-allowed" : "pointer",
            }}
          >
            {pending === "publish" ? "Publishing…" : "Publish to public verify"}
          </button>
        )}
      </div>

      {blockedReason ? (
        <p data-cc-public-verify-blocked style={hintStyle}>
          {blockedReason}
        </p>
      ) : null}

      {/* Screen-reader status channel for every terminal state. */}
      <div
        role="status"
        aria-live="polite"
        data-cc-public-verify-status
        style={notice || problem ? statusStyle : srOnlyStyle}
      >
        {busy
          ? pending === "publish"
            ? "Publishing this record to public verification…"
            : "Withdrawing this record from public verification…"
          : null}
        {!busy && problem ? problem : null}
        {!busy && !problem && notice ? notice : null}
      </div>

      <StepUpModal control={stepUp} />
    </section>
  );
}

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 650,
};
const mutedStyle: CSSProperties = {
  margin: "4px 0 12px",
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
const textareaStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  fontSize: 13,
  boxSizing: "border-box",
  fontFamily: "inherit",
  resize: "vertical",
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
const buttonRowStyle: CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap" };
const primaryButtonStyle: CSSProperties = {
  padding: "8px 14px",
  border: "1px solid #1d4ed8",
  background: "#1d4ed8",
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 8,
};
const dangerButtonStyle: CSSProperties = {
  padding: "8px 14px",
  border: "1px solid #dc2626",
  background: "#fff",
  color: "#b91c1c",
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
