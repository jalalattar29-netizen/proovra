/**
 * PHASE R1.5B — Workspace experience segmentation, canonical entry
 * point. Consumers import from `../lib/workspace-experience` only.
 */

export type {
  WorkspaceExperienceMode,
  WorkspaceExperienceInput,
  WorkspaceExperienceResult,
} from "./types";
export { resolveWorkspaceExperience } from "./resolveWorkspaceExperience";
export { PERSONAL_MODE_DEMOTION_ROUTE_IDS } from "./personalDemotionRules";
export {
  applyExperienceEmphasis,
  type ApplyExperienceEmphasisInput,
  type ApplyExperienceEmphasisResult,
} from "./applyExperienceEmphasis";
