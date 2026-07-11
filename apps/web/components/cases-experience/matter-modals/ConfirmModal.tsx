"use client";

/**
 * Phase 32.8D-frontend-closure — Reusable confirmation modal.
 *
 * Replaces `window.confirm` for audited destructive actions:
 *   - Remove assignment
 *   - Unlink evidence
 *   - Delete case
 *
 * The caller passes an explicit `onConfirm` that returns the
 * mutation outcome so the dialog can stay open on error and close on
 * success.
 *
 * §24 light-enterprise polish: an optional `tone="danger"` opts a
 * consumer into destructive styling — a danger icon, red title
 * accent, and a restrained DANGER primary action (pale danger
 * surface + red text + red border, NOT a full pink fill and NOT
 * purple). The default tone keeps the previous neutral behavior so
 * non-destructive consumers are unaffected.
 */

import React, { useCallback, useEffect, useState } from "react";

import { Modal } from "./Modal";

export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel,
  confirmTone,
  tone = "default",
  onClose,
  onConfirm,
  testid,
}: {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  confirmTone?: "neutral" | "warning";
  /**
   * Overall dialog tone. `"danger"` applies destructive styling to
   * the title, the leading icon, and the primary action. Defaults to
   * `"default"` (previous neutral behavior) so existing consumers are
   * untouched.
   */
  tone?: "danger" | "default";
  onClose: () => void;
  onConfirm: () => Promise<{ ok: boolean }>;
  testid: string;
}) {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) setBusy(false);
  }, [open]);

  const handleConfirm = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const result = await onConfirm();
    setBusy(false);
    if (result.ok) onClose();
  }, [busy, onConfirm, onClose]);

  const isDanger = tone === "danger";

  // Danger primary: restrained — pale danger surface + red text +
  // red border. Never a full pink fill, never purple.
  const primaryStyle: React.CSSProperties = isDanger
    ? {
        height: 42,
        padding: "0 16px",
        borderRadius: 11,
        fontSize: 14,
        fontWeight: 600,
        background: "#FFF1F2",
        border: "1px solid #F4C8CE",
        color: "#B23442",
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.6 : 1,
      }
    : {
        height: 42,
        padding: "0 16px",
        borderRadius: 11,
        fontSize: 14,
        fontWeight: 600,
        background: "#5B4FE8",
        border: "1px solid #5B4FE8",
        color: "#ffffff",
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.6 : 1,
      };

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      testid={testid}
      dismissDisabled={busy}
      footer={
        <>
          <button
            type="button"
            data-matter-confirm-cancel
            onClick={onClose}
            disabled={busy}
            style={{
              height: 42,
              padding: "0 16px",
              borderRadius: 11,
              fontSize: 14,
              fontWeight: 600,
              background: "rgba(255,255,255,0.78)",
              border: "1px solid rgba(79,70,229,0.18)",
              color: "#4F46E5",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-matter-confirm-submit
            data-confirm-tone={confirmTone ?? (isDanger ? "danger" : "neutral")}
            onClick={() => void handleConfirm()}
            disabled={busy}
            style={primaryStyle}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      {isDanger ? (
        <div
          data-matter-confirm-danger
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 11,
            padding: "11px 13px",
            marginBottom: 13,
            borderRadius: 12,
            background: "#FFF1F2",
            border: "1px solid #F4C8CE",
          }}
        >
          <DangerIcon />
          <div style={{ minWidth: 0 }}>
            <p
              style={{
                margin: 0,
                fontSize: 14,
                fontWeight: 700,
                color: "#B23442",
                lineHeight: 1.35,
              }}
            >
              {title}
            </p>
            <div
              style={{
                marginTop: 4,
                fontSize: 13.5,
                lineHeight: 1.5,
                color: "#475569",
              }}
            >
              {body}
            </div>
          </div>
        </div>
      ) : (
        body
      )}
    </Modal>
  );
}

function DangerIcon() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 24,
        height: 24,
        borderRadius: 7,
        background: "#FFF1F2",
        border: "1px solid #F4C8CE",
        color: "#B23442",
        flexShrink: 0,
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    </span>
  );
}
