"use client";

/**
 * PROOVRA Phase 2A Closure — Side-pane mode switcher.
 *
 * Bounded mode catalog for the workspace's right-side companion pane:
 *
 *   CODING        — schema-driven coding panel (existing)
 *   ANNOTATIONS   — inline annotation discussion (NEW)
 *   OCR           — OCR text for the active evidence (read-only)
 *   TRANSCRIPT    — transcript segments (read-only)
 *   EVIDENCE      — second-evidence preview (compare two items)
 *   REPORT        — latest report snapshot (read-only)
 *
 * The keyboard hotkey `[` cycles backwards, `]` cycles forwards.
 */

export const SIDE_PANE_MODES = [
  "CODING",
  "ANNOTATIONS",
  "OCR",
  "TRANSCRIPT",
  "EVIDENCE",
  "REPORT",
] as const;
export type SidePaneMode = (typeof SIDE_PANE_MODES)[number];

export function SidePaneSwitcher({
  current,
  onChange,
}: {
  current: SidePaneMode;
  onChange: (next: SidePaneMode) => void;
}) {
  return (
    <nav
      data-side-pane-switcher
      data-side-pane-current={current}
      style={{
        display: "flex",
        gap: 4,
        padding: "6px 8px",
        background: "rgba(15, 23, 42, 0.03)",
        borderRadius: 10,
        border: "1px solid rgba(15, 23, 42, 0.08)",
        flexWrap: "wrap",
      }}
    >
      {SIDE_PANE_MODES.map((m) => (
        <button
          key={m}
          type="button"
          data-side-pane-mode-btn={m}
          onClick={() => onChange(m)}
          style={{
            padding: "4px 10px",
            borderRadius: 6,
            border:
              current === m
                ? "1px solid #0f172a"
                : "1px solid rgba(15, 23, 42, 0.12)",
            background: current === m ? "#0f172a" : "#fff",
            color: current === m ? "#fafafa" : "#0f172a",
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {m}
        </button>
      ))}
    </nav>
  );
}
