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
 *                    { teamId, workflowId, reason, severity, safeSummary }
 *   ArchiveDialog    the irreversible archive confirm
 *
 * Each dialog's `onSubmit` resolves to an error message, or null on success;
 * the host performs the request, the step-up and the reload.
 */

import { useEffect, useId, useState } from "react";
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import { Modal } from "../../../../../components/cases-experience/matter-modals/Modal";
import { apiFetch } from "../../../../../lib/api";
import { recordReference } from "../../../../../lib/short-id";
import { escalationReasonLabel } from "../../../../../lib/labels/governanceReviewLabels";

type AssignableReviewer = { userId: string; displayName: string | null };

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
              ...reviewers.map((r) => ({
                value: r.userId,
                label: r.displayName?.trim() || recordReference("Reviewer", r.userId),
              })),
            ]}
            onChange={(next) => setChoice(next)}
            disabled={busy}
            style={{ maxWidth: "100%" }}
            triggerProps={{ "data-review-handoff-picker": "", "data-reviewer-reassign-picker": "" }}
          />
        )}
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

export type EscalateInput = { reason: string; severity: string; safeSummary: string };

export function EscalateDialog({
  open,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  onCancel: () => void;
  onSubmit: (input: EscalateInput) => Promise<string | null>;
}) {
  const id = useId();
  const formId = `${id}-form`;
  const [reason, setReason] = useState<string>(ESCALATE_REASONS[0]);
  const [severity, setSeverity] = useState("WARNING");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setReason(ESCALATE_REASONS[0]);
    setSeverity("WARNING");
    setSummary("");
    setError(null);
    setBusy(false);
  }, [open]);

  if (!open) return null;
  const trimmed = summary.trim();
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
          void onSubmit({ reason, severity, safeSummary: trimmed })
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
