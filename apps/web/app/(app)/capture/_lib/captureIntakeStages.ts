/**
 * PHASE 38.16 — Capture intake stage progression.
 *
 * Pure function. Maps the current capture session state to a bounded
 * 5-stage operational progression:
 *
 *   1. select_template  — operator has picked a collection plan
 *   2. add_materials    — at least one session item is staged
 *   3. map_context      — at least one item has metadata context
 *   4. review_readiness — readiness has been computed at "developing"
 *                          or higher (intake has substance)
 *   5. finish           — terminal stage; the operator can finalize
 *                          regardless (the rail NEVER blocks)
 *
 * Hard rules:
 *
 *   1. Pure function. Same input → same output. No mutation.
 *   2. The rail is INFORMATIONAL only. It NEVER prevents the operator
 *      from finalizing. Stage progression is a soft signal.
 *   3. Bounded vocabulary. Stage ids and labels are fixed. (2026-07-20)
 *      The per-workflow-profile label variants were removed with the
 *      workspace-persona / workflow-personalization feature.
 *   4. No fake intelligence. Stage completion is derived from real
 *      session-item fields the operator can see.
 *   5. No legal / forensic labels. Operational tone only.
 */

import type { CaptureReadinessSummary } from "./captureReadiness";
import type { SessionItem } from "./types";

export type IntakeStageId =
  | "select_template"
  | "add_materials"
  | "map_context"
  | "review_readiness"
  | "finish";

export type IntakeStageStatus = "pending" | "active" | "complete";

export type IntakeStage = {
  id: IntakeStageId;
  label: string;
  status: IntakeStageStatus;
};

/** Canonical stage label catalog. Identical for every operator. */
const STAGE_LABELS: Record<IntakeStageId, string> = {
  select_template: "Select template",
  add_materials: "Add materials",
  map_context: "Add context",
  review_readiness: "Review readiness",
  finish: "Finish & sign",
};

function hasContextOnAnyItem(items: ReadonlyArray<SessionItem>): boolean {
  return items.some(
    (i) =>
      (i.privateNote ?? "").trim().length > 0 ||
      (i.sourceLabel ?? "").trim().length > 0 ||
      i.clientSignals?.locationIncluded === true,
  );
}

/**
 * Compute the bounded 5-stage progression. The OUTPUT array is always
 * exactly 5 entries in the canonical order. Each stage carries a
 * `status` derived from the session state; one stage is marked
 * `active` (the next pending stage), every earlier stage is
 * `complete`, every later stage is `pending`.
 */
export function computeIntakeStages(input: {
  items: ReadonlyArray<SessionItem>;
  collectionPlanSelected: boolean;
  readiness: CaptureReadinessSummary;
}): ReadonlyArray<IntakeStage> {
  const labels = STAGE_LABELS;

  const stageCompletion: Record<IntakeStageId, boolean> = {
    select_template: input.collectionPlanSelected,
    add_materials: input.items.length > 0,
    map_context: hasContextOnAnyItem(input.items),
    review_readiness:
      input.readiness.level === "developing" || input.readiness.level === "ready",
    finish: false, // Terminal stage; the operator finalizes via the
                   // existing capture controls, not via the rail.
  };

  const order: IntakeStageId[] = [
    "select_template",
    "add_materials",
    "map_context",
    "review_readiness",
    "finish",
  ];

  // The active stage is the first non-complete stage.
  let activeIndex = order.findIndex((id) => !stageCompletion[id]);
  if (activeIndex < 0) activeIndex = order.length - 1;

  return order.map((id, idx) => {
    const label = labels[id];
    if (idx < activeIndex) {
      return { id, label, status: "complete" as const };
    }
    if (idx === activeIndex) {
      return { id, label, status: "active" as const };
    }
    return { id, label, status: "pending" as const };
  });
}
