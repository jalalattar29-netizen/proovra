"use client";

/**
 * TEAM-UI-SPEC §1/§2/§5 — the review inspector's own dialogs, on the canonical
 * Modal (`components/cases-experience/matter-modals/Modal.tsx`): footer Cancel
 * (`app-secondary-action`) + one confirm (`app-primary-action`, or
 * `app-danger-action` when the step is irreversible). Fields use
 * `app-field-label` / `app-input`; a refusal is an `app-field-error` INSIDE the
 * dialog with the typed input kept; the confirm shows a loading state.
 *
 * Pause and Record response use the shared ReviewerReasonModal. The dialogs
 * here are the three the inspector alone needs:
 *
 *   ReassignDialog   POST /v1/reviewer-ops/reviews/:id/reassign
 *                    (second-review handoff mode never offers the first reviewer)
 *   EscalateDialog   POST /v1/reviewer-ops/escalations
 *                    { teamId, workflowId, reason, severity, safeSummary,
 *                      requireIndependentReview, independenceNote? } — states
 *                    the effect before raising (F-09)
 *   RequestIndependentReviewDialog
 *                    POST /v1/reviewer-ops/reviews/:id/request-independent-review
 *   LeaveUnsavedCodingDialog  the in-app navigation guard (F-16)
 *   ArchiveDialog    the irreversible archive confirm
 *
 * Each dialog's `onSubmit` resolves to an error message, or null on success;
 * the host performs the request, the step-up and the reload.
 */

import { useEffect, useId, useState } from "react";
import { INTEGRITY_ESCALATION_REASONS, describeEscalationIndependence, describeIndependenceStaffing } from "@proovra/shared";
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import { Modal } from "../../../../../components/cases-experience/matter-modals/Modal";
import { apiFetch } from "../../../../../lib/api";
import { reviewerIdentityLabel } from "../../../../../lib/reviewer-workspace/reviewer-identity";
import { escalationReasonLabel } from "../../../../../lib/labels/governanceReviewLabels";
import {
  COLLABORATION_TEAMS_HREF,
  PLACEMENT_ACTION_LABEL,
  isPlacedReviewer,
  placementPrerequisiteSentence,
} from "../../../../../lib/members/placement";

/** `placed: false` (T-097): not in a Collaboration Team; absent (older API) = placed. */
type AssignableReviewer = { userId: string; displayName: string | null; maskedEmail?: string | null; placed?: boolean };

function ConfirmFooter({
  formId,
  busy,
  disabled,
  label,
  busyLabel,
  danger = false,
  onCancel,
  testAttr,
}: {
  formId: string;
  busy: boolean;
  disabled: boolean;
  label: string;
  busyLabel: string;
  danger?: boolean;
  onCancel: () => void;
  testAttr: string;
}) {
  return (
    <>
      <button type="button" className="app-secondary-action" onClick={onCancel} disabled={busy} data-inspector-dialog-cancel>
        Cancel
      </button>
      <button
        type="submit"
        form={formId}
        className={danger ? "app-danger-action" : "app-primary-action"}
        disabled={busy || disabled}
        aria-busy={busy || undefined}
        data-inspector-dialog-confirm={testAttr}
      >
        {busy ? (
          <>
            <span className="app-spinner" aria-hidden="true" /> {busyLabel}
          </>
        ) : (
          label
        )}
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reassign
// ---------------------------------------------------------------------------

/** The reviewer picker's trigger: the dialog's first meaningful field. */
const REASSIGN_PICKER = "[data-reviewer-reassign-picker]";

export function ReassignDialog({
  open,
  teamId,
  handoff,
  excludeUserId,
  currentAssigneeUserId,
  onCancel,
  onSubmit,
  describeError,
}: {
  open: boolean;
  teamId: string;
  /** Second-review handoff: the first reviewer is never offered. */
  handoff: boolean;
  /** The first reviewer (handoff) — never offered. */
  excludeUserId: string | null;
  currentAssigneeUserId: string | null;
  onCancel: () => void;
  onSubmit: (newAssigneeUserId: string) => Promise<string | null>;
  describeError: (err: unknown) => string;
}) {
  const id = useId();
  const formId = `${id}-form`;
  const [reviewers, setReviewers] = useState<AssignableReviewer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setChoice("");
    setError(null);
    setLoadError(null);
    setReviewers(null);
    apiFetch(`/v1/reviewer-ops/assignable-reviewers?teamId=${encodeURIComponent(teamId)}&limit=200`, { method: "GET" })
      .then((r: { reviewers?: AssignableReviewer[] }) => {
        if (!live) return;
        setReviewers(
          (r?.reviewers ?? []).filter(
            (x) => x.userId !== excludeUserId && (handoff || x.userId !== currentAssigneeUserId),
          ),
        );
      })
      .catch((err: unknown) => {
        if (live) setLoadError(describeError(err));
      });
    return () => {
      live = false;
    };
  }, [open, teamId, excludeUserId, currentAssigneeUserId, handoff, describeError]);

  // Initial focus is the picker (Modal `initialFocus`). While the list loads
  // the dialog box holds focus; once the picker renders, focus moves to it —
  // only if the person has not moved focus themselves in the meantime.
  useEffect(() => {
    if (!open || reviewers === null) return;
    const active = typeof document !== "undefined" ? document.activeElement : null;
    if (!(active instanceof HTMLElement) || !active.matches('[role="dialog"][data-matter-modal="reviewer-reassign"]')) return;
    active.querySelector<HTMLElement>(REASSIGN_PICKER)?.focus();
  }, [open, reviewers]);

  if (!open) return null;
  const title = handoff ? "Assign an independent second reviewer" : "Reassign this review";
  return (
    <Modal
      open
      title={title}
      description={
        handoff
          ? "The first reviewer cannot take the second review. The server checks independence and eligibility."
          : "Move this review to another eligible reviewer. The server checks eligibility."
      }
      onClose={onCancel}
      dismissDisabled={busy}
      testid="reviewer-reassign"
      initialFocus={REASSIGN_PICKER}
      footer={
        <ConfirmFooter
          formId={formId}
          busy={busy}
          disabled={!choice || reviewers === null}
          label={handoff ? "Assign second reviewer" : "Reassign"}
          busyLabel="Assigning…"
          onCancel={onCancel}
          testAttr="reassign"
        />
      }
    >
      <form
        id={formId}
        noValidate
        data-reviewer-reassign-form={handoff ? "handoff" : "reassign"}
        onSubmit={(e) => {
          e.preventDefault();
          if (!choice || busy) return;
          setBusy(true);
          setError(null);
          void onSubmit(choice)
            .then((failure) => {
              if (failure) setError(failure);
            })
            .finally(() => setBusy(false));
        }}
        style={{ display: "grid", gap: 6, minWidth: 0 }}
      >
        <label className="app-field-label" htmlFor={`${id}-reviewer`}>
          {handoff ? "Second reviewer" : "New reviewer"}
        </label>
        {loadError ? (
          <p role="alert" className="app-field-error" data-review-handoff-picker-error style={{ margin: 0 }}>
            {loadError}
          </p>
        ) : reviewers === null ? (
          <p className="app-field-help" style={{ margin: 0 }}>
            Loading reviewers…
          </p>
        ) : (
          <AppListbox
            id={`${id}-reviewer`}
            value={choice}
            options={[
              { value: "", label: handoff ? "Choose a second reviewer…" : "Choose a reviewer…" },
              ...reviewers.map((r) => {
                const name = reviewerIdentityLabel(r);
                // T-097 — an unplaced person is listed, unavailable, with why.
                return isPlacedReviewer(r)
                  ? { value: r.userId, label: name }
                  : {
                      value: r.userId,
                      label: name,
                      description: placementPrerequisiteSentence(name),
                      disabled: true,
                    };
              }),
            ]}
            onChange={(next) => setChoice(next)}
            disabled={busy}
            wrapValue
            style={{ maxWidth: "100%" }}
            triggerProps={{ "data-review-handoff-picker": "", "data-reviewer-reassign-picker": "" }}
          />
        )}
        {reviewers !== null && reviewers.some((r) => !isPlacedReviewer(r)) ? (
          <p className="app-field-help" data-reviewer-reassign-unplaced style={{ margin: 0 }}>
            People who are not in a Collaboration Team yet cannot be given work.{" "}
            <a href={COLLABORATION_TEAMS_HREF} data-reviewer-reassign-place-action>
              {PLACEMENT_ACTION_LABEL}
            </a>
          </p>
        ) : null}
        {reviewers !== null && reviewers.length === 0 && !loadError ? (
          <p className="app-field-help" style={{ margin: 0 }}>
            No other eligible reviewer is available in this workspace.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="app-field-error" data-review-handoff-reassign-error style={{ margin: 0, overflowWrap: "anywhere" }}>
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Escalate
// ---------------------------------------------------------------------------

/** Reasons from the shared REVIEW_ESCALATION_REASONS catalog a person raises. */
const ESCALATE_REASONS = [
  "REVIEWER_ESCALATED",
  "INTEGRITY_RISK",
  "VERIFICATION_MISMATCH",
  "EVIDENCE_REQUEST_UNRESOLVED",
  "WORKFLOW_STALLED",
  "GOVERNANCE_BLOCKED",
] as const;

const ESCALATE_SEVERITIES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "INFO", label: "Info" },
  { value: "WARNING", label: "Warning" },
  { value: "HIGH", label: "High" },
  { value: "CRITICAL", label: "Critical" },
];

const SUMMARY_MAX = 400;
const INDEPENDENCE_NOTE_MAX = 400;

/** Integrity controls always require an independent second decision (§2.1) — the shared list. */
const INTEGRITY_REASONS: ReadonlySet<string> = new Set<string>(INTEGRITY_ESCALATION_REASONS);

export type EscalateInput = {
  reason: string;
  severity: string;
  safeSummary: string;
  /** F-09 — the raiser explicitly asks for an independent second decision. */
  requireIndependentReview: boolean;
  independenceNote: string | null;
};

/**
 * F-09 — how many OTHER people could give an independent second decision:
 * the SERVER's count (`countEligibleSecondReviewers`, read through the
 * decisions endpoint's `independentReviewerCount`), never a client recount.
 * null while unknown or unreadable (nothing is then claimed).
 */
function useOtherEligibleCount(open: boolean, teamId: string | null | undefined, workflowId: string | null | undefined) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!open || !teamId || !workflowId) return;
    let live = true;
    setCount(null);
    apiFetch(
      `/v1/reviewer-ops/workspace/${encodeURIComponent(workflowId)}/decisions?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((r: { independentReviewerCount?: number | null } | null) => {
        if (!live) return;
        setCount(typeof r?.independentReviewerCount === "number" ? r.independentReviewerCount : null);
      })
      .catch(() => {
        if (live) setCount(null);
      });
    return () => {
      live = false;
    };
  }, [open, teamId, workflowId]);
  return count;
}

export function EscalateDialog({
  open,
  onCancel,
  onSubmit,
  teamId = null,
  workflowId = null,
}: {
  open: boolean;
  onCancel: () => void;
  onSubmit: (input: EscalateInput) => Promise<string | null>;
  /** For the "nobody else is eligible" warning when independence is required. */
  teamId?: string | null;
  workflowId?: string | null;
}) {
  const id = useId();
  const formId = `${id}-form`;
  const [reason, setReason] = useState<string>(ESCALATE_REASONS[0]);
  const [severity, setSeverity] = useState("WARNING");
  const [summary, setSummary] = useState("");
  const [requireIndependent, setRequireIndependent] = useState(false);
  const [independenceNote, setIndependenceNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const forcesNow = INTEGRITY_REASONS.has(reason) || requireIndependent;
  // Read only when independence is being required — the only time it matters.
  const otherEligible = useOtherEligibleCount(open && forcesNow, teamId, workflowId);

  useEffect(() => {
    if (!open) return;
    setReason(ESCALATE_REASONS[0]);
    setSeverity("WARNING");
    setSummary("");
    setRequireIndependent(false);
    setIndependenceNote("");
    setError(null);
    setBusy(false);
  }, [open]);

  if (!open) return null;
  const trimmed = summary.trim();
  // F-09 / §2.1 — the effect is stated BEFORE raising: an integrity reason
  // always requires an independent second decision; any other reason only
  // when the raiser asks for it.
  const integrity = INTEGRITY_REASONS.has(reason);
  const forces = integrity || requireIndependent;
  const effect = describeEscalationIndependence(forces);
  const staffing = forces ? describeIndependenceStaffing(otherEligible) : null;
  return (
    <Modal
      open
      title="Escalate this review"
      description="Raises an escalation for the escalation managers. The summary is operational only — no allegations."
      onClose={onCancel}
      dismissDisabled={busy}
      testid="reviewer-escalate"
      footer={
        <ConfirmFooter
          formId={formId}
          busy={busy}
          disabled={!trimmed}
          label="Raise escalation"
          busyLabel="Raising…"
          onCancel={onCancel}
          testAttr="escalate"
        />
      }
    >
      <form
        id={formId}
        noValidate
        data-reviewer-escalate-form
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed || busy) return;
          setBusy(true);
          setError(null);
          void onSubmit({
            reason,
            severity,
            safeSummary: trimmed,
            requireIndependentReview: forces,
            independenceNote: forces && independenceNote.trim() ? independenceNote.trim() : null,
          })
            .then((failure) => {
              if (failure) setError(failure);
            })
            .finally(() => setBusy(false));
        }}
        style={{ display: "grid", gap: 6, minWidth: 0 }}
      >
        <label className="app-field-label" htmlFor={`${id}-reason`}>
          Reason
        </label>
        <AppListbox
          id={`${id}-reason`}
          value={reason}
          options={ESCALATE_REASONS.map((r) => ({ value: r, label: escalationReasonLabel(r) }))}
          onChange={(next) => setReason(next)}
          disabled={busy}
          wrapValue
          style={{ maxWidth: "100%" }}
          triggerProps={{ "data-reviewer-escalate-reason": "" }}
        />
        <label className="app-field-label" htmlFor={`${id}-severity`}>
          Severity
        </label>
        <AppListbox
          id={`${id}-severity`}
          value={severity}
          options={[...ESCALATE_SEVERITIES]}
          onChange={(next) => setSeverity(next)}
          disabled={busy}
          style={{ maxWidth: "100%" }}
          triggerProps={{ "data-reviewer-escalate-severity": "" }}
        />
        <label className="app-field-label" htmlFor={`${id}-summary`}>
          Summary
        </label>
        <textarea
          id={`${id}-summary`}
          className="app-input app-textarea"
          value={summary}
          onChange={(e) => setSummary(e.target.value.slice(0, SUMMARY_MAX))}
          disabled={busy}
          rows={3}
          required
          aria-describedby={`${id}-summary-help`}
          placeholder="For example: custody gap between capture and upload needs a manager's eye."
          data-reviewer-escalate-summary
          style={{ boxSizing: "border-box" }}
        />
        <p id={`${id}-summary-help`} className="app-field-help" style={{ margin: 0 }}>
          {summary.length}/{SUMMARY_MAX} characters. Operational facts only.
        </p>
        <label className="review-check-row" data-reviewer-escalate-require-independent-row>
          <input
            type="checkbox"
            className="app-checkbox"
            checked={forces}
            disabled={busy || integrity}
            aria-describedby={`${id}-independence`}
            data-reviewer-escalate-require-independent
            onChange={(e) => setRequireIndependent(e.target.checked)}
          />
          <span>Also require an independent second decision</span>
        </label>
        {integrity ? (
          <p className="app-field-help" data-reviewer-escalate-integrity style={{ margin: 0 }}>
            An integrity concern always requires an independent second decision; it cannot be turned off.
          </p>
        ) : null}
        {forces ? (
          <>
            <label className="app-field-label" htmlFor={`${id}-independence-note`}>
              Note for the second reviewer <span className="app-field-optional">(optional)</span>
            </label>
            <textarea
              id={`${id}-independence-note`}
              className="app-input app-textarea"
              value={independenceNote}
              onChange={(e) => setIndependenceNote(e.target.value.slice(0, INDEPENDENCE_NOTE_MAX))}
              disabled={busy}
              rows={2}
              data-reviewer-escalate-independence-note
              style={{ boxSizing: "border-box" }}
            />
          </>
        ) : null}
        {effect ? (
          <p
            id={`${id}-independence`}
            className="app-field-help"
            data-reviewer-escalate-independence={forces ? "required" : "administrative"}
            style={{ margin: 0, overflowWrap: "anywhere" }}
          >
            {effect}
          </p>
        ) : null}
        {staffing ? (
          <p role="note" className="app-field-help" data-reviewer-escalate-staffing style={{ margin: 0, overflowWrap: "anywhere" }}>
            {staffing}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="app-field-error" data-reviewer-escalate-error style={{ margin: 0, overflowWrap: "anywhere" }}>
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Request independent review (review remediation 2026-11-27, §2.1)
// ---------------------------------------------------------------------------

export const REQUEST_INDEPENDENT_REVIEW_SUCCESS =
  "Independent review requested. The decision now needs a second reviewer.";

/**
 * POST /v1/reviewer-ops/reviews/:id/request-independent-review { teamId, note }
 * — the explicit, auditable request. The note (1–400 characters) is required.
 */
export function RequestIndependentReviewDialog({
  open,
  onCancel,
  onSubmit,
  teamId = null,
  workflowId = null,
}: {
  open: boolean;
  onCancel: () => void;
  onSubmit: (note: string) => Promise<string | null>;
  teamId?: string | null;
  workflowId?: string | null;
}) {
  const id = useId();
  const formId = `${id}-form`;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const otherEligible = useOtherEligibleCount(open, teamId, workflowId);

  useEffect(() => {
    if (!open) return;
    setNote("");
    setError(null);
    setBusy(false);
  }, [open]);

  if (!open) return null;
  const trimmed = note.trim();
  const staffing = describeIndependenceStaffing(otherEligible);
  return (
    <Modal
      open
      title="Request independent review"
      description="The decision on this review will then need a second, independent reviewer before it is final."
      onClose={onCancel}
      dismissDisabled={busy}
      testid="reviewer-request-independent"
      footer={
        <ConfirmFooter
          formId={formId}
          busy={busy}
          disabled={!trimmed}
          label="Request independent review"
          busyLabel="Requesting…"
          onCancel={onCancel}
          testAttr="request-independent-review"
        />
      }
    >
      <form
        id={formId}
        noValidate
        data-reviewer-request-independent-form
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed || busy) return;
          setBusy(true);
          setError(null);
          void onSubmit(trimmed)
            .then((failure) => {
              if (failure) setError(failure);
            })
            .finally(() => setBusy(false));
        }}
        style={{ display: "grid", gap: 6, minWidth: 0 }}
      >
        <p className="app-field-help" style={{ margin: 0 }}>
          {describeEscalationIndependence(true)}
        </p>
        <label className="app-field-label" htmlFor={`${id}-note`}>
          Why is an independent review needed?
        </label>
        <textarea
          id={`${id}-note`}
          className="app-input app-textarea"
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, INDEPENDENCE_NOTE_MAX))}
          disabled={busy}
          rows={3}
          required
          aria-describedby={`${id}-note-help`}
          data-reviewer-request-independent-note
          style={{ boxSizing: "border-box" }}
        />
        <p id={`${id}-note-help`} className="app-field-help" style={{ margin: 0 }}>
          {note.length}/{INDEPENDENCE_NOTE_MAX} characters. Required.
        </p>
        {staffing ? (
          <p role="note" className="app-field-help" data-reviewer-request-independent-staffing style={{ margin: 0 }}>
            {staffing}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="app-field-error" data-reviewer-request-independent-error style={{ margin: 0, overflowWrap: "anywhere" }}>
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Leave with unsaved coding (F-16 in-app navigation guard)
// ---------------------------------------------------------------------------

export function LeaveUnsavedCodingDialog({
  open,
  onStay,
  onLeave,
}: {
  open: boolean;
  onStay: () => void;
  onLeave: () => void;
}) {
  if (!open) return null;
  return (
    <Modal
      open
      title="Leave with unsaved coding?"
      description="Some coded values are still saving or were not saved. If you leave now, those changes may be lost."
      onClose={onStay}
      testid="reviewer-leave-unsaved-coding"
      footer={
        <>
          <button type="button" className="app-secondary-action" onClick={onStay} data-review-leave-stay>
            Stay on this review
          </button>
          <button type="button" className="app-danger-action" onClick={onLeave} data-review-leave-confirm>
            Leave anyway
          </button>
        </>
      }
    >
      <p className="app-field-help" style={{ margin: 0 }} data-review-leave-unsaved>
        Wait for the coding fields to show “Saved”, or retry the ones marked “Not saved”, before leaving.
      </p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

export function ArchiveDialog({
  open,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  onCancel: () => void;
  onSubmit: (note: string) => Promise<string | null>;
}) {
  const id = useId();
  const formId = `${id}-form`;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setNote("");
    setError(null);
    setBusy(false);
  }, [open]);

  if (!open) return null;
  return (
    <Modal
      open
      title="Archive this review?"
      description="Archiving ends this review. It keeps whatever the current round decided and cannot be undone from here."
      onClose={onCancel}
      dismissDisabled={busy}
      testid="reviewer-archive"
      footer={
        <ConfirmFooter
          formId={formId}
          busy={busy}
          disabled={false}
          label="Archive review"
          busyLabel="Archiving…"
          danger
          onCancel={onCancel}
          testAttr="archive"
        />
      }
    >
      <form
        id={formId}
        noValidate
        data-reviewer-archive-form
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError(null);
          void onSubmit(note.trim())
            .then((failure) => {
              if (failure) setError(failure);
            })
            .finally(() => setBusy(false));
        }}
        style={{ display: "grid", gap: 6, minWidth: 0 }}
      >
        <p className="app-dialog__subtitle" style={{ marginTop: 0 }}>
          Archiving ends this review. It keeps whatever the current round decided — it is not a verdict — and
          cannot be undone from here.
        </p>
        <label className="app-field-label" htmlFor={`${id}-note`}>
          Note <span className="app-field-optional">(optional)</span>
        </label>
        <textarea
          id={`${id}-note`}
          className="app-input app-textarea"
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 1000))}
          disabled={busy}
          rows={2}
          data-reviewer-archive-note
          style={{ boxSizing: "border-box" }}
        />
        {error ? (
          <p role="alert" className="app-field-error" data-reviewer-archive-error style={{ margin: 0, overflowWrap: "anywhere" }}>
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
