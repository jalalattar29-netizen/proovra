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
 * Intentionally no third-party dialog library: the shell already
 * uses bounded CSS classes, and the focus-trap implementation here
 * is small enough that auditing the surface area is easier than
 * importing a dependency.
 */

import React, { useEffect, useId, useRef } from "react";

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
      data-matter-modal-overlay={testid}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(15,23,42,0.38)",
        backdropFilter: "blur(5px)",
        WebkitBackdropFilter: "blur(5px)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !dismissDisabled) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        data-matter-modal={testid}
        ref={dialogRef}
        tabIndex={-1}
        style={{
          maxWidth: 520,
          width: "100%",
          maxHeight: "85vh",
          background: "rgba(255,255,255,0.96)",
          border: "1px solid rgba(15,23,42,0.08)",
          borderRadius: 18,
          boxShadow: "0 24px 70px rgba(15,23,42,0.18)",
          display: "flex",
          flexDirection: "column",
          color: "#475569",
          outline: "none",
        }}
      >
        <header
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid rgba(15,23,42,0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <h2
            id={titleId}
            data-matter-modal-title
            style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#172033" }}
          >
            {title}
          </h2>
          {!dismissDisabled ? (
            <button
              type="button"
              data-matter-modal-close
              onClick={onClose}
              aria-label="Close"
              style={{
                padding: "2px 8px",
                background: "transparent",
                border: "1px solid rgba(15,23,42,0.12)",
                borderRadius: 8,
                color: "#475569",
                fontSize: 16,
                lineHeight: 1,
                cursor: "pointer",
              }}
            >
              ×
            </button>
          ) : null}
        </header>
        {description ? (
          <span
            id={descriptionId}
            data-matter-modal-description
            style={{
              position: "absolute",
              width: 1,
              height: 1,
              padding: 0,
              margin: -1,
              overflow: "hidden",
              clip: "rect(0,0,0,0)",
              whiteSpace: "nowrap",
              border: 0,
            }}
          >
            {description}
          </span>
        ) : null}
        <div
          data-matter-modal-body
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px 18px",
          }}
        >
          {children}
        </div>
        {footer ? (
          <footer
            data-matter-modal-footer
            style={{
              padding: "12px 18px",
              borderTop: "1px solid rgba(15,23,42,0.08)",
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
            }}
          >
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
