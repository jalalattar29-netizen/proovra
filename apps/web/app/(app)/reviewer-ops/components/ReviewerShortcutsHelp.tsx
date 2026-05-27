"use client";

/**
 * Phase 2.5 — Reviewer keyboard shortcuts help overlay.
 *
 * Triggered by pressing `?` anywhere on a reviewer-ops page (except
 * while a text input is focused — input-safe gating is the caller's
 * responsibility via the `isShortcutTarget` helper exported from
 * this file).
 *
 * The brief specifies these shortcuts for the reviewer queue:
 *   J / K     navigate
 *   A         assign / claim
 *   E         escalate
 *   R         request info
 *   C         close
 *   ?         this help overlay
 *
 * This component renders the help overlay. The actual J/K/A/E/R/C
 * handlers live on the page that hosts them — most usefully on the
 * single-review workspace where the three "reason" actions are
 * available. Queue-level J/K navigation is a separate concern handled
 * in `ReviewerCommandConsole` (deferred to a follow-up; the brief
 * explicitly asks for shortcut HELP discoverability + the existing
 * structured-modal flow).
 */

import { useEffect } from "react";

export type ShortcutKey = "?" | "j" | "k" | "a" | "e" | "r" | "c";

const ROWS: Array<{ key: string; label: string }> = [
  { key: "?", label: "Show / hide this help" },
  { key: "J / K", label: "Navigate queue (next / previous)" },
  { key: "A", label: "Assign or claim (when allowed)" },
  { key: "E", label: "Escalate" },
  { key: "R", label: "Request info" },
  { key: "C", label: "Close / approve flow" },
];

/**
 * Return `true` when the keyboard event's target is a text input,
 * textarea, contenteditable, or any element with role="textbox".
 * Shortcuts MUST NOT fire while typing — that would hijack normal
 * editing keys ("c", "e", "r", "a" are all common letters in reason
 * notes).
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

/**
 * Reusable `?` keypress listener that toggles the help overlay's
 * visibility. Mount it on every reviewer page.
 */
export function useReviewerHelpHotkey(opts: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isShortcutTarget(e)) return;
      // Don't fire on Cmd-? or Ctrl-? — those collide with browser
      // shortcuts.
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
}: {
  open: boolean;
  onClose: () => void;
  /**
   * Optional additional shortcut rows the host page wants to show
   * (e.g. page-specific keys). The base rows are always shown first.
   */
  extraRows?: ReadonlyArray<{ key: string; label: string }>;
}) {
  if (!open) return null;
  const rows = [...ROWS, ...(extraRows ?? [])];

  return (
    <div
      role="presentation"
      data-reviewer-shortcuts-overlay
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(8,18,22,0.72)",
        backdropFilter: "blur(6px)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reviewer-shortcuts-title"
        data-reviewer-shortcuts-modal
        style={{
          maxWidth: 480,
          width: "100%",
          background:
            "linear-gradient(180deg, rgba(20,30,34,0.98) 0%, rgba(12,20,24,0.98) 100%)",
          border: "1px solid rgba(255,255,255,0.10)",
          borderRadius: 16,
          color: "#dce1de",
          boxShadow: "0 20px 50px rgba(0,0,0,0.4)",
        }}
      >
        <header
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <h2
            id="reviewer-shortcuts-title"
            style={{ margin: 0, fontSize: 16, fontWeight: 700 }}
            data-reviewer-shortcuts-title
          >
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close shortcuts"
            data-reviewer-shortcuts-close
            style={{
              padding: "2px 10px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.16)",
              background: "transparent",
              color: "inherit",
              fontSize: 18,
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </header>
        <div style={{ padding: "14px 18px" }}>
          <p
            style={{
              margin: "0 0 12px",
              fontSize: 12.5,
              opacity: 0.7,
              lineHeight: 1.5,
            }}
          >
            Shortcuts are disabled while typing in any input or textarea.
            Press <kbd>?</kbd> again or <kbd>Esc</kbd> to close.
          </p>
          <ul
            data-reviewer-shortcuts-list
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "grid",
              gap: 8,
            }}
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
                  borderBottom: "1px solid rgba(255,255,255,0.04)",
                  fontSize: 13.5,
                }}
              >
                <span style={{ opacity: 0.85 }}>{r.label}</span>
                <kbd
                  style={{
                    fontFamily: "monospace",
                    fontSize: 11.5,
                    fontWeight: 600,
                    padding: "2px 8px",
                    borderRadius: 6,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(255,255,255,0.05)",
                  }}
                >
                  {r.key}
                </kbd>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
