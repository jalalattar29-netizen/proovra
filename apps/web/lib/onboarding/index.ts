/**
 * PHASE R7 — Canonical onboarding package entry point.
 *
 * Pure orchestration. No fetches. No authorization.
 */

export {
  ONBOARDING_STEP_IDS,
  type OnboardingStepId,
  type OnboardingStep,
  type OnboardingResolverInput,
  type OnboardingResolverResult,
} from "./types";

export {
  ONBOARDING_STEPS_BY_MODE,
  ONBOARDING_STEPS_MAX_PER_MODE,
  ONBOARDING_STEPS_MIN_PER_MODE,
} from "./onboardingSteps";

export { resolveOnboardingState } from "./resolveOnboardingState";
