/**
 * PHASE R3 — Dashboard orchestration types.
 *
 * Pure data types for the canonical dashboard orchestration layer.
 * The orchestrator is an EMPHASIS / ORDERING / CONTEXTUAL-RECOMMENDATION
 * layer on top of the existing single CommandCenter dashboard. It
 * does NOT authorize anything; capabilities + route-access remain
 * authoritative.
 */

import type { WorkspaceExperienceMode } from "../workspace-experience/types";

/**
 * Per-section emphasis hint. Drives `data-cc-section-emphasis`
 * attributes so future CSS / Phase R5/R6 work can target. The
 * orchestrator NEVER removes a section — sections that aren't
 * appropriate for a mode become `de-emphasized`, not hidden.
 *
 * (2026-07-20) The `secondary` tier was removed with the
 * workspace-persona feature — it was assigned exclusively by the
 * deleted persona-priority layer. The neutral contract is now exactly
 * `primary | de-emphasized`: mode-priority sections are `primary`,
 * everything else is `de-emphasized`.
 */
export type SectionEmphasis =
  | "primary"
  | "de-emphasized";

export interface OrderedSectionId {
  readonly id: string;
  readonly emphasis: SectionEmphasis;
}

export interface DashboardSectionsInput {
  readonly mode: WorkspaceExperienceMode;
  readonly availableSectionIds: ReadonlyArray<string>;
}

export interface DashboardSectionsResult {
  /**
   * The bounded display order. Mode priority wins over the canonical
   * default order. Sections that are available but un-prioritized
   * retain their input order at the tail.
   */
  readonly sectionOrder: ReadonlyArray<string>;
  /**
   * Per-section emphasis label, in the same order as `sectionOrder`.
   * Length always equals `sectionOrder.length`.
   */
  readonly sections: ReadonlyArray<OrderedSectionId>;
}

/**
 * Quick action descriptor. Each action is a bounded, contextual
 * shortcut to an EXISTING route. The orchestrator never invents a
 * new route id — every `href` must correspond to a registered route.
 *
 *   intent="primary"   → renders as the visually prominent CTA
 *   intent="secondary" → renders as a lighter chip
 */
export interface DashboardQuickAction {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly intent: "primary" | "secondary";
}

export interface DashboardQuickActionsInput {
  readonly mode: WorkspaceExperienceMode;
}

/**
 * Onboarding hint shown when the workspace has no operational data
 * yet. Mode-aware: personal mode points at capture; ORG modes point
 * at intake / reviewer / governance.
 */
export interface DashboardOnboardingHint {
  readonly label: string;
  readonly href: string;
  readonly tone: "neutral" | "positive";
}

export interface DashboardOnboardingInput {
  readonly mode: WorkspaceExperienceMode;
  readonly onboardingCompleted: boolean;
}
