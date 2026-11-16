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

/**
 * B4-F-207 — what Clear does to a record a failed Finish already reserved:
 * "released" when the draft that holds it is discarded with the session (the
 * server releases its reservation), "expires" when no draft holds it (the
 * server's reservation sweep releases it), null when nothing was reserved.
 */
export type ClearReservedRecord = "released" | "expires" | null;

export function clearSessionConsequence(reserved: ClearReservedRecord): string {
  const base = "This will remove all staged materials, mapping, private notes, and local review progress.";
  if (reserved === "released") {
    return `${base} An unfinished evidence record was already reserved for this session; clearing releases it, and nothing is sealed.`;
  }
  if (reserved === "expires") {
    return `${base} An unfinished evidence record was already reserved for this session; nothing is sealed, and it is released automatically within 24 hours.`;
  }
  return `${base} No evidence record has been created yet.`;
}

export function CaptureClearConfirmDialog({
  open,
  onKeep,
  onClear,
  reservedRecord = null,
}: {
  open: boolean;
  onKeep: () => void;
  onClear: () => void;
  reservedRecord?: ClearReservedRecord;
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
            {clearSessionConsequence(reservedRecord)}
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
