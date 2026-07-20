"use client";

/**
 * PHASE 38.15 — Capture suggestions panel.
 *
 * Renders the operational suggestions derived from the workflow-aware
 * readiness gaps. Companion to `CaptureReadinessPanel`: where the
 * readiness panel reports the state, this panel proposes the next
 * concrete operator action.
 *
 * Hard rules pinned by Phase 38.15 source-contract tests:
 *
 *   1. Informational + non-blocking. The operator can finalize even
 *      when suggestions are present.
 *   2. Bounded vocabulary. Suggestion ids + copy come from the
 *      closed catalog in `captureSuggestions.ts`.
 *   3. A11y: role="region" + aria-label; action buttons are labelled
 *      with the suggestion title.
 *   4. Dismissible (localStorage-persisted, scoped per workflow code).
 */

import { useEffect, useMemo, useState } from "react";

import type { CaptureReadinessSummary } from "./captureReadiness";
import { computeCaptureSuggestions } from "./captureSuggestions";

const DISMISS_KEY_PREFIX = "capture-suggestions-dismissed:";

const TONE_STYLES: Record<
  "info" | "warning",
  { bg: string; border: string; ink: string; pill: string }
> = {
  info: {
    bg: "rgba(148, 163, 184, 0.08)",
    border: "rgba(148, 163, 184, 0.4)",
    ink: "#475569",
    pill: "rgba(148, 163, 184, 0.2)",
  },
  warning: {
    bg: "rgba(245, 158, 11, 0.08)",
    border: "rgba(245, 158, 11, 0.4)",
    ink: "#92400e",
    pill: "rgba(245, 158, 11, 0.2)",
  },
};

export function CaptureSuggestionsPanel({
  readiness,
  onActionClick,
}: {
  readiness: CaptureReadinessSummary;
  /** Optional handler invoked when the operator clicks a suggestion's action. */
  onActionClick?: (targetId: string) => void;
}) {
  const suggestions = useMemo(
    () => computeCaptureSuggestions({ readiness }),
    [readiness],
  );

  const dismissKey = DISMISS_KEY_PREFIX;
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(dismissKey);
      if (stored === "true") setDismissed(true);
    } catch {
      /* ignore */
    }
  }, [dismissKey]);

  if (dismissed) return null;
  if (suggestions.length === 0) return null;

  function dismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(dismissKey, "true");
    } catch {
      /* ignore */
    }
  }

  return (
    <section
      role="region"
      aria-label="Capture suggestions"
      data-capture-suggestions
      data-capture-suggestions-count={suggestions.length}
      style={{
        marginTop: 12,
        padding: "12px 16px",
        borderRadius: 8,
        background: "rgba(148, 163, 184, 0.04)",
        border: "1px solid rgba(148, 163, 184, 0.22)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.4,
            textTransform: "uppercase",
            color: "#475569",
          }}
        >
          Suggested next steps · {suggestions.length}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss capture suggestions panel"
          data-capture-suggestions-dismiss
          style={{
            background: "transparent",
            border: "1px solid #cbd5e1",
            borderRadius: 4,
            padding: "2px 8px",
            fontSize: 11,
            color: "#475569",
            cursor: "pointer",
          }}
        >
          Hide
        </button>
      </header>

      <ul
        data-capture-suggestions-list
        style={{
          margin: "8px 0 0 0",
          padding: 0,
          listStyle: "none",
        }}
      >
        {suggestions.map((s) => {
          const tone = TONE_STYLES[s.tone];
          return (
            <li
              key={s.id}
              data-capture-suggestion-id={s.id}
              data-capture-suggestion-tone={s.tone}
              style={{
                marginTop: 6,
                padding: "8px 10px",
                borderRadius: 6,
                background: tone.bg,
                border: `1px solid ${tone.border}`,
                color: tone.ink,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <strong style={{ fontSize: 12, fontWeight: 700 }}>
                  {s.title}
                </strong>
                {s.action ? (
                  <button
                    type="button"
                    onClick={() => onActionClick?.(s.action!.targetId)}
                    aria-label={`${s.action.label} — ${s.title}`}
                    data-capture-suggestion-action={s.action.targetId}
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: tone.pill,
                      border: `1px solid ${tone.border}`,
                      color: tone.ink,
                      cursor: "pointer",
                    }}
                  >
                    {s.action.label}
                  </button>
                ) : null}
              </div>
              <p
                style={{
                  margin: "4px 0 0 0",
                  fontSize: 12,
                  lineHeight: 1.5,
                  opacity: 0.9,
                }}
              >
                {s.body}
              </p>
            </li>
          );
        })}
      </ul>

      <p
        data-capture-suggestions-footnote
        style={{
          margin: "10px 0 0 0",
          fontSize: 11,
          color: "#64748b",
          lineHeight: 1.5,
        }}
      >
        Suggestions are informational. The capture pipeline (hashing,
        custody, finalization) is governed by the upload flow itself —
        suggestions never block finalization.
      </p>
    </section>
  );
}
