/**
 * PHASE 38.3 — Workflow-oriented profile mapping.
 *
 * The internal `WorkspacePersonaProfile` enum stays the same for
 * migration safety, but every USER-VISIBLE label and description now
 * reflects workflow-oriented enterprise language instead of profession
 * identity.
 *
 * Hard rules:
 *
 *   1. Workflow framing is UX-ONLY. It NEVER changes capabilities,
 *      tenant scope, billing, or backend object names.
 *   2. Bounded vocabulary. The seven workflow codes are the canonical
 *      public mapping of the internal persona codes. Adding a workflow
 *      requires both a new persona enum value AND an entry here.
 *   3. The mapping is bijective. Every internal persona has exactly
 *      one workflow code, and vice versa.
 *
 * Mapping:
 *
 *   INDIVIDUAL              ↔ VERIFICATION_DOCUMENTATION
 *   LAWYER                  ↔ LEGAL_CASEWORK
 *   INSURANCE               ↔ REVIEW_OPERATIONS
 *   INVESTIGATOR            ↔ INVESTIGATION_RECONSTRUCTION
 *   JOURNALIST              ↔ MEDIA_VERIFICATION
 *   ENTERPRISE_COMPLIANCE   ↔ GOVERNANCE_COMPLIANCE
 *   ADMIN_OPERATOR          ↔ OPERATIONAL_ADMINISTRATION
 */

import type { WorkspacePersonaProfile } from "./types";

export const WORKFLOW_PROFILE_CODES = [
  "VERIFICATION_DOCUMENTATION",
  "LEGAL_CASEWORK",
  "REVIEW_OPERATIONS",
  "INVESTIGATION_RECONSTRUCTION",
  "MEDIA_VERIFICATION",
  "GOVERNANCE_COMPLIANCE",
  "OPERATIONAL_ADMINISTRATION",
] as const;
export type WorkflowProfileCode = (typeof WORKFLOW_PROFILE_CODES)[number];

export type WorkflowProfileDescriptor = {
  /** Internal persona enum (kept for migration safety). */
  persona: WorkspacePersonaProfile;
  /** Public workflow code. */
  code: WorkflowProfileCode;
  /** Human-readable label rendered in onboarding + topbar. */
  label: string;
  /** One-sentence operational description. */
  description: string;
};

const DESCRIPTORS: ReadonlyArray<WorkflowProfileDescriptor> = [
  {
    persona: "INDIVIDUAL",
    code: "VERIFICATION_DOCUMENTATION",
    label: "Verification & Documentation",
    description:
      "Capture, verify, organize, and preserve digital records and evidence.",
  },
  {
    persona: "LAWYER",
    code: "LEGAL_CASEWORK",
    label: "Legal & Case Workflows",
    description:
      "Manage evidence, timelines, reports, and review workflows for legal or case-based operations.",
  },
  {
    persona: "INSURANCE",
    code: "REVIEW_OPERATIONS",
    label: "Review & Operations",
    description:
      "Handle high-volume intake, review queues, assignments, routing, and operational workflows.",
  },
  {
    persona: "INVESTIGATOR",
    code: "INVESTIGATION_RECONSTRUCTION",
    label: "Investigation & Reconstruction",
    description:
      "Analyze timelines, relationships, incidents, and evidence connections across workflows.",
  },
  {
    persona: "JOURNALIST",
    code: "MEDIA_VERIFICATION",
    label: "Media & Publication Verification",
    description:
      "Verify media, prepare publication-ready records, and manage authenticity workflows.",
  },
  {
    persona: "ENTERPRISE_COMPLIANCE",
    code: "GOVERNANCE_COMPLIANCE",
    label: "Governance & Compliance",
    description:
      "Manage retention, audit readiness, governance posture, and operational controls.",
  },
  {
    persona: "ADMIN_OPERATOR",
    code: "OPERATIONAL_ADMINISTRATION",
    label: "Operational Administration",
    description:
      "Monitor operational health, queues, incidents, escalations, and platform workflows.",
  },
];

const BY_PERSONA: ReadonlyMap<WorkspacePersonaProfile, WorkflowProfileDescriptor> =
  new Map(DESCRIPTORS.map((d) => [d.persona, d]));

const BY_CODE: ReadonlyMap<WorkflowProfileCode, WorkflowProfileDescriptor> =
  new Map(DESCRIPTORS.map((d) => [d.code, d]));

/**
 * Resolve the workflow descriptor for an internal persona enum.
 * Always returns a valid descriptor — falls back to the default
 * `VERIFICATION_DOCUMENTATION` if the input is unrecognised.
 */
export function workflowFromPersona(
  persona: WorkspacePersonaProfile,
): WorkflowProfileDescriptor {
  return BY_PERSONA.get(persona) ?? DESCRIPTORS[0];
}

/**
 * Resolve a workflow descriptor by its public workflow code.
 */
export function workflowFromCode(
  code: WorkflowProfileCode,
): WorkflowProfileDescriptor {
  return BY_CODE.get(code) ?? DESCRIPTORS[0];
}

/**
 * Iterate the full bounded list of workflow descriptors — useful for
 * rendering the onboarding wizard options + organization workflow
 * selection.
 */
export function listWorkflowDescriptors(): ReadonlyArray<WorkflowProfileDescriptor> {
  return DESCRIPTORS;
}
