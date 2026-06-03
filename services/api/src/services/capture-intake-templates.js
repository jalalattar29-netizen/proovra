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
const TEMPLATES = [
    {
        id: "general-evidence-record",
        version: 1,
        name: "General Evidence Record",
        description: "Balanced intake for primary evidence and supporting context.",
        locationRequirement: "recommended",
        archived: false,
        steps: [
            {
                id: "primary_evidence",
                title: "Primary evidence file",
                description: "Upload the principal evidence item that establishes the record.",
                purposeLabel: "Primary evidence",
                required: true,
                acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
            },
            {
                id: "supporting_context",
                title: "Supporting context",
                description: "Add supplemental evidence or context files that support the main record.",
                purposeLabel: "Supporting context",
                required: false,
                acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
            },
            {
                id: "optional_statement",
                title: "Optional statement",
                description: "Add an optional audio or video statement for additional context.",
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
        steps: [
            {
                id: "overview_media",
                title: "Overview photo/video",
                description: "Capture a high-level image or video overview of the insured loss.",
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
                description: "Upload documentation that proves ownership or policy coverage.",
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
        description: "Collect primary documents, supporting exhibits, and source notes.",
        locationRequirement: "optional",
        archived: false,
        steps: [
            {
                id: "primary_media",
                title: "Primary document/media",
                description: "Upload the main document or media item that is being preserved.",
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
                description: "Attach timeline evidence such as logs or recordings.",
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
        description: "Capture scene overview, close-up detail, and witness media.",
        locationRequirement: "required",
        archived: false,
        steps: [
            {
                id: "scene_overview",
                title: "Scene overview",
                description: "Capture an overview image or video of the incident scene.",
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
                description: "Attach supporting files such as logs, extracts, or reports.",
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
        description: "Collect policy, audit evidence, and supporting records for review.",
        locationRequirement: "recommended",
        archived: false,
        steps: [
            {
                id: "policy_document",
                title: "Policy / compliance document",
                description: "Upload the policy, audit document, or compliance file being preserved.",
                purposeLabel: "Policy / compliance document",
                required: true,
                acceptedKinds: ["DOCUMENT"],
            },
            {
                id: "screenshot_export",
                title: "Export / supporting evidence",
                description: "Upload the export, screenshot, or supporting evidence file for the compliance record.",
                purposeLabel: "Export / supporting evidence",
                required: true,
                acceptedKinds: ["PHOTO", "VIDEO", "DOCUMENT"],
            },
            {
                id: "supporting_evidence",
                title: "Supporting evidence",
                description: "Add any additional supporting evidence for the audit record.",
                purposeLabel: "Supporting evidence",
                required: false,
                acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
            },
            {
                id: "reviewer_context",
                title: "Reviewer context note",
                description: "Provide an internal note for reviewer context and intake rationale.",
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
        description: "Collect primary media, scene context, and source-safe notes.",
        locationRequirement: "recommended",
        archived: false,
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
];
const TEMPLATE_INDEX = new Map(TEMPLATES.map((t) => [t.id, t]));
export function listIntakeTemplates() {
    return TEMPLATES.filter((t) => !t.archived);
}
export function getIntakeTemplate(id) {
    return TEMPLATE_INDEX.get(id) ?? null;
}
/**
 * Snapshot the template at the moment it is selected by an intake session.
 * This is what gets persisted to CaptureSession.templateSnapshot and copied
 * into Evidence.intakePlanJson on finalization, so reviewers always see the
 * exact requirements that applied at intake — not a possibly-evolved version.
 */
export function snapshotIntakeTemplate(template) {
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
export function isAcceptedKindForEvidenceType(kind, evidenceType) {
    return kind === evidenceType;
}
