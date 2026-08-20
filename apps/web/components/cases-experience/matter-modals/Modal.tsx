"use client";

/**
 * Phase 32.8D-frontend-closure-2 — Accessible modal primitive.
 *
 * Improvements over the closure-1 version:
 *
 *   - Focus is trapped within the dialog while it is open (Tab / Shift-Tab
 *     wrap between the first and last focusable elements).
 *   - Focus is restored to the opener element after close.
 *   - `aria-labelledby` + optional `aria-describedby` for assistive tech.
 *   - Escape closes (unless `dismissDisabled`).
 *   - Click on overlay closes only when `dismissDisabled` is false.
 *   - Background scroll prevented while open.
 *   - No animations / transitions — bounded behavior only.
 *
 * VISUAL AUTHORITY: the canonical `.app-dialog` anatomy in
 * `app-primitives.css` (overlay + head/title + body + footer), the same
 * anatomy the collaboration and assignment dialogs use. The previous
 * implementation described the whole dialog with inline hex styles, which
 * made Enterprise modals a second modal language.
 *
 * Intentionally no third-party dialog library: the shell already
 * uses bounded CSS classes, and the focus-trap implementation here
 * is small enough that auditing the surface area is easier than
 * importing a dependency.
 */

import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  testid,
  dismissDisabled = false,
}: {
  open: boolean;
  title: string;
  /**
   * Optional descriptive text rendered into a visually-hidden
   * element + linked to the dialog via `aria-describedby`. Use this
   * when the modal body is non-trivial (e.g. a confirmation about a
   * specific record).
   */
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  testid: string;
  dismissDisabled?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  /**
   * The trap reads these through refs so it can be installed ONCE per opening.
   *
   * They used to be effect dependencies. `onClose` is an inline arrow at almost
   * every call site and `dismissDisabled` flips while a request commits, so the
   * effect re-ran on ordinary re-renders — and its first act is to focus the
   * first control in the dialog. A dialog that surfaced a validation error, or
   * simply re-rendered while open, yanked focus back to "Cancel" and the
   * message the operator needed to read was never reached.
   */
  const onCloseRef = useRef(onClose);
  const dismissDisabledRef = useRef(dismissDisabled);
  useEffect(() => {
    onCloseRef.current = onClose;
    dismissDisabledRef.current = dismissDisabled;
  });

  // Focus trap + initial focus + restore focus on close. Installed once per
  // opening, never on a re-render.
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      (typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null) ?? null;

    const focusFirst = () => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute("data-matter-modal-close"));
      const first = focusables[0] ?? dialog;
      first.focus();
    };
    // Defer one paint so children render before we focus into them.
    const t = setTimeout(focusFirst, 0);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !dismissDisabledRef.current) {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab") {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusables = Array.from(
          dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        );
        if (focusables.length === 0) {
          e.preventDefault();
          dialog.focus();
          return;
        }
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (active === first || !dialog.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener("keydown", onKey, true);

    // Prevent body scroll while modal is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // BLOCKING-DIALOG FLAG (shared authority).
    //
    // Floating page furniture — today the privacy-preferences launcher, which
    // pins itself at z-index 2147483000 — otherwise paints straight through a
    // dialog and can sit on top of a footer action. Marking the body while a
    // blocking dialog is open lets that furniture stand down in ONE place
    // (app/globals.css) instead of each surface fighting it with its own
    // z-index. Counted, so nested dialogs do not clear the flag early.
    const openCount = Number(document.body.dataset.dialogOpenCount ?? "0") + 1;
    document.body.dataset.dialogOpenCount = String(openCount);
    document.body.dataset.dialogOpen = "true";

    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      const remaining = Number(document.body.dataset.dialogOpenCount ?? "1") - 1;
      if (remaining > 0) {
        document.body.dataset.dialogOpenCount = String(remaining);
      } else {
        delete document.body.dataset.dialogOpenCount;
        delete document.body.dataset.dialogOpen;
      }
      // Restore focus to the opener if it still exists in the DOM.
      const prev = previouslyFocusedRef.current;
      if (prev && document.body.contains(prev)) {
        try {
          prev.focus();
        } catch {
          // ignore
        }
      }
    };
  }, [open]);

  // PORTAL — a dialog must cover the VIEWPORT, never just its host.
  //
  // `.app-panel` (and any ancestor with backdrop-filter / filter / transform)
  // becomes the containing block for `position: fixed` descendants, so a dialog
  // opened from inside a panel had its overlay clipped to that panel: the rest
  // of the page stayed bright and interactive behind a supposedly blocking
  // modal. Rendering through document.body removes the whole class of bug for
  // every consumer instead of asking each surface to avoid panels.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  if (!open || !portalTarget) return null;

  return createPortal(
    <div
      role="presentation"
      className="app-dialog-overlay"
      data-matter-modal-overlay={testid}
      onClick={(e) => {
        if (e.target === e.currentTarget && !dismissDisabled) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className="app-dialog"
        data-matter-modal={testid}
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="app-dialog__head">
          <h2 id={titleId} data-matter-modal-title className="app-dialog__title">
            {title}
          </h2>
          {!dismissDisabled ? (
            <button
              type="button"
              className="app-ghost-action"
              data-matter-modal-close
              onClick={onClose}
              aria-label="Close"
            >
              <X size={16} strokeWidth={2} aria-hidden="true" />
            </button>
          ) : null}
        </header>
        {description ? (
          <span
            id={descriptionId}
            data-matter-modal-description
            className="app-visually-hidden"
          >
            {description}
          </span>
        ) : null}
        <div data-matter-modal-body className="app-dialog__body">
          {children}
        </div>
        {footer ? (
          <footer data-matter-modal-footer className="app-dialog__footer">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    portalTarget,
  );
}
