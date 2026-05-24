/**
 * PHASE R7 — Canonical onboarding / setup recovery types.
 *
 * Pure data types for the bounded onboarding step model. The
 * onboarding state is a presentation hint derived from existing
 * canonical sources — `workspacePersonaProfile.onboardingCompleted`,
 * `envelope.activeSpace.type`, and `envelope.capabilities`. R7 does
 * NOT introduce a parallel onboarding state store.
 */

import type { WorkspaceExperienceMode } from "../workspace-experience/types";

export const ONBOARDING_STEP_IDS = [
  // Personal-mode bounded sequence.
  "personal.capture-first-evidence",
  "personal.review-recent-evidence",
  "personal.generate-report",
  "personal.collaboration-basics",
  "personal.intake-link",
  // Organization-mode bounded sequence.
  "org.configure-workspace-profile",
  "org.invite-collaborators",
  "org.configure-intake-links",
  "org.review-queues",
  "org.configure-governance",
  // Reviewer-context bounded sequence.
  "reviewer.open-queue",
  "reviewer.triage-escalations",
  "reviewer.check-sla",
  // Governance-context bounded sequence.
  "governance.review-retention",
  "governance.open-lifecycle",
  "governance.configure-policy",
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

/** A single bounded onboarding step — label + destination + intent. */
export interface OnboardingStep {
  readonly id: OnboardingStepId;
  readonly label: string;
  readonly href: string;
  readonly intent: "primary" | "secondary";
}

export interface OnboardingResolverInput {
  readonly mode: WorkspaceExperienceMode;
  /** From `envelope.personaProfile.onboardingCompleted`. Single source. */
  readonly onboardingCompleted: boolean;
}

export interface OnboardingResolverResult {
  /**
   * Bounded sequence of steps for the current mode (already filtered
   * by onboarding-completed state — when complete the array is empty).
   */
  readonly steps: ReadonlyArray<OnboardingStep>;
  /** Convenience first step (or null when onboarding is complete). */
  readonly nextStep: OnboardingStep | null;
  /** Bounded number of steps in this mode's sequence. */
  readonly totalSteps: number;
  /** Whether onboarding is considered complete for the current mode. */
  readonly isComplete: boolean;
}
