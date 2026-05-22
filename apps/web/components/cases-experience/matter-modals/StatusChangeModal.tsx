"use client";

/**
 * Phase 32.8D-frontend-closure — Status change modal.
 *
 * Replaces the legacy `window.prompt("Reason:")` flow with a
 * structured dialog: target status selector + optional reason
 * textarea. Submission calls `POST /v1/cases/:id/status` via the
 * caller's `runMutation` wrapper.
 */

import React, { useCallback, useEffect, useState } from "react";

import { Modal } from "./Modal";

export type AllowedStatus =
  | "OPEN"
  | "INVESTIGATING"
  | "ON_HOLD"
  | "RESOLVED"
  | "CLOSED"
  | "ARCHIVED";

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

  useEffect(() => {
    if (!open) {
      setReason("");
      setSubmitting(false);
    }
  }, [open]);

  const handleSubmit = useCallback(async () => {
    if (!toStatus) return;
    setSubmitting(true);
    const result = await onSubmit(toStatus, reason.trim() ? reason.trim() : null);
    setSubmitting(false);
    if (result.ok) onClose();
  }, [toStatus, reason, onSubmit, onClose]);

  return (
    <Modal
      open={open && !!toStatus}
      title={
        toStatus
          ? `Change status: ${fromStatus} → ${toStatus}`
          : "Change status"
      }
      onClose={onClose}
      testid="status-change-modal"
      dismissDisabled={submitting}
      footer={
        <>
          <button
            type="button"
            className="cases-filter-chip"
            data-matter-status-change-cancel
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="cases-filter-chip is-active"
            data-matter-status-change-submit
            onClick={() => void handleSubmit()}
            disabled={!toStatus || submitting}
          >
            {submitting ? "Changing…" : "Change status"}
          </button>
        </>
      }
    >
      <p style={{ fontSize: 13, opacity: 0.85, marginTop: 0 }}>
        This change is audited. If the matter has an active legal hold,
        the backend will reject transitions to <code>CLOSED</code> or{" "}
        <code>ARCHIVED</code> with a clear explanation.
      </p>
      <label style={{ display: "grid", gap: 4 }}>
        <span style={{ fontSize: 12, opacity: 0.85 }}>
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
          style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 10,
            padding: 8,
            color: "inherit",
            resize: "vertical",
          }}
        />
      </label>
    </Modal>
  );
}
