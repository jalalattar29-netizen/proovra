/**
 * PHASE R1.5B — Canonical workspace experience resolver.
 *
 * Pure function. Reads the canonical envelope-derived inputs and
 * returns the experience mode + emphasis hints for the current
 * context.
 *
 * HEADLINE GUARANTEES (pinned by source-contract tests):
 *
 *   1. The resolver NEVER consults `requiredCapabilities`,
 *      `requiredActiveSpace`, or any route-level authorization field.
 *      It produces emphasis hints, not access decisions.
 *
 *   2. The resolver NEVER fetches anything. Inputs are pure data.
 *
 *   3. PERSONAL `activeSpaceType` always resolves to PERSONAL mode.
 *      Personal users never see REVIEW_OPS or GOVERNANCE emphasis
 *      even if some derived capability quirk would suggest it.
 *
 *   4. ORGANIZATION sub-mode (generic ORGANIZATION vs REVIEW_OPS vs
 *      GOVERNANCE) is chosen by primary workflow + capabilities, in
 *      that order. Workflow tilts the emphasis; capabilities make
 *      sure that "review ops emphasis" is not chosen for a user who
 *      has no reviewer capabilities at all.
 */

import { PERSONAL_MODE_DEMOTION_ROUTE_IDS } from "./personalDemotionRules";
import type {
  WorkspaceExperienceInput,
  WorkspaceExperienceResult,
} from "./types";

const EMPTY_DEMOTION_SET: ReadonlySet<string> = new Set();

/**
 * Resolve the canonical experience mode + emphasis hints.
 *
 * Returns a `PERSONAL` default while the envelope is still loading
 * (`activeSpaceType === null`). Consumers should treat this as a
 * neutral starting state, NOT as authorization to render
 * personal-specific UI before the envelope is READY.
 */
export function resolveWorkspaceExperience(
  input: WorkspaceExperienceInput,
): WorkspaceExperienceResult {
  // Loading or unknown — neutral PERSONAL default. The sidebar should
  // not aggressively demote routes until the envelope is READY, so
  // we return the demotion set only when we are confident about the
  // mode. The "loading" case is handled by returning PERSONAL with
  // an empty demotion set (sidebar renders the default exposure).
  if (input.activeSpaceType === null) {
    return {
      mode: "PERSONAL",
      subModeReason: "envelope-loading-neutral-default",
      demotionRouteIds: EMPTY_DEMOTION_SET,
      dashboardEmphasis: "personal-quick-actions",
      helpAudience: "personal-operator",
    };
  }

  if (input.activeSpaceType === "PERSONAL") {
    return {
      mode: "PERSONAL",
      subModeReason: "active-space-is-personal",
      demotionRouteIds: PERSONAL_MODE_DEMOTION_ROUTE_IDS,
      dashboardEmphasis: "personal-quick-actions",
      helpAudience: "personal-operator",
    };
  }

  // ORGANIZATION sub-mode. Chosen purely by capabilities (2026-07-20 —
  // the workflow/persona tilt was removed; emphasis is now deterministic
  // from the actor's capabilities). Reviewer emphasis is only chosen for
  // a user who actually has reviewer capabilities, governance likewise.
  const hasReviewerCap =
    input.capabilities["REVIEWER_OPS_VIEW"] === true ||
    input.capabilities["REVIEWER_OPS_ACT"] === true;
  const hasGovernanceCap =
    input.capabilities["GOVERNANCE_VIEW"] === true ||
    input.capabilities["GOVERNANCE_ACT"] === true;

  if (hasReviewerCap) {
    return {
      mode: "REVIEW_OPS",
      subModeReason: "org-review-ops-capability",
      demotionRouteIds: EMPTY_DEMOTION_SET,
      dashboardEmphasis: "review-ops",
      helpAudience: "review-ops-operator",
    };
  }
  if (hasGovernanceCap) {
    return {
      mode: "GOVERNANCE",
      subModeReason: "org-governance-capability",
      demotionRouteIds: EMPTY_DEMOTION_SET,
      dashboardEmphasis: "governance-compliance",
      helpAudience: "governance-operator",
    };
  }

  // Default ORG sub-mode: generic operational organization.
  return {
    mode: "ORGANIZATION",
    subModeReason: "org-default-operational",
    demotionRouteIds: EMPTY_DEMOTION_SET,
    dashboardEmphasis: "organization-operational",
    helpAudience: "organization-operator",
  };
}
