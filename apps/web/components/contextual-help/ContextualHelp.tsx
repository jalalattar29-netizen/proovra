"use client";

/**
 * Contextual help component.
 *
 * Renders bounded, surface-keyed help text as a dismissible,
 * non-blocking inline panel. Optionally accepts a `stateNotes` array
 * for additional operator-state-aware context (e.g. "no evidence
 * yet" / "review queue is busy") that the consuming surface can
 * provide.
 *
 * Hard rules pinned by the source-contract tests:
 *
 *   1. Informational + non-blocking. Never an overlay, never a modal.
 *   2. Reads the bounded canonical catalog below — no free-form
 *      generation, no AI claims.
 *   3. Surface drives the help text; state notes augment.
 *   4. A11y: role="region" + aria-label; dismiss button labelled.
 *   5. Dismissible (localStorage-persisted, scoped per surface).
 *   6. No legal / forensic overclaim — copy comes from the bounded
 *      catalog below.
 *
 * (2026-07-20) The per-workflow help override dimension was removed
 * with the workspace-persona / workflow-personalization feature.
 * Help is now canonical: one bounded entry per surface for everyone.
 */

import { useEffect, useState } from "react";

export type HelpSurface =
  | "capture"
  | "evidence"
  | "cases"
  | "reports"
  | "governance"
  | "reviewer-ops"
  | "ops"
  | "teams"
  | "search";

type WorkflowHelpEntry = {
  /** Short headline rendered above the body. */
  title: string;
  /** One-paragraph body. Operational tone; no legal overclaims. */
  body: string;
};

/** Canonical, surface-keyed help catalog. Identical for every operator. */
const SURFACE_HELP: Record<HelpSurface, WorkflowHelpEntry> = {
  capture: {
    title: "What capture does",
    body:
      "Records are hashed and signed at capture time so the resulting evidence carries an integrity record. The hash + signature are independent of the storage backend; you can verify them later from the public verify page.",
  },
  evidence: {
    title: "Evidence integrity",
    body:
      "Every record carries a SHA-256 hash, a signature, and a custody timeline. Generating a report or verification package projects the current state at that moment; the underlying integrity record stays unchanged.",
  },
  cases: {
    title: "Cases bundle related evidence",
    body:
      "A case groups evidence with role-scoped collaboration. Cases do not change the integrity of the underlying evidence.",
  },
  reports: {
    title: "Reports snapshot integrity",
    body:
      "Reports and verification packages snapshot the integrity state at generation time. They are workspace deliverables — they record integrity at the moment of generation and make no claim about legal admissibility or authenticity.",
  },
  governance: {
    title: "Governance controls",
    body:
      "Legal holds, retention windows, and destruction reviews are recorded against evidence and cases. These controls do not change the underlying integrity records; they govern access and lifecycle.",
  },
  "reviewer-ops": {
    title: "Reviewer operations",
    body:
      "Queues route work to reviewers; SLA tracking surfaces breaches; escalations preserve operational continuity. Reviewer actions are audited but do not modify the integrity of the evidence under review.",
  },
  ops: {
    title: "Operations Center",
    body:
      "Operational pressure, queue health, and incidents are aggregated for operator awareness. Acting on an incident is audited; viewing it is not — browse is read-only.",
  },
  teams: {
    title: "Workspace administration",
    body:
      "Workspace administration covers access roles, billing seats, integrations posture, and operational accountability. Every authenticated user has a Personal Space; organizations layer team-scoped access + billing on top. Browse is read-only; explicit invitation and role changes remain audited.",
  },
  search: {
    title: "Operator search",
    body:
      "Operator search spans evidence, workflows, audit events, and cases. Results respect workspace boundaries and the actor's capability set — no result here ever bypasses workspace-scoped access controls.",
  },
};

const DISMISS_KEY_PREFIX = "contextual-help-dismissed:";

export function ContextualHelp({
  surface,
  stateNotes,
  collapsedByDefault = false,
}: {
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
  const entry = SURFACE_HELP[surface];
  const dismissKey = `${DISMISS_KEY_PREFIX}${surface}`;
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
