"use client";

/**
 * Structured reviewer reason dialog.
 *
 * Collects the operator-typed reason for reviewer actions (pause, record
 * response, escalation reassign / resolve / suppress).
 *
 * TEAM-UI-SPEC §2 — Reject and Request information are no longer dialogs: a
 * verdict is entered only in the inspector's "Record decision" panel.
 *
 * Built on the canonical dialog (`components/cases-experience/matter-modals/
 * Modal.tsx`: `.app-dialog*`, portal, focus trap, focus restore, Escape). It
 * used to paint its own dark inline theme with no trap and no portal.
 *
 * Hard rules:
 *   - Backend is authoritative. The dialog only validates client-side; the
 *     route still enforces transition, permission and length limits.
 *   - A reason is required (except where the kind says it is optional) and is
 *     bounded to 400 characters.
 *   - Escape, the close button and the overlay close it only when nothing is
 *     in flight.
 *   - A refusal is shown INSIDE the dialog (the `error` prop), and the typed
 *     reason is kept for the retry.
 *   - The public props (`kind`, `open`, `onCancel`, `onSubmit`) are unchanged;
 *     `error` is additive.
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useId, useState } from "react";
import { Modal } from "../../../../components/cases-experience/matter-modals/Modal";

export type ReviewerReasonKind =
  | "PAUSE"
  | "RECORD_RESPONSE"
  | "ESCALATION_REASSIGN"
  | "ESCALATION_RESOLVE"
  | "ESCALATION_SUPPRESS";

type ReviewerReasonModalConfig = {
  kind: ReviewerReasonKind;
  title: string;
  description: string;
  fieldLabel: string;
  placeholder: string;
  submitLabel: string;
  /** Free-form text by default; ESCALATION_REASSIGN takes a user id. */
  validateAs?: "text" | "uuid";
  /** The field may be left empty (record response's note). */
  optional?: boolean;
  /** Destructive styling on the submit button. */
  destructive?: boolean;
};

const CONFIG: Record<ReviewerReasonKind, ReviewerReasonModalConfig> = {
  PAUSE: {
    kind: "PAUSE",
    title: "Pause this review",
    description:
      "Pausing stops the SLA clock until the review resumes. The reason is recorded and visible to your workspace.",
    fieldLabel: "Pause reason",
    placeholder: "For example: waiting on outside counsel before continuing.",
    submitLabel: "Pause review",
  },
  RECORD_RESPONSE: {
    kind: "RECORD_RESPONSE",
    title: "Record the response",
    description:
      "Record that the requested information has arrived so the review can continue. Add a note if it helps the next reviewer.",
    fieldLabel: "Note (optional)",
    placeholder: "For example: the submitter sent the custody log on 23 November.",
    submitLabel: "Record response",
    optional: true,
  },
  ESCALATION_REASSIGN: {
    kind: "ESCALATION_REASSIGN",
    title: "Reassign this escalation",
    description:
      "Move this escalation to a different operator. Enter the new assignee's user id.",
    fieldLabel: "New assignee user id",
    placeholder: "00000000-0000-4000-8000-000000000000",
    submitLabel: "Reassign",
    validateAs: "uuid",
  },
  ESCALATION_RESOLVE: {
    kind: "ESCALATION_RESOLVE",
    title: "Resolve this escalation",
    description:
      "Record how this escalation was resolved. The note is visible to your workspace and recorded in the audit log.",
    fieldLabel: "Resolution note",
    placeholder: "For example: the submitter clarified intent; the review can proceed.",
    submitLabel: "Resolve",
  },
  ESCALATION_SUPPRESS: {
    kind: "ESCALATION_SUPPRESS",
    title: "Suppress this escalation",
    description:
      "Suppression marks the escalation as not actionable. State the reason so others can audit the decision.",
    fieldLabel: "Suppression reason",
    placeholder: "For example: duplicate of an escalation already being handled.",
    submitLabel: "Suppress",
    destructive: true,
  },
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_REASON_LEN = 400;

export function ReviewerReasonModal({
  kind,
  open,
  onCancel,
  onSubmit,
  error: externalError,
}: {
  kind: ReviewerReasonKind | null;
  open: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => Promise<void> | void;
  /**
   * A refusal from the host's POST. Shown inside the dialog, so the operator
   * reads it where the typed reason is.
   */
  error?: string | null;
}) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const helpId = `${baseId}-help`;
  const errorId = `${baseId}-error`;

  // Reset every time the dialog opens for a kind.
  useEffect(() => {
    if (!open) return;
    setValue("");
    setLocalError(null);
    setSubmitting(false);
  }, [open, kind]);

  const config = kind ? CONFIG[kind] : null;
  const trimmed = value.trim();
  const tooLong = trimmed.length > MAX_REASON_LEN;
  const needsValue = Boolean(config && !config.optional);
  const invalid = (needsValue && !trimmed) || tooLong;

  const handleSubmit = useCallback(async () => {
    if (!config || submitting) return;
    if (needsValue && !trimmed) {
      setLocalError(`${config.fieldLabel} is required.`);
      return;
    }
    if (trimmed.length > MAX_REASON_LEN) {
      setLocalError(
        `Keep ${config.fieldLabel.toLowerCase()} to ${MAX_REASON_LEN} characters or fewer.`,
      );
      return;
    }
    if (config.validateAs === "uuid" && !UUID_REGEX.test(trimmed)) {
      setLocalError("Enter a valid user id.");
      return;
    }
    setLocalError(null);
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
    } catch (err) {
      // The host normally reports refusals through `error`; this covers a
      // host that throws instead.
      setLocalError(toSafeUserError(err, { message: "Could not submit." }).message);
    } finally {
      setSubmitting(false);
    }
  }, [config, submitting, needsValue, trimmed, onSubmit]);

  if (!open || !config) return null;

  const shownError = localError ?? externalError ?? null;
  const counterOver = value.length > MAX_REASON_LEN;

  return (
    <Modal
      open={open}
      title={config.title}
      description={config.description}
      onClose={onCancel}
      testid={`reviewer-reason-${config.kind.toLowerCase()}`}
      dismissDisabled={submitting}
      footer={
        <>
          <button
            type="button"
            className="app-secondary-action"
            onClick={onCancel}
            disabled={submitting}
            data-reviewer-reason-cancel
          >
            Cancel
          </button>
          <button
            type="submit"
            form={`${baseId}-form`}
            className={config.destructive ? "app-danger-action" : "app-primary-action"}
            disabled={submitting || invalid}
            aria-busy={submitting || undefined}
            data-reviewer-reason-submit
            data-reviewer-reason-destructive={config.destructive ? "true" : undefined}
          >
            {submitting ? (
              <>
                <span className="app-spinner" aria-hidden="true" /> Submitting…
              </>
            ) : (
              config.submitLabel
            )}
          </button>
        </>
      }
    >
      <form
        id={`${baseId}-form`}
        data-reviewer-reason-modal={kind}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
        style={{ display: "grid", gap: 6, minWidth: 0 }}
      >
        <p className="app-dialog__subtitle" data-reviewer-reason-desc style={{ marginTop: 0 }}>
          {config.description}
        </p>
        <label htmlFor={inputId} className="app-field-label">
          {config.fieldLabel}
        </label>
        <textarea
          id={inputId}
          className="app-input app-textarea"
          value={value}
          onChange={(e) => {
            setValue(e.target.value.slice(0, MAX_REASON_LEN + 1));
            if (localError) setLocalError(null);
          }}
          disabled={submitting}
          placeholder={config.placeholder}
          required={needsValue}
          aria-invalid={shownError ? true : undefined}
          aria-describedby={shownError ? `${helpId} ${errorId}` : helpId}
          data-reviewer-reason-input
          rows={config.validateAs === "uuid" ? 1 : 4}
          style={{
            width: "100%",
            maxWidth: "100%",
            boxSizing: "border-box",
            resize: "vertical",
            fontFamily: config.validateAs === "uuid" ? "monospace" : "inherit",
          }}
        />
        <div
          id={helpId}
          className="app-field-help"
          style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", margin: 0 }}
        >
          <span
            data-reviewer-reason-counter
            aria-live="polite"
            className={counterOver ? "app-field-error" : undefined}
            style={counterOver ? { margin: 0 } : undefined}
          >
            {value.length}/{MAX_REASON_LEN} characters
          </span>
          <span>{config.optional ? "Optional. Recorded in the audit log." : "Required. Recorded in the audit log."}</span>
        </div>
        {shownError ? (
          <p
            id={errorId}
            role="alert"
            className="app-field-error"
            data-reviewer-reason-error
            style={{ margin: "4px 0 0", overflowWrap: "anywhere" }}
          >
            {shownError}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
