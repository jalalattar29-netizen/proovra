"use client";

/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the Billing drawer.
 *
 * Checkout used to be an always-expanded "Checkout Console" occupying a third
 * of the page: three target pickers, a plan picker, a provider picker and four
 * paragraphs of commercial rules, rendered whether or not anyone was buying
 * anything. It is now a drawer that opens on intent.
 *
 * Accessibility contract — the same one `ConfirmActionModal` already
 * establishes in this codebase, restated here because a drawer that traps focus
 * badly is worse than no drawer:
 *   * `role="dialog"` + `aria-modal` + `aria-labelledby`;
 *   * focus moves INTO the drawer on open and RETURNS to the trigger on close;
 *   * Tab cycles within the drawer; Escape closes it;
 *   * the page behind is scroll-locked and inert to pointer events.
 *
 * RTL: the panel is anchored with `inset-inline-end`, so it slides from the
 * trailing edge in both directions without a second stylesheet.
 */

import { useCallback, useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function BillingDrawer({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  testId,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  testId?: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useRef(`billing-drawer-${Math.random().toString(36).slice(2)}`);

  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    if (!open) return;

    // Remember what to give focus back to. Losing the caller's place in the
    // page is the most common way a drawer becomes unusable by keyboard.
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusTimer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      (focusables[0] ?? panel).focus();
    }, 0);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

      if (focusables.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open, close]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        background: "rgba(15,23,42,0.45)",
        display: "flex",
        justifyContent: "flex-end",
      }}
      onMouseDown={(e) => {
        // Backdrop click closes; a drag that STARTED inside must not.
        if (e.target === e.currentTarget) close();
      }}
      data-billing-drawer-backdrop
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId.current}
        tabIndex={-1}
        data-testid={testId}
        /*
         * The SCOPE for the plan-drawer button hierarchy.
         *
         * `.bill-plan-action` (near-black) and `.bill-cancel-action`
         * (white with a red edge) are defined UNDER this class in billing.css,
         * so they cannot reach a button outside a Billing drawer. A global
         * variant would have been the shorter change and the wrong one: the
         * hierarchy is a property of this decision surface, not of the app.
         */
        className="bill-drawer"
        style={{
          background: "var(--surface-card, #ffffff)",
          width: "min(520px, 100%)",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          // Logical property: the panel is on the trailing edge in LTR and RTL
          // alike, with no direction-specific override.
          borderInlineStart: "1px solid var(--border-default, rgba(15,23,42,0.09))",
          boxShadow: "-12px 0 32px rgba(15,23,42,0.14)",
        }}
      >
        <div
          style={{
            padding: "20px 22px 14px",
            borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
            display: "flex",
            alignItems: "flex-start",
            gap: 16,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2
              id={titleId.current}
              style={{
                margin: 0,
                fontSize: "1.05rem",
                fontWeight: 600,
                letterSpacing: "-0.01em",
                color: "var(--ink-primary)",
              }}
            >
              {title}
            </h2>
            {description ? (
              <p
                style={{
                  margin: "6px 0 0",
                  fontSize: "0.88rem",
                  lineHeight: 1.6,
                  color: "var(--silver-ink)",
                }}
              >
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            data-billing-drawer-close
            style={{
              minWidth: 44,
              minHeight: 44,
              borderRadius: 10,
              border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
              background: "transparent",
              cursor: "pointer",
              fontSize: 18,
              lineHeight: 1,
              color: "var(--silver-ink)",
            }}
          >
            ×
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px" }}>
          {children}
        </div>

        {footer ? (
          <div
            style={{
              padding: "14px 22px 20px",
              borderTop: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
