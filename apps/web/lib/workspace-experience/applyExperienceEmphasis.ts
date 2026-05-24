/**
 * PHASE R1.5B — Apply experience-mode emphasis to the workflow-
 * exposure result.
 *
 * This helper is the SIDEBAR-ONLY transformation that demotes
 * experience-flagged routes from `primaryItems`/`secondaryItems`
 * into `moreAdvancedItems`. It does NOT change `allToolsItems`,
 * `recommendedItems`, or any access decision.
 *
 * Pure function. No fetches. No authorization. Adding a new route
 * id to `demotionRouteIds` is an emphasis decision, not a permission
 * decision.
 */

import type { WorkflowExposureItem, WorkflowExposureResult } from "../navigation/workflowExposureResolver";

export interface ApplyExperienceEmphasisInput {
  readonly exposure: WorkflowExposureResult;
  readonly demotionRouteIds: ReadonlySet<string>;
}

export interface ApplyExperienceEmphasisResult {
  /** Items that remain in the primary sidebar bucket. */
  readonly primaryItems: ReadonlyArray<WorkflowExposureItem>;
  /** Items that remain in the secondary sidebar bucket. */
  readonly secondaryItems: ReadonlyArray<WorkflowExposureItem>;
  /**
   * Items that should render under "More / Advanced". This is the
   * concatenation of the original `moreAdvancedItems` plus any
   * items demoted out of `primaryItems` / `secondaryItems` by the
   * experience-mode rule.
   */
  readonly moreAdvancedItems: ReadonlyArray<WorkflowExposureItem>;
  /** Number of items demoted (useful for tests + observability). */
  readonly demotedCount: number;
}

/**
 * Apply the demotion. Items whose `route.id` is in
 * `demotionRouteIds` are moved out of `primaryItems` /
 * `secondaryItems` and appended to `moreAdvancedItems`. The relative
 * order within each bucket is preserved. The empty demotion set is a
 * no-op pass-through.
 */
export function applyExperienceEmphasis(
  input: ApplyExperienceEmphasisInput,
): ApplyExperienceEmphasisResult {
  const { exposure, demotionRouteIds } = input;

  if (demotionRouteIds.size === 0) {
    return {
      primaryItems: exposure.primaryItems,
      secondaryItems: exposure.secondaryItems,
      moreAdvancedItems: exposure.moreAdvancedItems,
      demotedCount: 0,
    };
  }

  const keptPrimary: WorkflowExposureItem[] = [];
  const keptSecondary: WorkflowExposureItem[] = [];
  const demoted: WorkflowExposureItem[] = [];

  for (const item of exposure.primaryItems) {
    if (demotionRouteIds.has(item.route.id)) demoted.push(item);
    else keptPrimary.push(item);
  }
  for (const item of exposure.secondaryItems) {
    if (demotionRouteIds.has(item.route.id)) demoted.push(item);
    else keptSecondary.push(item);
  }

  // Original moreAdvancedItems stay first so familiar entries
  // (advancedByDefault routes) keep their position. Demoted items
  // append after.
  const merged: WorkflowExposureItem[] = [
    ...exposure.moreAdvancedItems,
    ...demoted,
  ];

  return {
    primaryItems: keptPrimary,
    secondaryItems: keptSecondary,
    moreAdvancedItems: merged,
    demotedCount: demoted.length,
  };
}
