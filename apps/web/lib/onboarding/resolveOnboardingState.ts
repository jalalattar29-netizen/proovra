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
 *   3. Single state source. The resolver consumes
 *      `onboardingCompleted` from `envelope.personaProfile`. NO
 *      parallel onboarding state is introduced.
 *
 *   4. Bounded sequences. The mode → step mapping is the only
 *      source; future modes require deliberate extension.
 */

import { ONBOARDING_STEPS_BY_MODE } from "./onboardingSteps";
import type {
  OnboardingResolverInput,
  OnboardingResolverResult,
} from "./types";

export function resolveOnboardingState(
  input: OnboardingResolverInput,
): OnboardingResolverResult {
  const modeSteps = ONBOARDING_STEPS_BY_MODE[input.mode] ?? [];
  if (input.onboardingCompleted) {
    return {
      steps: [],
      nextStep: null,
      totalSteps: modeSteps.length,
      isComplete: true,
    };
  }
  return {
    steps: modeSteps,
    nextStep: modeSteps[0] ?? null,
    totalSteps: modeSteps.length,
    isComplete: false,
  };
}
