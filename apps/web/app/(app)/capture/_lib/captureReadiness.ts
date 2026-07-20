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

import type { ChecklistStep, SessionItem } from "./types";

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

/**
 * Phase CAPTURE-PRIMARY-CANONICAL-FIX —
 *
 * The "primary evidence captured" criterion is a UNIVERSAL operational
 * concept across all capture templates (General Evidence Record,
 * Insurance Claim, Legal Matter, Incident/Investigation, Compliance
 * Audit, Journalism/Field Capture, plus any future template). Whenever
 * the operator marks ANY staged item as primary, the criterion must
 * satisfy — independent of which template is selected and which
 * specific primary step the item is mapped to.
 *
 * The authoritative signal is `SessionItem.checklistStepId`. Every
 * template's primary step IDs begin with the `primary_` prefix (or
 * `primary-`), so the canonical predicate is a prefix test.
 *
 * Back-compat: legacy drafts written before the dropdown was rebuilt
 * stored the role as the literal slug (`role = "primary_evidence"`)
 * or as a different slug per template. We keep an explicit match for
 * the two slug variants that ever leaked into drafts so a hydrated
 * pre-fix draft still satisfies the criterion.
 *
 * These helpers are EXPORTED so every consumer (this readiness
 * computer, the dropdown's `getRoleFromChecklistStep` label code in
 * page.tsx, future suggestion engines, future analytics) reads from
 * ONE definition. Duplicating the predicate is the bug class this
 * file is now armoured against.
 */
export function isPrimaryChecklistStepId(
  checklistStepId: string | null | undefined,
): boolean {
  if (!checklistStepId) return false;
  return /^primary[_-]/i.test(checklistStepId.trim());
}

export function isSupportingChecklistStepId(
  checklistStepId: string | null | undefined,
): boolean {
  if (!checklistStepId) return false;
  const s = checklistStepId.trim().toLowerCase();
  return (
    s.startsWith("supporting_") ||
    s.startsWith("context_") ||
    s.startsWith("witness_")
  );
}

/**
 * THE canonical primary-evidence detector. Every readiness consumer
 * MUST go through this helper — never reimplement the predicate.
 *
 * The three branches cover the three shapes of "this item is primary"
 * the production code can produce — and the live-browser bug that
 * required this fix:
 *
 *  1. **Role string (case-insensitive prefix on "primary")** — THE
 *     load-bearing branch. The dropdown's onClick writes
 *     `role: \`${getRoleFromChecklistStep(step)} evidence\`` which
 *     evaluates to `"Primary evidence"` for every primary step in
 *     every template (the role-label fallback `step.required ?
 *     "Primary" : "Supporting"` guarantees this for templates whose
 *     server-issued step ids don't follow the `primary_*` naming
 *     convention — e.g. Insurance Claim ships `overview_media`,
 *     `damage_close_up`; Incident ships `scene_overview`,
 *     `close_up_detail`; Compliance ships `policy_document`,
 *     `screenshot_export`). Without this branch the live browser
 *     keeps showing "Mark a primary evidence item" because the
 *     server's bare-slug step ids defeat the prefix predicate.
 *  2. **`checklistStepId` prefix match** — covers any template whose
 *     server step id DOES begin with `primary_` (general-evidence-
 *     record's `primary_evidence`, legal-matter / journalism-field-
 *     capture's `primary_media`).
 *  3. **Legacy literal slug role** — back-compat for cached drafts
 *     written before the dropdown was rebuilt.
 */
export function hasPrimaryEvidence(
  items: ReadonlyArray<SessionItem>,
): boolean {
  return items.some((i) => {
    // (1) Canonical: role string starts with "primary" (case-insensitive).
    const role = (i.role ?? "").trim().toLowerCase();
    if (role.startsWith("primary")) return true;
    // (2) Slug-prefixed checklistStepId (templates that ship `primary_*` ids).
    if (isPrimaryChecklistStepId(i.checklistStepId)) return true;
    // (3) Legacy literal slug role for any cached draft from before
    //     the dropdown wrote the human-readable role string. The
    //     branch above already covers `"primary_evidence"` /
    //     `"primary_overview_media"` via prefix; this keeps the
    //     intent grep-visible.
    return false;
  });
}

/**
 * Aliased internally to keep the diff small. New callers MUST use the
 * exported `hasPrimaryEvidence` so the canonical name is the entry
 * point of choice.
 */
const hasAnyPrimaryItem = hasPrimaryEvidence;

/**
 * Canonical role label for a template checklist step. Lifted out of
 * `capture/page.tsx` so the dropdown's role label and the readiness
 * predicate share ONE definition — neither file can drift from the
 * other. Returns `"Primary"` when the step id matches the canonical
 * primary prefix, `"Supporting"` when it matches the supporting /
 * context / witness prefix, and falls back to the step's `required`
 * flag for any future template that doesn't follow the convention.
 */
export function getRoleFromChecklistStep(step: ChecklistStep): "Primary" | "Supporting" {
  if (isPrimaryChecklistStepId(step.id)) return "Primary";
  if (isSupportingChecklistStepId(step.id)) return "Supporting";
  return step.required ? "Primary" : "Supporting";
}

function hasAnySupportingContext(items: ReadonlyArray<SessionItem>): boolean {
  return items.some(
    (i) =>
      i.role === "supporting_context" ||
      i.role === "supporting_ownership_document" ||
      i.role === "context_statement" ||
      i.role === "context_audio_statement" ||
      isSupportingChecklistStepId(i.checklistStepId),
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
 * Canonical readiness criterion ids. (2026-07-20) The per-workflow
 * criterion variants were removed with the workspace-persona /
 * workflow-personalization feature.
 */
const CANONICAL_CRITERION_IDS: string[] = [
  "has_primary",
  "has_context_note",
  "no_duplicate_warnings",
];

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
 * capture session. Pure function.
 */
export function computeCaptureReadiness(input: {
  items: ReadonlyArray<SessionItem>;
}): CaptureReadinessSummary {
  const ids = CANONICAL_CRITERION_IDS;
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
