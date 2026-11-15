"use client";

/**
 * "Clear this evidence session?" — the capture page's discard confirmation.
 *
 * F-P1-07 — this alertdialog said `aria-modal="true"` and neither moved focus
 * in nor kept it: a keyboard user pressing Tab walked out to the page behind.
 * It now uses the shared dialog focus owner (lib/ui/dialogFocus.ts): focus
 * starts on "Keep Session" (the safe choice, as ConfirmActionModal starts on
 * Cancel), Tab stays inside, Escape keeps the session, and focus returns to the
 * control that opened it.
 */
import { useRef } from "react";

import { useDialogFocus } from "../../../../lib/ui/dialogFocus";

export function CaptureClearConfirmDialog({
  open,
  onKeep,
  onClear,
}: {
  open: boolean;
  onKeep: () => void;
  onClear: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  useDialogFocus(dialogRef, open, { initialFocusRef: keepRef, onEscape: onKeep });

  if (!open) return null;
  return (
    <div className="capture-confirm-backdrop">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="capture-confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="capture-clear-title"
        aria-describedby="capture-clear-text"
      >
        <div className="capture-confirm-icon">!</div>

        <div>
          <div className="capture-confirm-title" id="capture-clear-title">
            Clear this evidence session?
          </div>
          <p className="capture-confirm-text" id="capture-clear-text">
            This will remove all staged materials, mapping, private notes,
            and local review progress. No evidence record has been created
            yet.
          </p>
        </div>

        <div className="capture-confirm-actions">
          <button ref={keepRef} type="button" className="capture-confirm-cancel" onClick={onKeep}>
            Keep Session
          </button>

          <button type="button" className="capture-confirm-danger" onClick={onClear}>
            Clear Session
          </button>
        </div>
      </div>
    </div>
  );
}
