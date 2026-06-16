/**
 * Server-side intake plan templates.
 *
 * These are the canonical PROOVRA intake plan templates. Capture (web/mobile)
 * loads them from /v1/capture/intake-templates rather than embedding a static
 * client-side copy. Each template has a stable id and a monotonic version so
 * that finalized Evidence and CaptureSessions can preserve a snapshot of the
 * exact template that was used at intake time, even if the canonical template
 * is later edited.
 *
 * Why server-driven:
 *   - Versioning: snapshotting the template into Evidence + CaptureSession
 *     guarantees reviewers see exactly the requirements that applied at intake.
 *   - Future extensibility: lets us layer team/org-specific templates on top
 *     without breaking older records.
 *   - Avoids a hard divergence between web and mobile clients.
 *
 * Future: a templates table can override / extend this seed list. For now the
 * seed list IS the source of truth, and the API serves it directly.
 */

import type { EvidenceType } from "@prisma/client";
import type { WorkflowWorkspaceCategory } from "@proovra/shared";

export type IntakeTemplateLocationRequirement =
  | "required"
  | "recommended"
  | "optional";

export type IntakeTemplateAcceptedKind =
  | "PHOTO"
  | "VIDEO"
  | "AUDIO"
  | "DOCUMENT";

export interface IntakeTemplateStep {
  id: string;
  title: string;
  description: string;
  purposeLabel: string;
  required: boolean;
  acceptedKinds: IntakeTemplateAcceptedKind[];
}

export interface IntakeTemplate {
  id: string;
  version: number;
  name: string;
  description: string;
  locationRequirement: IntakeTemplateLocationRequirement;
  archived: boolean;
  steps: IntakeTemplateStep[];
  /**
   * Sector / workspace-category mapping for this seed template.
   *
   * Phase R wiring: the workflow templates admin surface filters by
   * sector via `listEffectiveWorkflowTemplates({ workspaceCategory })`,
   * and the `/v1/workflows/templates` plural alias post-filters on the
   * same field. Before Phase R, no seed declared a category, so any
   * non-"All sectors" filter returned an empty list (every seed was
   * dropped). Each seed now declares the concrete category it serves
   * so the dropdown is meaningful.
   *
   * Optional — a future seed that genuinely spans every sector may omit
   * this, and the merger preserves the legacy "category-agnostic"
   * behaviour for that case (no category filter is applied).
   */
  workspaceCategory?: WorkflowWorkspaceCategory;
}

const TEMPLATES: IntakeTemplate[] = [
  {
    id: "general-evidence-record",
    version: 1,
    name: "General Evidence Record",
    description:
      "Balanced intake for primary evidence and supporting context.",
    locationRequirement: "recommended",
    archived: false,
    workspaceCategory: "GENERAL",
    steps: [
      {
        id: "primary_evidence",
        title: "Primary evidence file",
        description:
          "Upload the principal evidence item that establishes the record.",
        purposeLabel: "Primary evidence",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
      },
      {
        id: "supporting_context",
        title: "Supporting context",
        description:
          "Add supplemental evidence or context files that support the main record.",
        purposeLabel: "Supporting context",
        required: false,
        acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
      },
      {
        id: "optional_statement",
        title: "Optional statement",
        description:
          "Add an optional audio or video statement for additional context.",
        purposeLabel: "Optional statement",
        required: false,
        acceptedKinds: ["AUDIO", "VIDEO"],
      },
    ],
  },
  {
    id: "insurance-claim",
    version: 1,
    name: "Insurance Claim",
    description: "Capture damage, policy documentation, and ownership context.",
    locationRequirement: "recommended",
    archived: false,
    workspaceCategory: "INSURANCE",
    steps: [
      {
        id: "overview_media",
        title: "Overview photo/video",
        description:
          "Capture a high-level image or video overview of the insured loss.",
        purposeLabel: "Overview media",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
      {
        id: "damage_close_up",
        title: "Damage close-up",
        description: "Capture close-up evidence of damage or loss.",
        purposeLabel: "Damage close-up",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
      {
        id: "ownership_document",
        title: "Ownership or policy document",
        description:
          "Upload documentation that proves ownership or policy coverage.",
        purposeLabel: "Ownership or policy document",
        required: true,
        acceptedKinds: ["DOCUMENT"],
      },
      {
        id: "optional_audio",
        title: "Optional audio statement",
        description: "Add an optional audio statement describing the incident.",
        purposeLabel: "Optional audio statement",
        required: false,
        acceptedKinds: ["AUDIO"],
      },
    ],
  },
  {
    id: "legal-matter",
    version: 1,
    name: "Legal Matter",
    description:
      "Collect primary documents, supporting exhibits, and source notes.",
    locationRequirement: "optional",
    archived: false,
    workspaceCategory: "LEGAL",
    steps: [
      {
        id: "primary_media",
        title: "Primary document/media",
        description:
          "Upload the main document or media item that is being preserved.",
        purposeLabel: "Primary document/media",
        required: true,
        acceptedKinds: ["DOCUMENT", "PHOTO", "VIDEO", "AUDIO"],
      },
      {
        id: "supporting_exhibit",
        title: "Supporting exhibit",
        description: "Attach supporting exhibits or evidence items.",
        purposeLabel: "Supporting exhibit",
        required: false,
        acceptedKinds: ["DOCUMENT", "PHOTO", "VIDEO", "AUDIO"],
      },
      {
        id: "source_context",
        title: "Source/context note",
        description: "Provide a source or context note for the evidence.",
        purposeLabel: "Source/context note",
        required: false,
        acceptedKinds: ["DOCUMENT"],
      },
      {
        id: "optional_timeline",
        title: "Optional timeline evidence",
        description:
          "Attach timeline evidence such as logs or recordings.",
        purposeLabel: "Optional timeline evidence",
        required: false,
        acceptedKinds: ["DOCUMENT", "PHOTO", "VIDEO", "AUDIO"],
      },
    ],
  },
  {
    id: "incident-investigation",
    version: 1,
    name: "Incident / Investigation",
    description:
      "Capture scene overview, close-up detail, and witness media.",
    locationRequirement: "required",
    archived: false,
    workspaceCategory: "INVESTIGATIONS",
    steps: [
      {
        id: "scene_overview",
        title: "Scene overview",
        description:
          "Capture an overview image or video of the incident scene.",
        purposeLabel: "Scene overview",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
      {
        id: "close_up_detail",
        title: "Close-up detail",
        description: "Capture close-up detail of the relevant evidence.",
        purposeLabel: "Close-up detail",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
      {
        id: "witness_statement",
        title: "Witness/media statement",
        description: "Add a witness statement or media statement for context.",
        purposeLabel: "Witness/media statement",
        required: false,
        acceptedKinds: ["AUDIO", "VIDEO", "DOCUMENT"],
      },
      {
        id: "supporting_file",
        title: "Supporting file/log",
        description:
          "Attach supporting files such as logs, extracts, or reports.",
        purposeLabel: "Supporting file/log",
        required: false,
        acceptedKinds: ["DOCUMENT", "PHOTO", "VIDEO", "AUDIO"],
      },
    ],
  },
  {
    id: "compliance-audit",
    version: 1,
    name: "Compliance Audit",
    description:
      "Collect policy, audit evidence, and supporting records for review.",
    locationRequirement: "recommended",
    archived: false,
    workspaceCategory: "COMPLIANCE",
    steps: [
      {
        id: "policy_document",
        title: "Policy / compliance document",
        description:
          "Upload the policy, audit document, or compliance file being preserved.",
        purposeLabel: "Policy / compliance document",
        required: true,
        acceptedKinds: ["DOCUMENT"],
      },
      {
        id: "screenshot_export",
        title: "Export / supporting evidence",
        description:
          "Upload the export, screenshot, or supporting evidence file for the compliance record.",
        purposeLabel: "Export / supporting evidence",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO", "DOCUMENT"],
      },
      {
        id: "supporting_evidence",
        title: "Supporting evidence",
        description:
          "Add any additional supporting evidence for the audit record.",
        purposeLabel: "Supporting evidence",
        required: false,
        acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
      },
      {
        id: "reviewer_context",
        title: "Reviewer context note",
        description:
          "Provide an internal note for reviewer context and intake rationale.",
        purposeLabel: "Reviewer context note",
        required: false,
        acceptedKinds: ["DOCUMENT"],
      },
    ],
  },
  {
    id: "journalism-field-capture",
    version: 1,
    name: "Journalism / Field Capture",
    description:
      "Collect primary media, scene context, and source-safe notes.",
    locationRequirement: "recommended",
    archived: false,
    workspaceCategory: "JOURNALISM",
    steps: [
      {
        id: "primary_media",
        title: "Primary media",
        description: "Upload the primary media item for the field report.",
        purposeLabel: "Primary media",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
      {
        id: "scene_context",
        title: "Scene/context capture",
        description: "Capture scene context to support the primary media.",
        purposeLabel: "Scene/context capture",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
      {
        id: "source_safe_note",
        title: "Source-safe note",
        description: "Add an optional source-safe note for the evidence record.",
        purposeLabel: "Source-safe note",
        required: false,
        acceptedKinds: ["DOCUMENT"],
      },
      {
        id: "supporting_document",
        title: "Supporting document",
        description: "Attach any supporting documents or transcripts.",
        purposeLabel: "Supporting document",
        required: false,
        acceptedKinds: ["DOCUMENT"],
      },
    ],
  },
  // Intake-links-e2e Phase 6 — three additional SMB request types
  // that the operator REQUEST_TYPES catalog references. Each is a real
  // backend template (merged into /v1/workflow/templates via
  // listEffectiveWorkflowTemplates), so the dropdown is backed by real
  // data instead of frontend-only constants.
  //
  // Seed-only — no DB rows. The merger is idempotent because seed
  // entries are merged at read time, not written; deploys can't
  // duplicate them.
  {
    id: "photos-videos",
    version: 1,
    name: "Photos & videos",
    description:
      "Ask the contributor for photos and short videos only — no documents required.",
    locationRequirement: "recommended",
    archived: false,
    workspaceCategory: "GENERAL",
    steps: [
      {
        id: "primary_photo_or_video",
        title: "Photo or video",
        description:
          "Upload one or more photos or short videos of what we asked you to capture.",
        purposeLabel: "Photo or video",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
      {
        id: "additional_angle",
        title: "Additional angle (optional)",
        description:
          "Add a second or third photo/video from a different angle if helpful.",
        purposeLabel: "Additional angle",
        required: false,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
    ],
  },
  {
    id: "documents",
    version: 1,
    name: "Documents",
    description:
      "Ask the contributor to send documents only (PDFs, scans, photos of paperwork).",
    locationRequirement: "optional",
    archived: false,
    workspaceCategory: "GENERAL",
    steps: [
      {
        id: "primary_document",
        title: "Document",
        description:
          "Upload the document we asked for. PDFs and clear photos of paperwork both work.",
        purposeLabel: "Document",
        required: true,
        acceptedKinds: ["DOCUMENT", "PHOTO"],
      },
      {
        id: "additional_document",
        title: "Additional document (optional)",
        description: "Attach any related supporting paperwork.",
        purposeLabel: "Additional document",
        required: false,
        acceptedKinds: ["DOCUMENT", "PHOTO"],
      },
    ],
  },
  {
    id: "property-damage",
    version: 1,
    name: "Property damage",
    description:
      "Capture the scene, close-up damage shots, and any repair estimates or receipts.",
    locationRequirement: "required",
    archived: false,
    workspaceCategory: "INSURANCE",
    steps: [
      {
        id: "scene_overview",
        title: "Scene overview",
        description:
          "Wide shot of the area or property so we can see context.",
        purposeLabel: "Scene overview",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
      {
        id: "damage_closeup",
        title: "Close-up of the damage",
        description:
          "Detailed photos of the damage itself, from multiple angles if you can.",
        purposeLabel: "Damage close-up",
        required: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
      {
        id: "estimate_or_receipt",
        title: "Estimate or receipt (optional)",
        description:
          "Upload any repair estimates, invoices, or receipts you already have.",
        purposeLabel: "Estimate or receipt",
        required: false,
        acceptedKinds: ["DOCUMENT", "PHOTO"],
      },
    ],
  },
];

const TEMPLATE_INDEX = new Map(TEMPLATES.map((t) => [t.id, t]));

export function listIntakeTemplates(): IntakeTemplate[] {
  return TEMPLATES.filter((t) => !t.archived);
}

export function getIntakeTemplate(id: string): IntakeTemplate | null {
  return TEMPLATE_INDEX.get(id) ?? null;
}

/**
 * Snapshot the template at the moment it is selected by an intake session.
 * This is what gets persisted to CaptureSession.templateSnapshot and copied
 * into Evidence.intakePlanJson on finalization, so reviewers always see the
 * exact requirements that applied at intake — not a possibly-evolved version.
 */
export function snapshotIntakeTemplate(template: IntakeTemplate) {
  return {
    templateId: template.id,
    templateVersion: template.version,
    templateName: template.name,
    description: template.description,
    locationRequirement: template.locationRequirement,
    steps: template.steps.map((step) => ({
      id: step.id,
      title: step.title,
      description: step.description,
      purposeLabel: step.purposeLabel,
      required: step.required,
      acceptedKinds: [...step.acceptedKinds],
    })),
  };
}

export function isAcceptedKindForEvidenceType(
  kind: IntakeTemplateAcceptedKind,
  evidenceType: EvidenceType
): boolean {
  return kind === (evidenceType as unknown as IntakeTemplateAcceptedKind);
}
