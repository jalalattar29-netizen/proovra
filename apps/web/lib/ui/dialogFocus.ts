"use client";

/**
 * F-P1-07 — THE ONE FOCUS OWNER FOR MODAL DIALOGS.
 *
 * A dialog marked `aria-modal="true"` promises a keyboard user that Tab stays
 * inside it. Several dialogs made that promise and kept none of it: Tab walked
 * out to the page behind (StepUpModal said "focus is trapped while open" and had
 * only an Escape handler; the capture "Clear this evidence session?" alertdialog
 * and the terms-acceptance step did not even move focus in).
 *
 * The trap that worked lived inside `components/ui/ConfirmActionModal.tsx`. It
 * is lifted here unchanged — same focusable selector, same wrap rule — so that
 * modal and every other dialog share one implementation:
 *
 *   - on open, focus moves into the dialog (the element the caller names, or
 *     the first focusable one, or the dialog itself);
 *   - Tab / Shift+Tab wrap at the ends and never leave the dialog;
 *   - Escape calls the caller's `onEscape` when it has one;
 *   - on close, focus goes back to whatever held it before.
 */
import { useEffect, useRef, type RefObject } from "react";

export const DIALOG_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function dialogFocusables(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR));
}

/**
 * Keeps a Tab keypress inside `dialog`. Returns true when it moved focus itself
 * (the event was prevented). Shift+Tab from the first element — or from
 * anywhere outside the dialog — goes to the last; Tab from the last goes to the
 * first.
 */
export function trapTabWithin(dialog: HTMLElement, e: KeyboardEvent): boolean {
  if (e.key !== "Tab") return false;
  const focusables = dialogFocusables(dialog);
  if (focusables.length === 0) {
    e.preventDefault();
    dialog.focus();
    return true;
  }
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey) {
    if (active === first || !dialog.contains(active)) {
      e.preventDefault();
      last.focus();
      return true;
    }
  } else if (active === last || !dialog.contains(active)) {
    e.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

export function useDialogFocus(
  dialogRef: RefObject<HTMLElement | null>,
  open: boolean,
  options: {
    /** The element to focus on open; defaults to the first focusable one. */
    initialFocusRef?: RefObject<HTMLElement | null>;
    onEscape?: () => void;
  } = {},
): void {
  const onEscapeRef = useRef(options.onEscape);
  onEscapeRef.current = options.onEscape;
  const initialRef = options.initialFocusRef;

  useEffect(() => {
    if (!open) return;
    const previous = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    const focusTimer = setTimeout(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      // Something inside already took focus (a code field the dialog focuses itself).
      if (dialog.contains(document.activeElement)) return;
      const target = initialRef?.current ?? dialogFocusables(dialog)[0] ?? dialog;
      target.focus();
    }, 0);

    const onKey = (e: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (e.key === "Escape" && onEscapeRef.current) {
        e.preventDefault();
        e.stopPropagation();
        onEscapeRef.current();
        return;
      }
      trapTabWithin(dialog, e);
    };
    document.addEventListener("keydown", onKey, true);

    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKey, true);
      if (previous && document.body.contains(previous)) {
        try {
          previous.focus();
        } catch {
          // ignore
        }
      }
    };
  }, [open, dialogRef, initialRef]);
}
