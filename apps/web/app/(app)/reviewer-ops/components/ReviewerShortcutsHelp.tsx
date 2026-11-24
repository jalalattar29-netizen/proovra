"use client";

/**
 * Reviewer keyboard shortcuts help.
 *
 * Opened with `?` on a reviewer page (never while typing). Built on the
 * canonical dialog (`components/cases-experience/matter-modals/Modal.tsx`:
 * `.app-dialog*`, portal, focus trap, focus restore, Escape).
 *
 * T-094 (stage D) — the rows are GENERATED from the keymap the page registers
 * its handlers from (`lib/reviewer-workspace/review-keymap.ts`, `useKeymap`),
 * so the help never lists a key the page does not handle. A caller passes the
 * rows `useKeymap` returned; the `variant` fallback lists every binding of the
 * surface's keymap.
 *
 * There is no Ctrl/Cmd+K binding here: that key belongs to the app-wide
 * "Jump to a page" palette.
 */

import { useEffect } from "react";
import { Modal } from "../../../../components/cases-experience/matter-modals/Modal";
import {
  INBOX_KEYMAP,
  REVIEW_PAGE_KEYMAP,
  isTypingTarget,
} from "../../../../lib/reviewer-workspace/review-keymap";

export type ShortcutsVariant = "console" | "inspector";

type HelpRow = { key: string; label: string };

/** The Inbox keymap as help rows (every binding the Inbox registers). */
export const CONSOLE_ROWS: ReadonlyArray<HelpRow> = INBOX_KEYMAP.map((b) => ({ key: b.display, label: b.label }));

/** The Review page / focus mode keymap as help rows. */
export const INSPECTOR_ROWS: ReadonlyArray<HelpRow> = REVIEW_PAGE_KEYMAP.map((b) => ({ key: b.display, label: b.label }));

/**
 * `true` when the event's target is a text input, textarea, select,
 * contenteditable or role="textbox". Shortcuts never fire while typing.
 */
export function isShortcutTarget(e: KeyboardEvent): boolean {
  return isTypingTarget(e.target);
}

/** `?` toggles the help. Escape is handled by the dialog itself. */
export function useReviewerHelpHotkey(opts: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isShortcutTarget(e)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        if (opts.open) opts.onClose();
        else opts.onOpen();
      } else if (e.key === "Escape" && opts.open) {
        opts.onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opts]);
}

export function ReviewerShortcutsHelp({
  open,
  onClose,
  rows: generatedRows,
  extraRows,
  variant = "console",
}: {
  open: boolean;
  onClose: () => void;
  /** T-094 — the rows `useKeymap` generated from the page's registered handlers. */
  rows?: ReadonlyArray<HelpRow>;
  /** Page-specific rows, shown after the base rows. */
  extraRows?: ReadonlyArray<HelpRow>;
  /** Which surface's keys to list when no generated rows are given. */
  variant?: ShortcutsVariant;
}) {
  if (!open) return null;
  const base = generatedRows ?? (variant === "inspector" ? INSPECTOR_ROWS : CONSOLE_ROWS);
  const rows = [...base, ...(extraRows ?? []), { key: "Esc", label: "Close a dialog" }];

  return (
    <Modal
      open={open}
      title="Keyboard shortcuts"
      onClose={onClose}
      testid="reviewer-shortcuts"
      footer={
        <button type="button" className="app-secondary-action" onClick={onClose} data-reviewer-shortcuts-close>
          Close
        </button>
      }
    >
      <div data-reviewer-shortcuts-modal={variant}>
        <p className="app-dialog__subtitle" style={{ marginTop: 0 }}>
          Shortcuts are off while you type in a field. Press <kbd>?</kbd> again or <kbd>Esc</kbd> to close.
        </p>
        <ul
          data-reviewer-shortcuts-list
          style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 4 }}
        >
          {rows.map((r) => (
            <li
              key={r.key}
              data-reviewer-shortcut-row
              data-reviewer-shortcut-key={r.key}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "6px 0",
                borderBottom: "1px solid var(--border-subtle)",
                fontSize: 13.5,
                minWidth: 0,
              }}
            >
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{r.label}</span>
              <kbd
                style={{
                  flexShrink: 0,
                  fontFamily: "monospace",
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "2px 8px",
                  borderRadius: 6,
                  border: "1px solid var(--border-standard)",
                  background: "var(--surface-muted)",
                }}
              >
                {r.key}
              </kbd>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
