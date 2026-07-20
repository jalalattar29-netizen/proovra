/**
 * PHASE R7 — Canonical onboarding state resolver.
 *
 * Pure function. Reads the canonical `onboardingCompleted` flag and
 * the experience mode, returns the bounded per-mode step sequence
 * (or an empty list once onboarding is complete).
 *
 * Hard rules:
 *
 *   1. Pure synchronous function. No fetches. No I/O. No promises.
 *
 *   2. NO authorization decisions. The resolver returns presentation
 *      steps; the destination route's own PageRouteGate handles
 *      unauthorized clicks.
 *
 *   3. Single state source. The resolver consumes the caller-supplied
 *      `onboardingCompleted` signal. NO parallel onboarding state is
 *      introduced.
 *
 *   4. Bounded sequences. The mode → step mapping is the only
 *      source; future modes require deliberate extension.
 */

import { getPersonaRecommendedNextStep } from "@proovra/shared-evidence-presentation";

import { ONBOARDING_STEPS_BY_MODE } from "./onboardingSteps";
import type {
  OnboardingResolverInput,
  OnboardingResolverResult,
} from "./types";

export function resolveOnboardingState(
  input: OnboardingResolverInput,
): OnboardingResolverResult {
  const modeSteps = ONBOARDING_STEPS_BY_MODE[input.mode] ?? [];
  // Phase E7 — persona is OPTIONAL and ADDITIVE. The mode-driven step
  // sequence remains the canonical onboarding sequence (R7 contract).
  // When a persona code is supplied, the resolver also returns a
  // persona-specific recommended-next-step copy line that surfaces can
  // render alongside the canonical step. The resolver never reorders
  // or filters the steps based on persona.
  const personaRecommendedNextStep = input.personaCode
    ? getPersonaRecommendedNextStep(input.personaCode)
    : undefined;
  if (input.onboardingCompleted) {
    return {
      steps: [],
      nextStep: null,
      totalSteps: modeSteps.length,
      isComplete: true,
      personaRecommendedNextStep,
    };
  }
  return {
    steps: modeSteps,
    nextStep: modeSteps[0] ?? null,
    totalSteps: modeSteps.length,
    isComplete: false,
    personaRecommendedNextStep,
  };
}
