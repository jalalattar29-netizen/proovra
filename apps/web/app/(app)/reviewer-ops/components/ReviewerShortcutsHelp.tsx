"use client";

/**
 * Reviewer keyboard shortcuts help.
 *
 * Opened with `?` on a reviewer page (never while typing — callers gate their
 * own handlers with `isShortcutTarget`). Built on the canonical dialog
 * (`components/cases-experience/matter-modals/Modal.tsx`: `.app-dialog*`,
 * portal, focus trap, focus restore, Escape).
 *
 * Two key sets, one per surface, so the help never lists a key the page does
 * not handle:
 *
 *   console    J / K move, Enter opens, A assigns, E escalates, M requests
 *              information, / focuses the filter.
 *   inspector  A starts the review; M moves focus to the "Record decision"
 *              panel with Request information preselected. There is no
 *              approve key (TEAM-UI-SPEC §2): a verdict is entered only in
 *              that panel. None of them navigates away from the review.
 *
 * There is no Ctrl/Cmd+K binding here: that key belongs to the app-wide
 * "Jump to a page" palette.
 */

import { useEffect } from "react";
import { Modal } from "../../../../components/cases-experience/matter-modals/Modal";

export type ShortcutKey = "?" | "j" | "k" | "a" | "e" | "m" | "/" | "Enter";

export type ShortcutsVariant = "console" | "inspector";

const CONSOLE_ROWS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "J / K", label: "Move to the next / previous review" },
  { key: "Enter", label: "Open the selected review" },
  { key: "A", label: "Assign the selected review (when allowed)" },
  { key: "E", label: "Escalate the selected review" },
  { key: "M", label: "Request more information" },
  { key: "/", label: "Focus the filter" },
  { key: "?", label: "Show or hide this help" },
];

const INSPECTOR_ROWS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "A", label: "Start the review (when allowed)" },
  { key: "M", label: "Go to the decision panel with Request information selected" },
  { key: "?", label: "Show or hide this help" },
  { key: "Esc", label: "Close a dialog" },
];

/**
 * `true` when the event's target is a text input, textarea, select,
 * contenteditable or role="textbox". Shortcuts never fire while typing.
 */
export function isShortcutTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.getAttribute && t.getAttribute("role") === "textbox") return true;
  return false;
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
  extraRows,
  variant = "console",
}: {
  open: boolean;
  onClose: () => void;
  /** Page-specific rows, shown after the base rows. */
  extraRows?: ReadonlyArray<{ key: string; label: string }>;
  /** Which surface's keys to list. */
  variant?: ShortcutsVariant;
}) {
  if (!open) return null;
  const base = variant === "inspector" ? INSPECTOR_ROWS : CONSOLE_ROWS;
  const rows = [...base, ...(extraRows ?? [])];

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
