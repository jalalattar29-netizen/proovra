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
import { AlertTriangle } from "lucide-react";

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

  // SEMANTIC tone, not a workspace variant: a destructive confirm is
  // destructive everywhere, so it uses the canonical danger action.
  const primaryClass = isDanger ? "app-danger-action" : "app-primary-action";

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
            className="app-secondary-action"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            data-matter-confirm-submit
            data-confirm-tone={confirmTone ?? (isDanger ? "danger" : "neutral")}
            className={primaryClass}
            onClick={() => void handleConfirm()}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      {isDanger ? (
        /* CANONICAL INLINE NOTICE — `.app-alert--warn` is the one destructive
           notice treatment in the product. The icon comes from the canonical
           lucide family instead of a hand-rolled inline SVG. */
        <div
          data-matter-confirm-danger
          className="app-alert app-alert--warn case-detail-attention"
        >
          <AlertTriangle
            size={18}
            strokeWidth={1.9}
            aria-hidden="true"
            style={{ flex: "none" }}
          />
          <div className="case-detail-attention-body">
            <p className="case-detail-attention-title">{title}</p>
            <div className="app-hint">{body}</div>
          </div>
        </div>
      ) : (
        body
      )}
    </Modal>
  );
}
