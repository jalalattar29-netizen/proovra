/**
 * PHASE R3 — Canonical dashboard onboarding orchestrator.
 *
 * Pure function. Returns the contextual onboarding hint when the
 * operator hasn't yet completed setup, or `null` when onboarding is
 * complete (the dashboard already has data to show).
 *
 * The hint NEVER reads as generic enterprise emptiness or "No
 * workspace selected" — those copies were R1 bug markers. The hint
 * always points at an operationally-meaningful action.
 */

import { MODE_ONBOARDING_HINTS } from "./dashboardModeRules";
import type {
  DashboardOnboardingHint,
  DashboardOnboardingInput,
} from "./types";

export function resolveDashboardOnboarding(
  input: DashboardOnboardingInput,
): DashboardOnboardingHint | null {
  if (input.onboardingCompleted) return null;
  return MODE_ONBOARDING_HINTS[input.mode] ?? null;
}
