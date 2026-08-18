"use client";

/**
 * Phase 32.8D-frontend-closure — Status change modal.
 *
 * Replaces the legacy `window.prompt("Reason:")` flow with a
 * structured dialog: target status selector + optional reason
 * textarea. Submission calls `POST /v1/cases/:id/status` via the
 * caller's `runMutation` wrapper.
 *
 * §23 light-enterprise polish: the transition is rendered as a
 * TWO-BADGE row (from → to) using semantic status colors, not just
 * a paragraph. Title is dark-on-light; actions use the light
 * enterprise button system (secondary neutral Cancel + primary
 * purple, restrained danger only for the irreversible ARCHIVED
 * target).
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  CASE_STATUS_LABEL,
  caseStatusTone,
} from "../simple-case-detail/helpers";

import { Modal } from "./Modal";

export type AllowedStatus =
  | "OPEN"
  | "INVESTIGATING"
  | "ON_HOLD"
  | "RESOLVED"
  | "CLOSED"
  | "ARCHIVED";

// User-friendly label for a raw enum value (never leak ON_HOLD etc.).

// Case status -> the canonical `.app-status-badge[data-tone]` vocabulary.
// This file previously carried a THIRD hand-rolled status palette; it now
// reuses the single mapping that Case Details and the Cases list already use.
function StatusBadge({
  status,
  testAttr,
}: {
  status: string;
  testAttr?: string;
}) {
  return (
    <span
      className="app-status-badge"
      data-tone={caseStatusTone(status)}
      data-status={status}
      {...(testAttr ? { [testAttr]: status } : {})}
    >
      {CASE_STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function StatusChangeModal({
  open,
  fromStatus,
  toStatus,
  onClose,
  onSubmit,
}: {
  open: boolean;
  fromStatus: string;
  toStatus: AllowedStatus | null;
  onClose: () => void;
  onSubmit: (toStatus: AllowedStatus, reason: string | null) => Promise<{ ok: boolean }>;
}) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setReason("");
      setSubmitting(false);
      setError(null);
    }
  }, [open]);

  // Only the irreversible ARCHIVED target earns the restrained danger
  // primary. Every other transition (including On hold and Closed)
  // keeps the calm primary purple — amber/slate live in the target
  // badge, not the button.
  const isIrreversible = toStatus === "ARCHIVED";

  const handleSubmit = useCallback(async () => {
    if (!toStatus || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onSubmit(toStatus, reason.trim() ? reason.trim() : null);
      if (result.ok) {
        onClose();
        return;
      }
      setError("Could not change status. Please try again.");
    } catch {
      setError("Could not change status. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }, [toStatus, submitting, reason, onSubmit, onClose]);

  // SEMANTIC tone: an irreversible transition is destructive on every
  // surface, so it uses the canonical danger action.
  const primaryClass = isIrreversible ? "app-danger-action" : "app-primary-action";

  return (
    <Modal
      open={open && !!toStatus}
      title="Change case status"
      onClose={onClose}
      testid="status-change-modal"
      dismissDisabled={submitting}
      footer={
        <>
          <button
            type="button"
            data-matter-status-change-cancel
            className="app-secondary-action"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            data-matter-status-change-submit
            onClick={() => void handleSubmit()}
            className={primaryClass}
            disabled={!toStatus || submitting}
            aria-busy={submitting}
          >
            {submitting ? "Changing…" : "Change status"}
          </button>
        </>
      }
    >
      {/* §23 two-badge transition row — semantic status badges */}
      <div
        data-matter-status-change-transition
        className="app-inner-surface app-panel__body case-detail-meta"
      >
        <StatusBadge status={fromStatus} testAttr="data-matter-status-change-from" />
        <span aria-hidden="true" className="case-detail-dot" />
        {toStatus ? (
          <StatusBadge status={toStatus} testAttr="data-matter-status-change-to" />
        ) : null}
      </div>

      <p className="app-hint">
        This updates case organization only. Linked evidence, reports,
        verification packages, notes, custody history, and audit records
        remain unchanged.
      </p>
      <p className="app-hint">
        This change is audited. If the case has an active legal hold, the
        backend will reject transitions to Closed or Archived with a clear
        explanation.
      </p>

      <label className="case-detail-stack">
        <span className="app-field-label">
          Reason (optional, ≤ 400 characters)
        </span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={400}
          rows={4}
          disabled={submitting}
          data-matter-status-change-reason
          placeholder="Operator-readable reason. Helps future readers understand the timeline."
          className="app-form-input"
          style={{ resize: "vertical" }}
        />
      </label>

      {error ? (
        <p
          role="alert"
          data-matter-status-change-error
          className="app-alert app-alert--warn"
        >
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
