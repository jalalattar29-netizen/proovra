/**
 * PHASE 38.14 — Capture readiness layer.
 *
 * Pure functions. Compute completeness + readiness signals from the
 * operator's CURRENT capture session — no backend calls, no
 * finalization side effects, no AI claims.
 *
 * Hard rules:
 *
 *   1. Read-only. Never mutates session state, files, or hashes.
 *   2. Workflow-aware: the bounded readiness criteria vary by
 *      workflow profile (e.g. LEGAL_CASEWORK weights matter linkage;
 *      INVESTIGATION_RECONSTRUCTION weights sequencing + location).
 *   3. Bounded vocabulary on labels + reasons. No marketing copy.
 *   4. No legal / forensic overclaim labels — the readiness signal
 *      is operational completeness only, not an admissibility or
 *      authenticity assertion.
 *   5. Pure function with stable output for the same input.
 */

import type { WorkflowProfileCode } from "../../../../lib/platform-context";
import type { SessionItem } from "./types";

export type ReadinessLevel = "draft" | "developing" | "ready";

export type ReadinessCriterion = {
  /** Stable id for the criterion (used in tests + data attributes). */
  id: string;
  /** Short bounded label rendered to the operator. */
  label: string;
  /** Bounded one-line description. */
  description: string;
  /** Whether the criterion is currently satisfied. */
  satisfied: boolean;
};

export type CaptureReadinessSummary = {
  /** Bounded readiness level — `draft` until enough criteria pass. */
  level: ReadinessLevel;
  /** Numeric satisfied/total signal — only for the progress bar UI. */
  score: { satisfied: number; total: number };
  /** Ordered list of criteria (satisfied + unsatisfied). */
  criteria: ReadinessCriterion[];
};

/**
 * Bounded criterion factories. Each takes the live session and
 * returns whether the criterion is satisfied. Workflow profiles
 * select which subset to evaluate.
 */

function hasAnyPrimaryItem(items: ReadonlyArray<SessionItem>): boolean {
  return items.some(
    (i) => i.role === "primary_evidence" || i.role === "primary_overview_media",
  );
}
function hasAnySupportingContext(items: ReadonlyArray<SessionItem>): boolean {
  return items.some(
    (i) =>
      i.role === "supporting_context" ||
      i.role === "supporting_ownership_document" ||
      i.role === "context_statement" ||
      i.role === "context_audio_statement",
  );
}
function hasAnyContextNote(items: ReadonlyArray<SessionItem>): boolean {
  return items.some((i) => (i.privateNote ?? "").trim().length > 0);
}
function hasLocationOnAny(items: ReadonlyArray<SessionItem>): boolean {
  return items.some((i) => i.clientSignals?.locationIncluded === true);
}
function hasSourceLabelOnAny(items: ReadonlyArray<SessionItem>): boolean {
  return items.some((i) => (i.sourceLabel ?? "").trim().length > 0);
}
function noDuplicateWarnings(items: ReadonlyArray<SessionItem>): boolean {
  return items.every((i) => i.clientSignals?.duplicateStatus !== "duplicate");
}
function atLeastNItems(
  items: ReadonlyArray<SessionItem>,
  n: number,
): boolean {
  return items.length >= n;
}

const CRITERION_LABEL: Record<
  string,
  { label: string; description: string }
> = {
  has_primary: {
    label: "Primary evidence captured",
    description:
      "At least one item is marked as the primary evidence for this record.",
  },
  has_supporting: {
    label: "Supporting context attached",
    description:
      "At least one supporting context or ownership document is attached.",
  },
  has_context_note: {
    label: "Context note added",
    description:
      "At least one item has an operator context note explaining the capture.",
  },
  has_location: {
    label: "Location context included",
    description:
      "At least one captured item has location context for downstream reconstruction.",
  },
  has_source_label: {
    label: "Source label provided",
    description:
      "At least one item has a source label for publication / verification context.",
  },
  no_duplicate_warnings: {
    label: "No duplicate-content warnings",
    description:
      "No captured item is currently flagged as a duplicate of another evidence record.",
  },
  at_least_three_items: {
    label: "Three or more items captured",
    description:
      "Operational intake usually benefits from at least three captured items.",
  },
};

/**
 * Bounded per-workflow criterion ids. Captures the operational
 * differences between workflow priorities without changing any
 * backend behavior or template availability.
 */
const WORKFLOW_CRITERION_IDS: Record<WorkflowProfileCode, string[]> = {
  VERIFICATION_DOCUMENTATION: [
    "has_primary",
    "has_context_note",
    "no_duplicate_warnings",
  ],
  LEGAL_CASEWORK: [
    "has_primary",
    "has_supporting",
    "has_context_note",
    "no_duplicate_warnings",
  ],
  REVIEW_OPERATIONS: [
    "has_primary",
    "has_supporting",
    "has_context_note",
    "at_least_three_items",
  ],
  INVESTIGATION_RECONSTRUCTION: [
    "has_primary",
    "has_context_note",
    "has_location",
    "at_least_three_items",
  ],
  MEDIA_VERIFICATION: [
    "has_primary",
    "has_source_label",
    "has_context_note",
    "no_duplicate_warnings",
  ],
  GOVERNANCE_COMPLIANCE: [
    "has_primary",
    "has_context_note",
    "no_duplicate_warnings",
  ],
  OPERATIONAL_ADMINISTRATION: [
    "has_primary",
    "has_context_note",
    "at_least_three_items",
  ],
};

function evaluateCriterion(
  id: string,
  items: ReadonlyArray<SessionItem>,
): boolean {
  switch (id) {
    case "has_primary":
      return hasAnyPrimaryItem(items);
    case "has_supporting":
      return hasAnySupportingContext(items);
    case "has_context_note":
      return hasAnyContextNote(items);
    case "has_location":
      return hasLocationOnAny(items);
    case "has_source_label":
      return hasSourceLabelOnAny(items);
    case "no_duplicate_warnings":
      return noDuplicateWarnings(items);
    case "at_least_three_items":
      return atLeastNItems(items, 3);
    default:
      return false;
  }
}

/**
 * Compute the bounded readiness summary for the operator's current
 * capture session given their workflow profile. Pure function.
 */
export function computeCaptureReadiness(input: {
  items: ReadonlyArray<SessionItem>;
  workflow: WorkflowProfileCode;
}): CaptureReadinessSummary {
  const ids =
    WORKFLOW_CRITERION_IDS[input.workflow] ??
    WORKFLOW_CRITERION_IDS.VERIFICATION_DOCUMENTATION;
  const criteria: ReadinessCriterion[] = ids.map((id) => {
    const meta = CRITERION_LABEL[id] ?? {
      label: id,
      description: "",
    };
    return {
      id,
      label: meta.label,
      description: meta.description,
      satisfied: evaluateCriterion(id, input.items),
    };
  });
  const satisfied = criteria.filter((c) => c.satisfied).length;
  const total = criteria.length;
  let level: ReadinessLevel = "draft";
  if (total > 0) {
    const ratio = satisfied / total;
    if (ratio >= 0.99) level = "ready";
    else if (ratio >= 0.5) level = "developing";
  }
  return {
    level,
    score: { satisfied, total },
    criteria,
  };
}
