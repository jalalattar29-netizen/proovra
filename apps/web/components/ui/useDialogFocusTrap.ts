"use client";

/**
 * THE SHARED DIALOG FOCUS CONTRACT (OPS-020).
 *
 * One hook for every non-modal-provider dialog surface (side drawers, inline
 * panels): it moves focus INTO the dialog when it opens, keeps Tab and
 * Shift+Tab inside it, closes on Escape, and returns focus to the control that
 * OPENED it when it closes.
 *
 * Why it exists. The Operations drawers each carried their own copy of this
 * and got it wrong in the same two ways: focus was left outside the drawer
 * (one Tab left it), and the opener was re-captured whenever the `onClose`
 * callback changed identity — which an inline arrow does on every render — so
 * Escape "restored" focus to whatever happened to hold it last (a row
 * checkbox), not to the row the reader opened.
 *
 * The opener is captured ONCE, on mount. `onClose` is read through a ref, so a
 * new callback identity never re-runs the effect.
 *
 * A dialog stacked ON TOP (the canonical confirm modal, opened from inside a
 * drawer) owns the keyboard while it is open: this trap ignores keys whose
 * focus is inside another dialog, and that modal stops Escape in the capture
 * phase before it reaches here.
 */

import * as React from "react";

export const DIALOG_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function useDialogFocusTrap(
  panelRef: React.RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  React.useEffect(() => {
    const opener =
      typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    const panel = panelRef.current;

    // Focus the first control inside, or the panel itself (tabIndex=-1).
    const focusTimer = window.setTimeout(() => {
      const target =
        panel?.querySelector<HTMLElement>("[data-dialog-initial-focus]") ??
        panel?.querySelector<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR) ??
        panel;
      target?.focus();
    }, 0);

    const onKey = (e: KeyboardEvent) => {
      const current = panelRef.current;
      if (!current) return;
      const active = document.activeElement as HTMLElement | null;
      const owningDialog = active?.closest?.('[role="dialog"],[role="alertdialog"]') ?? null;
      // Another dialog stacked over this one owns the keyboard.
      if (owningDialog && owningDialog !== current) return;

      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = Array.from(
        current.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR),
      ).filter((el) => !el.closest("[hidden],[inert]"));
      if (focusables.length === 0) {
        e.preventDefault();
        current.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey) {
        if (active === first || !current.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !current.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKey);
      // Back to the control that opened this — not to <body>, and not to
      // whatever held focus most recently.
      if (opener && document.body.contains(opener)) {
        try {
          opener.focus();
        } catch {
          /* the opener went with a re-render; nothing to restore */
        }
      }
    };
    // Mount/unmount only: the opener is captured once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
