"use client";

/**
 * PHASE 38.16 — Contextual help component.
 *
 * Reads the canonical `resolveWorkflowHelp` library for (workflow,
 * surface) help text and renders it as a bounded, dismissible,
 * non-blocking inline panel. Optionally accepts a `stateNotes` array
 * for additional operator-state-aware context (e.g. "no evidence
 * yet" / "review queue is busy") that the consuming surface can
 * provide.
 *
 * Hard rules pinned by Phase 38.16 source-contract tests:
 *
 *   1. Informational + non-blocking. Never an overlay, never a modal.
 *   2. Reads bounded `resolveWorkflowHelp` output — no free-form
 *      generation, no AI claims.
 *   3. Workflow + surface drive the help text; state notes augment.
 *   4. A11y: role="region" + aria-label; dismiss button labelled.
 *   5. Dismissible (localStorage-persisted, scoped per workflow x
 *      surface).
 *   6. Density-aware via the data-operational-density CSS variables.
 *   7. No legal / forensic overclaim — copy comes from the bounded
 *      catalog in workflowHelp.ts.
 */

import { useEffect, useState } from "react";

import {
  resolveWorkflowHelp,
  type HelpSurface,
  type WorkflowProfileCode,
} from "../../lib/platform-context";

const DISMISS_KEY_PREFIX = "contextual-help-dismissed:";

export function ContextualHelp({
  workflow,
  surface,
  stateNotes,
  collapsedByDefault = false,
}: {
  workflow: WorkflowProfileCode;
  surface: HelpSurface;
  /**
   * Optional state-aware notes the consuming surface can provide.
   * E.g. ["No evidence captured yet — start with the camera or
   * the upload dropzone."]. Bounded short strings; consumer is
   * responsible for tone safety.
   */
  stateNotes?: ReadonlyArray<string>;
  /**
   * When true, the panel renders collapsed (header only) and the
   * operator expands it. Useful on dense surfaces where the help is
   * available but should not consume vertical space by default.
   */
  collapsedByDefault?: boolean;
}) {
  const entry = resolveWorkflowHelp({ workflow, surface });
  const dismissKey = `${DISMISS_KEY_PREFIX}${workflow}:${surface}`;
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(!collapsedByDefault);

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
      aria-label={`Contextual help: ${entry.title}`}
      data-contextual-help
      data-contextual-help-workflow={workflow}
      data-contextual-help-surface={surface}
      data-contextual-help-state-note-count={
        stateNotes?.length ?? 0
      }
      style={{
        margin: "8px 0",
        padding: "var(--proovra-density-panel-padding, 10px 14px)",
        borderRadius: 8,
        background: "rgba(30, 64, 175, 0.04)",
        border: "1px solid rgba(30, 64, 175, 0.22)",
        color: "#1e293b",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((p) => !p)}
          aria-expanded={expanded}
          aria-controls={`contextual-help-body-${surface}`}
          data-contextual-help-toggle
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "transparent",
            border: "none",
            color: "#1e40af",
            fontSize:
              "var(--proovra-density-panel-font-size, 12px)",
            fontWeight: 700,
            letterSpacing: 0.3,
            textTransform: "uppercase",
            cursor: "pointer",
            padding: 0,
          }}
        >
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          <span>Help · {entry.title}</span>
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss contextual help"
          data-contextual-help-dismiss
          style={{
            background: "transparent",
            border: "1px solid rgba(30, 64, 175, 0.4)",
            borderRadius: 4,
            padding: "1px 8px",
            fontSize: 11,
            color: "#1e40af",
            cursor: "pointer",
          }}
        >
          Hide
        </button>
      </header>

      {expanded ? (
        <div
          id={`contextual-help-body-${surface}`}
          data-contextual-help-body
          style={{ marginTop: 6 }}
        >
          <p
            style={{
              margin: 0,
              fontSize:
                "var(--proovra-density-panel-font-size, 12px)",
              lineHeight: 1.5,
              color: "#1e293b",
            }}
          >
            {entry.body}
          </p>
          {stateNotes && stateNotes.length > 0 ? (
            <ul
              data-contextual-help-state-notes
              style={{
                margin: "6px 0 0 18px",
                padding: 0,
                fontSize:
                  "var(--proovra-density-panel-font-size, 12px)",
                color: "#1e293b",
              }}
            >
              {stateNotes.map((note, idx) => (
                <li
                  key={idx}
                  data-contextual-help-state-note
                  style={{ marginTop: 2 }}
                >
                  {note}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
