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

import { Modal } from "./Modal";

export type AllowedStatus =
  | "OPEN"
  | "INVESTIGATING"
  | "ON_HOLD"
  | "RESOLVED"
  | "CLOSED"
  | "ARCHIVED";

// User-friendly label for a raw enum value (never leak ON_HOLD etc.).
function statusLabel(status: string): string {
  switch (status) {
    case "OPEN":
      return "Open";
    case "INVESTIGATING":
      return "Investigating";
    case "ON_HOLD":
      return "On hold";
    case "RESOLVED":
      return "Resolved";
    case "CLOSED":
      return "Closed";
    case "ARCHIVED":
      return "Archived";
    default:
      return status;
  }
}

// Semantic palette for the status badge:
//   Open / Resolved  → success green
//   On hold          → warning amber
//   Investigating    → indigo
//   Closed / Archived→ slate
function statusBadgeStyle(status: string): {
  color: string;
  background: string;
  border: string;
} {
  switch (status) {
    case "OPEN":
    case "RESOLVED":
      return { color: "#167A5B", background: "#EAF7F1", border: "#C7EBDD" };
    case "ON_HOLD":
      return { color: "#A86612", background: "#FFF6E5", border: "#F2D8A8" };
    case "INVESTIGATING":
      return { color: "#4F46E5", background: "#EEF0FE", border: "rgba(79,70,229,0.24)" };
    case "CLOSED":
    case "ARCHIVED":
    default:
      return { color: "#5F6B7D", background: "#F1F3F6", border: "#DCE1E8" };
  }
}

function StatusBadge({
  status,
  testAttr,
}: {
  status: string;
  testAttr?: string;
}) {
  const s = statusBadgeStyle(status);
  return (
    <span
      {...(testAttr ? { [testAttr]: status } : {})}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "4px 11px",
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1.2,
        color: s.color,
        background: s.background,
        border: `1px solid ${s.border}`,
        whiteSpace: "nowrap",
      }}
    >
      {statusLabel(status)}
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

  const primaryColors = isIrreversible
    ? { background: "#FFF1F2", border: "#F4C8CE", color: "#B23442" }
    : { background: "#5B4FE8", border: "#5B4FE8", color: "#ffffff" };

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
            onClick={onClose}
            disabled={submitting}
            style={{
              height: 42,
              padding: "0 16px",
              borderRadius: 11,
              fontSize: 14,
              fontWeight: 600,
              background: "rgba(255,255,255,0.78)",
              border: "1px solid rgba(79,70,229,0.18)",
              color: "#4F46E5",
              cursor: submitting ? "default" : "pointer",
              opacity: submitting ? 0.6 : 1,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-matter-status-change-submit
            onClick={() => void handleSubmit()}
            disabled={!toStatus || submitting}
            style={{
              height: 42,
              padding: "0 16px",
              borderRadius: 11,
              fontSize: 14,
              fontWeight: 600,
              background: primaryColors.background,
              border: `1px solid ${primaryColors.border}`,
              color: primaryColors.color,
              cursor: !toStatus || submitting ? "default" : "pointer",
              opacity: !toStatus || submitting ? 0.6 : 1,
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {submitting ? (
              <>
                <Spinner color={primaryColors.color} />
                Changing…
              </>
            ) : (
              "Change status"
            )}
          </button>
        </>
      }
    >
      {/* §23 two-badge transition row — semantic status badges */}
      <div
        data-matter-status-change-transition
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 14px",
          marginBottom: 14,
          borderRadius: 12,
          background: "rgba(91,79,232,0.05)",
          border: "1px solid rgba(79,70,229,0.14)",
          flexWrap: "wrap",
        }}
      >
        <StatusBadge status={fromStatus} testAttr="data-matter-status-change-from" />
        <span
          aria-hidden="true"
          style={{ color: "#5F6B7D", fontSize: 16, lineHeight: 1, fontWeight: 600 }}
        >
          →
        </span>
        {toStatus ? (
          <StatusBadge status={toStatus} testAttr="data-matter-status-change-to" />
        ) : null}
      </div>

      <p style={{ fontSize: 14, lineHeight: 1.5, color: "#475569", marginTop: 0 }}>
        This updates case organization only. Linked evidence, reports,
        verification packages, notes, custody history, and audit records
        remain unchanged.
      </p>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: "#5F6B7D", marginTop: 0 }}>
        This change is audited. If the case has an active legal hold, the
        backend will reject transitions to Closed or Archived with a clear
        explanation.
      </p>

      <label style={{ display: "grid", gap: 5, marginTop: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#172033" }}>
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
            background: "rgba(255,255,255,0.7)",
            border: "1px solid rgba(15,23,42,0.12)",
            borderRadius: 10,
            padding: "9px 10px",
            fontSize: 14,
            color: "#172033",
            resize: "vertical",
          }}
        />
      </label>

      {error ? (
        <p
          role="alert"
          data-matter-status-change-error
          style={{
            marginTop: 12,
            marginBottom: 0,
            padding: "9px 12px",
            borderRadius: 10,
            fontSize: 13,
            lineHeight: 1.45,
            color: "#B23442",
            background: "#FFF1F2",
            border: "1px solid #F4C8CE",
          }}
        >
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

function Spinner({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 13,
        height: 13,
        borderRadius: "50%",
        border: `2px solid ${color}`,
        borderTopColor: "transparent",
        display: "inline-block",
        animation: "matter-status-spin 0.7s linear infinite",
      }}
    >
      <style>{`@keyframes matter-status-spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}
