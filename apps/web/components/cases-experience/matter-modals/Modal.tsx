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

import React, { useEffect, useId, useRef } from "react";
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

  // Focus trap + initial focus + restore focus on close.
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
      if (e.key === "Escape" && !dismissDisabled) {
        e.stopPropagation();
        onClose();
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

    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
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
  }, [open, dismissDisabled, onClose]);

  if (!open) return null;

  return (
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
            className="sr-only"
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
    </div>
  );
}
