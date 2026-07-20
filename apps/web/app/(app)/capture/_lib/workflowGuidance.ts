/**
 * Capture guidance copy.
 *
 * Bounded operational copy rendered by `CaptureWorkflowGuidance.tsx`.
 * NEVER hides anything — guidance is an additive layer that emphasises
 * the most relevant capture-time considerations.
 *
 * (2026-07-20) The per-workflow-profile variants were removed with the
 * workspace-persona / workflow-personalization feature. Guidance is now
 * canonical: one bounded entry for every operator.
 *
 * Hard rules:
 *
 *   1. Operational tone only. No legal guarantees, no marketing
 *      adjectives, no admissibility-style claims, no claims about
 *      provenance trustworthiness.
 *   2. Bounded — a single canonical entry.
 */

export type CaptureWorkflowGuidance = {
  /** Short title shown above the helper copy. */
  title: string;
  /** One- or two-sentence helper copy. Operational, not legal. */
  helperCopy: string;
  /** Bounded checklist hints. */
  checklist: ReadonlyArray<string>;
  /**
   * Recommended template ids (subset of COLLECTION_PLAN_TEMPLATES).
   * NEVER replaces the full template list — the operator can always
   * pick any template.
   */
  recommendedTemplateIds: ReadonlyArray<string>;
};

export const CAPTURE_GUIDANCE: CaptureWorkflowGuidance = {
  title: "Capture, hash, verify",
  helperCopy:
    "Record the file, capture context, and finalize. Each item is hashed and signed at capture time so the integrity record exists before anything else happens.",
  checklist: [
    "Include a primary evidence file",
    "Add a short context note for each item",
    "Verify location capture if relevant",
  ],
  recommendedTemplateIds: ["general-evidence-record"],
};

export function getCaptureWorkflowGuidance(): CaptureWorkflowGuidance {
  return CAPTURE_GUIDANCE;
}
