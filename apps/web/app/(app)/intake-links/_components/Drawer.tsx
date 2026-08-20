"use client";

/**
 * Intake links — the shared drawer shell.
 *
 * One anatomy for the three side panels (link details, delivery history,
 * submissions): a fixed head, a body that is the ONLY scrolling region, and a
 * scrim that closes on click. Escape closes. Focus moves into the panel on
 * open and returns to whatever opened it on close — a drawer that drops focus
 * back onto `<body>` strands keyboard users at the top of the page.
 */

import * as React from "react";

import { IconClose } from "./icons";

export function Drawer({
  title,
  subtitle,
  onClose,
  children,
  testId,
}: {
  title: string;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  const panelRef = React.useRef<HTMLElement | null>(null);
  const restoreRef = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    restoreRef.current =
      typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreRef.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="ilk-drawer-overlay"
      onClick={onClose}
      data-intake-links-drawer-overlay
    >
      <aside
        ref={panelRef}
        className="ilk-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        data-testid={testId}
      >
        <header className="ilk-drawer__head">
          <div>
            <h2 className="app-dialog__title" id={titleId}>
              {title}
            </h2>
            {subtitle ? <p className="app-dialog__subtitle">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            className="app-ghost-action"
            onClick={onClose}
            aria-label={`Close ${title.toLowerCase()}`}
          >
            <IconClose size={16} />
          </button>
        </header>
        <div className="ilk-drawer__body">{children}</div>
      </aside>
    </div>
  );
}

export default Drawer;
