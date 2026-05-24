/**
 * PHASE R3 — Canonical dashboard orchestration package, entry point.
 *
 * The single source of truth for "what does the dashboard emphasize
 * for the current experience mode + persona + onboarding state."
 *
 * Pure functions only. No authorization. No fetches. No async.
 */

export type {
  SectionEmphasis,
  OrderedSectionId,
  DashboardSectionsInput,
  DashboardSectionsResult,
  DashboardQuickAction,
  DashboardQuickActionsInput,
  DashboardOnboardingHint,
  DashboardOnboardingInput,
} from "./types";

export { resolveDashboardSections } from "./resolveDashboardSections";
export {
  resolveDashboardQuickActions,
  QUICK_ACTIONS_MAX_PER_MODE,
} from "./resolveDashboardQuickActions";
export { resolveDashboardOnboarding } from "./resolveDashboardOnboarding";

export {
  MODE_SECTION_PRIORITY,
  MODE_QUICK_ACTIONS,
  MODE_ONBOARDING_HINTS,
} from "./dashboardModeRules";
