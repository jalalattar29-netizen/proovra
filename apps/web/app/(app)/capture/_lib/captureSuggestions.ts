/**
 * PHASE 38.15 — Capture suggestions layer.
 *
 * Pure function. Turns the bounded readiness criteria into actionable
 * operational suggestions for the operator's current capture session.
 *
 * Hard rules:
 *
 *   1. Pure. Same input → same output. Reads the readiness criteria;
 *      never mutates state, never calls the API.
 *   2. Suggestions are NEVER blocking. The operator can finalize
 *      regardless. The panel is informational + action-prompting only.
 *   3. Bounded vocabulary. Suggestion ids + copy come from a closed
 *      catalog; no free-form generation, no AI claims.
 *   4. Suggestions never assert legal admissibility, authenticity, or
 *      forensic guarantees. (2026-07-20) The per-workflow-profile
 *      dimension was removed with the workspace-persona feature.
 *   5. Each suggestion is keyed on an unsatisfied readiness criterion;
 *      satisfied criteria do not produce suggestions.
 */

import type { CaptureReadinessSummary } from "./captureReadiness";

export type CaptureSuggestion = {
  /** Stable id (matches the readiness criterion id it derives from). */
  id: string;
  /** Operator-facing short title. */
  title: string;
  /** Operational body copy — one or two sentences. */
  body: string;
  /** Bounded tone for visual emphasis. */
  tone: "info" | "warning";
  /**
   * Optional in-page action target. The panel renders a chip with
   * this label that the operator can click; the click handler is
   * owned by the consumer (typically the capture page).
   */
  action?: { label: string; targetId: string };
};

const SUGGESTIONS_BY_CRITERION: Record<string, CaptureSuggestion> = {
  has_primary: {
    id: "has_primary",
    title: "Mark a primary evidence item",
    body: "At least one item should carry the `primary_evidence` role so reports and packages can lead with the right record.",
    tone: "warning",
    action: { label: "Open template selector", targetId: "template-selector" },
  },
  has_supporting: {
    id: "has_supporting",
    title: "Add supporting context",
    body: "Attach at least one supporting context or ownership document so downstream review has the surrounding evidence.",
    tone: "info",
  },
  has_context_note: {
    id: "has_context_note",
    title: "Add an operator context note",
    body: "Add a short context note to at least one item — operators downstream rely on this for triage and review.",
    tone: "warning",
  },
  has_location: {
    id: "has_location",
    title: "Capture location context",
    body: "Include location context on at least one item. Investigation reconstruction depends on time + place signals.",
    tone: "info",
  },
  has_source_label: {
    id: "has_source_label",
    title: "Add a source label",
    body: "Add a source label to at least one item so publication and verification workflows can render provenance.",
    tone: "info",
  },
  no_duplicate_warnings: {
    id: "no_duplicate_warnings",
    title: "Resolve duplicate-content warnings",
    body: "At least one item is flagged as a duplicate of another evidence record. Review the warning before finalizing.",
    tone: "warning",
  },
  at_least_three_items: {
    id: "at_least_three_items",
    title: "Capture additional supporting items",
    body: "Operational intake usually benefits from three or more items — consider adding additional context or supporting evidence.",
    tone: "info",
  },
};

export function computeCaptureSuggestions(input: {
  readiness: CaptureReadinessSummary;
  /** Bounded cap — never returns more than this. Default 4. */
  maxSuggestions?: number;
}): ReadonlyArray<CaptureSuggestion> {
  const max = Math.max(1, input.maxSuggestions ?? 4);
  const out: CaptureSuggestion[] = [];
  for (const criterion of input.readiness.criteria) {
    if (criterion.satisfied) continue;
    const suggestion = SUGGESTIONS_BY_CRITERION[criterion.id];
    if (!suggestion) continue;
    out.push(suggestion);
    if (out.length >= max) break;
  }
  return out;
}
