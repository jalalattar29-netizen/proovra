"use client";

/**
 * Phase 32.8D-frontend-closure — Reusable confirmation modal.
 *
 * Replaces `window.confirm` for audited destructive actions:
 *   - Remove assignment
 *   - Unlink evidence
 *
 * The caller passes an explicit `onConfirm` that returns the
 * mutation outcome so the dialog can stay open on error and close on
 * success.
 */

import React, { useCallback, useEffect, useState } from "react";

import { Modal } from "./Modal";

export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel,
  confirmTone,
  onClose,
  onConfirm,
  testid,
}: {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  confirmTone?: "neutral" | "warning";
  onClose: () => void;
  onConfirm: () => Promise<{ ok: boolean }>;
  testid: string;
}) {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) setBusy(false);
  }, [open]);

  const handleConfirm = useCallback(async () => {
    setBusy(true);
    const result = await onConfirm();
    setBusy(false);
    if (result.ok) onClose();
  }, [onConfirm, onClose]);

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
            className="cases-filter-chip"
            data-matter-confirm-cancel
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="cases-filter-chip is-active"
            data-matter-confirm-submit
            data-confirm-tone={confirmTone ?? "neutral"}
            onClick={() => void handleConfirm()}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      {body}
    </Modal>
  );
}
