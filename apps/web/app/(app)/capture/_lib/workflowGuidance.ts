/**
 * PHASE 38.11 — Workflow-aware capture guidance copy.
 *
 * Bounded operational copy per workflow profile. Pure data; rendered
 * by `CaptureWorkflowGuidance.tsx`. NEVER hides anything — guidance
 * is an additive layer that emphasises the most relevant
 * capture-time considerations for the workflow.
 *
 * Hard rules:
 *
 *   1. Operational tone only. No legal guarantees, no marketing
 *      adjectives, no admissibility-style claims, no claims about
 *      provenance trustworthiness.
 *   2. Workflow safety statement is appended on every variant so
 *      operators know capabilities + template availability are
 *      unchanged by the workflow profile.
 *   3. Bounded — exactly one entry per workflow profile.
 */

import type { WorkflowProfileCode } from "../../../../lib/platform-context";

export type CaptureWorkflowGuidance = {
  /** Short title shown above the helper copy. */
  title: string;
  /** One- or two-sentence helper copy. Operational, not legal. */
  helperCopy: string;
  /** Bounded checklist hints emphasised for this workflow. */
  checklist: ReadonlyArray<string>;
  /**
   * Recommended template ids (subset of COLLECTION_PLAN_TEMPLATES).
   * NEVER replaces the full template list — the operator can always
   * pick any template.
   */
  recommendedTemplateIds: ReadonlyArray<string>;
};

export const CAPTURE_WORKFLOW_GUIDANCE: Record<
  WorkflowProfileCode,
  CaptureWorkflowGuidance
> = {
  VERIFICATION_DOCUMENTATION: {
    title: "Capture, hash, verify",
    helperCopy:
      "Record the file, capture context, and finalize. Each item is hashed and signed at capture time so the integrity record exists before anything else happens.",
    checklist: [
      "Include a primary evidence file",
      "Add a short context note for each item",
      "Verify location capture if relevant",
    ],
    recommendedTemplateIds: ["general-evidence-record"],
  },
  LEGAL_CASEWORK: {
    title: "Capture for a matter",
    helperCopy:
      "Capture and link evidence to a matter so custody, timeline, and report packages stay aligned. Role and category metadata improve later report assembly.",
    checklist: [
      "Pick the matter template that fits this case",
      "Mark each item's role (primary / supporting / context)",
      "Add a custody-relevant note where context matters",
    ],
    recommendedTemplateIds: ["legal-matter", "general-evidence-record"],
  },
  REVIEW_OPERATIONS: {
    title: "Capture for review intake",
    helperCopy:
      "Capture with routing-ready intake metadata. Complete intake fields let the reviewer queue assign and prioritize this submission without follow-up.",
    checklist: [
      "Complete the intake fields the template requests",
      "Add reviewer-relevant context notes",
      "Attach supporting documentation when available",
    ],
    recommendedTemplateIds: ["insurance-claim", "general-evidence-record"],
  },
  INVESTIGATION_RECONSTRUCTION: {
    title: "Capture for reconstruction",
    helperCopy:
      "Capture with timeline + relationship reconstruction in mind. Location and time context strengthen later cross-evidence relationship mapping.",
    checklist: [
      "Capture location + time context when available",
      "Sequence items in the order they were observed",
      "Note relationships between items where known",
    ],
    recommendedTemplateIds: [
      "incident-investigation",
      "general-evidence-record",
    ],
  },
  MEDIA_VERIFICATION: {
    title: "Capture for publication verification",
    helperCopy:
      "Capture media with publication and public-verify readiness in mind. Source notes and provenance context help downstream verification + export.",
    checklist: [
      "Capture provenance + source context",
      "Add notes about how the media was obtained",
      "Include supporting context files when relevant",
    ],
    recommendedTemplateIds: [
      "journalism-field-capture",
      "general-evidence-record",
    ],
  },
  GOVERNANCE_COMPLIANCE: {
    title: "Capture for governance + retention",
    helperCopy:
      "Capture with retention classification and audit readiness in mind. Governance tags + scope metadata feed downstream retention and lifecycle workflows.",
    checklist: [
      "Tag with the governance scope this evidence belongs to",
      "Add retention-relevant context where applicable",
      "Note any legal-hold or destruction-relevant flags",
    ],
    recommendedTemplateIds: ["compliance-audit", "general-evidence-record"],
  },
  OPERATIONAL_ADMINISTRATION: {
    title: "Capture for operational routing",
    helperCopy:
      "Capture so operational systems can route and queue this evidence cleanly. Workflow metadata + intake context reduce manual triage downstream.",
    checklist: [
      "Pick the template matching the operational intake mode",
      "Include the routing-relevant context fields",
      "Attach any workflow-specific supporting docs",
    ],
    recommendedTemplateIds: [
      "compliance-audit",
      "incident-investigation",
      "general-evidence-record",
    ],
  },
};

export function getCaptureWorkflowGuidance(
  workflow: WorkflowProfileCode,
): CaptureWorkflowGuidance {
  return (
    CAPTURE_WORKFLOW_GUIDANCE[workflow] ??
    CAPTURE_WORKFLOW_GUIDANCE.VERIFICATION_DOCUMENTATION
  );
}
