/**
 * PROOVRA Insurance SIU bundle — bounded domain model.
 *
 * Phase M3.
 *
 * What this is:
 *   * A bounded, additive layer on top of the existing Cases/Matter
 *     workspace. Every consumer (api, worker, web) mechanically
 *     interprets SIU state through these enums and types.
 *
 * What this is NOT:
 *   * NOT a fraud-detection engine.
 *   * NOT a legal-admissibility module.
 *   * NOT a generic insurance CRM.
 *   * NOT a payments / payout system.
 *   * NOT a replacement for Cases/Matter.
 *
 * Hard rules enforced here:
 *   * Every state is a bounded enum.
 *   * Free-form strings (claim numbers, descriptions) are capped at
 *     declared lengths.
 *   * Review indicators are NEVER labelled as fraud findings.
 *   * No PII-leak-by-default: `claimantName` / `claimantContact` are
 *     marked privacy-gated and consumers MUST check
 *     `privacyGatedFieldsExposed` before rendering.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Bounded enums
// ---------------------------------------------------------------------------

export const SIU_CLAIM_TYPES = [
  "auto",
  "property",
  "injury",
  "liability",
  "travel",
  "cyber",
  "other",
] as const;
export type SiuClaimType = (typeof SIU_CLAIM_TYPES)[number];

export const SIU_INVESTIGATION_STATUSES = [
  "intake",
  "collecting",
  "review",
  "follow_up",
  "export_ready",
  "exported",
  "closed",
] as const;
export type SiuInvestigationStatus =
  (typeof SIU_INVESTIGATION_STATUSES)[number];

/**
 * Bounded review-indicator codes. PROOVRA NEVER classifies any of
 * these as "fraud proven" — they are operational signals an SIU
 * reviewer can act on. The labels are deliberately neutral.
 */
export const SIU_REVIEW_INDICATOR_CODES = [
  "DUPLICATE_MEDIA_DETECTED",
  "MISSING_REQUIRED_EVIDENCE",
  "GENERIC_MIME_TYPE_OBSERVED",
  "SCREENSHOT_LIKE_FILE_NAME",
  "FILE_LAST_MODIFIED_OLDER_THAN_INCIDENT",
  "CAPTURE_TIMESTAMP_INCONSISTENT_WITH_CONTEXT",
  "RECOMMENDED_LOCATION_MISSING",
  "EVIDENCE_HASH_CUSTODY_MISMATCH",
  "FOLLOW_UP_OVERDUE",
  "REVIEWER_FLAGGED_FOR_FOLLOW_UP",
] as const;
export type SiuReviewIndicatorCode =
  (typeof SIU_REVIEW_INDICATOR_CODES)[number];

/**
 * Bounded export readiness states. The export route MUST emit one of
 * these values; "blocked" is a hard refusal, "ready_with_warnings"
 * requires an explicit `reason` from the operator.
 */
export const SIU_EXPORT_READINESS_STATES = [
  "ready",
  "ready_with_warnings",
  "blocked",
  "unavailable",
] as const;
export type SiuExportReadinessState =
  (typeof SIU_EXPORT_READINESS_STATES)[number];

/**
 * Bounded preflight failure / warning codes.
 */
export const SIU_PREFLIGHT_CODES = [
  // Bounded warnings — surface but do not block.
  "REQUIRED_EVIDENCE_MISSING",
  "REPORT_PDF_MISSING",
  "VERIFICATION_PACKAGE_MISSING",
  "CORE_INTEGRITY_WARNING_PRESENT",
  "FOLLOW_UP_INCOMPLETE",
  "OFFLINE_VERIFICATION_UNSUPPORTED_FOR_PACKAGE",
  "CUSTODY_AUDIT_GAP",
  // Bounded blockers — refuse the export.
  "LEGAL_HOLD_EXPORT_BLOCK",
  "RETENTION_POLICY_BLOCK",
  "EVIDENCE_INTEGRITY_FAILED",
  "TENANT_OUT_OF_SCOPE",
] as const;
export type SiuPreflightCode = (typeof SIU_PREFLIGHT_CODES)[number];

/**
 * Bounded follow-up status enum.
 */
export const SIU_FOLLOW_UP_STATUSES = [
  "open",
  "sent",
  "received",
  "satisfied",
  "expired",
  "cancelled",
] as const;
export type SiuFollowUpStatus = (typeof SIU_FOLLOW_UP_STATUSES)[number];

/**
 * Bounded checklist item status.
 */
export const SIU_CHECKLIST_ITEM_STATUSES = [
  "missing",
  "submitted",
  "mapped",
  "satisfied",
  "waived",
] as const;
export type SiuChecklistItemStatus =
  (typeof SIU_CHECKLIST_ITEM_STATUSES)[number];

/**
 * Bounded intake-template id enum used both by the template registry
 * and the SIU profile (so the profile mechanically points at a known
 * template).
 */
export const SIU_INTAKE_TEMPLATE_IDS = [
  "insurance-auto-claim",
  "insurance-property-claim",
  "insurance-injury-liability-claim",
  "insurance-cyber-incident-claim",
] as const;
export type SiuIntakeTemplateId = (typeof SIU_INTAKE_TEMPLATE_IDS)[number];

/**
 * Phase M3.2 — bounded SIU capability identifiers. Bound the small
 * set of capabilities that govern SIU PII access so the api can
 * mechanically evaluate each one against the bounded enum.
 *
 *   * `siu.pii.view`   — reveal claimant name / contact in UI.
 *   * `siu.pii.edit`   — create or update claimant PII fields.
 *   * `siu.pii.export` — include claimant PII in the SIU export bundle.
 *
 * These map onto the existing PROOVRA access-policy capability
 * surface. When the access policy does not ship a binding for the
 * capability the bounded fallback (case owner only) applies.
 */
export const SIU_CAPABILITIES = [
  "siu.pii.view",
  "siu.pii.edit",
  "siu.pii.export",
] as const;
export type SiuCapability = (typeof SIU_CAPABILITIES)[number];

/**
 * Phase M3.2 — bounded SIU export status enum mirrored from
 * `case_siu_exports.export_status` so consumers can mechanically
 * interpret the row.
 */
export const SIU_EXPORT_STATUSES = [
  "pending",
  "generated",
  "failed",
  "downloaded",
  "cancelled",
] as const;
export type SiuExportStatus = (typeof SIU_EXPORT_STATUSES)[number];

/**
 * Phase M3.2 — bounded SIU saved-view visibility scopes.
 */
export const SIU_SAVED_VIEW_VISIBILITY = [
  "private",
  "team",
  "organization",
] as const;
export type SiuSavedViewVisibility =
  (typeof SIU_SAVED_VIEW_VISIBILITY)[number];

/**
 * Phase M3.1 — bounded PII visibility policy on the SIU profile.
 * `redacted_by_default` (default) means the service layer redacts
 * `claimantName` / `claimantContact` UNLESS the caller has the
 * `siu.pii.view` capability AND a successful step-up. Operators can
 * mark a profile `team_visible_with_capability` once an explicit
 * decision has been made; the service still enforces the capability.
 */
export const SIU_PII_VISIBILITY_POLICIES = [
  "redacted_by_default",
  "team_visible_with_capability",
  "case_owner_only",
] as const;
export type SiuPiiVisibilityPolicy =
  (typeof SIU_PII_VISIBILITY_POLICIES)[number];

/**
 * Phase M3.1 — bounded SIU saved-view presets. Wired in the api as
 * a static registry; promotion to a durable `CaseSiuSavedView` table
 * is an additive follow-up (the bounded shape stays stable).
 */
export const SIU_SAVED_VIEW_IDS = [
  "claims_needing_evidence",
  "claims_ready_for_review",
  "claims_with_integrity_warnings",
  "claims_ready_for_export",
  "claims_waiting_for_followup",
  "claims_exported_recently",
] as const;
export type SiuSavedViewId = (typeof SIU_SAVED_VIEW_IDS)[number];

export type SiuSavedViewPreset = {
  id: SiuSavedViewId;
  /** Bounded display name (≤80 chars). */
  name: string;
  /** Bounded description (≤200 chars). */
  description: string;
  /** Bounded filter shape — interpreted at query time. */
  filters: {
    investigationStatus?: ReadonlyArray<string>;
    requireMissingChecklistItems?: boolean;
    requireWarningIndicators?: boolean;
    requireOpenFollowUps?: boolean;
    requireRecentExport?: boolean;
  };
};

export const SIU_SAVED_VIEW_PRESETS: ReadonlyArray<SiuSavedViewPreset> = [
  {
    id: "claims_needing_evidence",
    name: "Claims needing evidence",
    description:
      "Profiles in intake or collecting status with at least one missing required checklist item.",
    filters: {
      investigationStatus: ["intake", "collecting"],
      requireMissingChecklistItems: true,
    },
  },
  {
    id: "claims_ready_for_review",
    name: "Claims ready for review",
    description: "Profiles whose investigation status is `review`.",
    filters: { investigationStatus: ["review"] },
  },
  {
    id: "claims_with_integrity_warnings",
    name: "Claims with integrity/provenance warnings",
    description:
      "Profiles with at least one open `warning` or `block_export` indicator.",
    filters: { requireWarningIndicators: true },
  },
  {
    id: "claims_ready_for_export",
    name: "Claims ready for export",
    description:
      "Profiles whose investigation status is `export_ready` — preflight should clear cleanly.",
    filters: { investigationStatus: ["export_ready"] },
  },
  {
    id: "claims_waiting_for_followup",
    name: "Claims waiting for follow-up",
    description:
      "Profiles with at least one open / sent / received follow-up.",
    filters: {
      investigationStatus: ["follow_up"],
      requireOpenFollowUps: true,
    },
  },
  {
    id: "claims_exported_recently",
    name: "Claims exported recently",
    description: "Profiles with at least one export in the last 30 days.",
    filters: { requireRecentExport: true },
  },
];

// ---------------------------------------------------------------------------
// SIU profile shape (additive Case-level metadata)
// ---------------------------------------------------------------------------

export const SIU_PROFILE_SCHEMA_VERSION = "PROOVRA_SIU_PROFILE_V1" as const;

export type SiuChecklistItem = {
  /** Bounded id within the template. */
  itemId: string;
  /** Bounded label (≤120 chars). */
  label: string;
  /** Whether the template marks this item as required. */
  required: boolean;
  /** Bounded current status. */
  status: SiuChecklistItemStatus;
  /** Evidence ids mapped to this item, if any. */
  mappedEvidenceIds: ReadonlyArray<string>;
  /** Optional bounded note (≤240 chars). */
  note: string | null;
};

export type SiuReviewIndicator = {
  /** Bounded code. */
  code: SiuReviewIndicatorCode;
  /** Bounded operator-readable explanation (≤240 chars). */
  explanation: string;
  /** Optional reference to the evidence id that triggered the indicator. */
  evidenceId: string | null;
  /** UTC ISO. */
  observedAtUtc: string;
  /** Bounded severity — `info` / `warning` / `block_export`. */
  severity: "info" | "warning" | "block_export";
};

export type SiuFollowUpRequest = {
  id: string;
  checklistItemId: string;
  /** Bounded status. */
  status: SiuFollowUpStatus;
  /** Bounded due-by UTC. Null when caller did not request one. */
  dueByUtc: string | null;
  requestedAtUtc: string;
  /** Optional bounded note (≤240 chars). */
  note: string | null;
  /** Intake link id when one was generated. NULL when the request was
   *  internal-only. */
  intakeLinkId: string | null;
  /** UTC of latest received evidence. */
  receivedAtUtc: string | null;
  /** Evidence ids returned via this follow-up. */
  returnedEvidenceIds: ReadonlyArray<string>;
};

export type SiuProfile = {
  schemaVersion: typeof SIU_PROFILE_SCHEMA_VERSION;
  caseId: string;
  teamId: string;
  createdAtUtc: string;
  updatedAtUtc: string;
  /** Bounded claim type. */
  claimType: SiuClaimType;
  /** Bounded investigation status. */
  investigationStatus: SiuInvestigationStatus;
  /** Bounded claim number (≤80 chars). NULL on draft. */
  claimNumber: string | null;
  /** Optional bounded policy reference (≤120 chars). */
  policyReference: string | null;
  /** ISO UTC of incident; null if unknown. */
  incidentDate: string | null;
  /** Bounded incident location label (≤200 chars). Optional. */
  incidentLocation: string | null;
  /** Bounded loss description (≤2000 chars). */
  lossDescription: string | null;
  /** Bounded user id of assigned adjuster. NULL when unassigned. */
  assignedAdjusterUserId: string | null;
  /** Bounded user id of assigned SIU reviewer. NULL when unassigned. */
  assignedSIUReviewerUserId: string | null;
  /**
   * Privacy-gated fields — UI consumers MUST NOT render these without
   * checking the deployment's exposure policy. PII-suppressed by
   * default at the api layer.
   */
  claimantName: string | null;
  claimantContact: string | null;
  /** Did the resolver expose privacy-gated fields? */
  privacyGatedFieldsExposed: boolean;
  /** Pointer to the bounded intake template used. */
  intakeTemplateId: SiuIntakeTemplateId | null;
  /** Materialized evidence checklist. */
  checklist: ReadonlyArray<SiuChecklistItem>;
  /** Review indicators (bounded). */
  reviewIndicators: ReadonlyArray<SiuReviewIndicator>;
  /** Open / historical follow-ups. */
  followUps: ReadonlyArray<SiuFollowUpRequest>;
};

// ---------------------------------------------------------------------------
// Bounded zod schemas (used by api routes for input validation)
// ---------------------------------------------------------------------------

export const SiuProfileUpsertInputSchema = z.object({
  claimType: z.enum(SIU_CLAIM_TYPES),
  investigationStatus: z.enum(SIU_INVESTIGATION_STATUSES).optional(),
  claimNumber: z.string().max(80).optional().nullable(),
  policyReference: z.string().max(120).optional().nullable(),
  incidentDate: z.string().datetime().optional().nullable(),
  incidentLocation: z.string().max(200).optional().nullable(),
  lossDescription: z.string().max(2000).optional().nullable(),
  assignedAdjusterUserId: z.string().uuid().optional().nullable(),
  assignedSIUReviewerUserId: z.string().uuid().optional().nullable(),
  claimantName: z.string().max(200).optional().nullable(),
  claimantContact: z.string().max(200).optional().nullable(),
  intakeTemplateId: z.enum(SIU_INTAKE_TEMPLATE_IDS).optional().nullable(),
});
export type SiuProfileUpsertInput = z.infer<typeof SiuProfileUpsertInputSchema>;

// ---------------------------------------------------------------------------
// Forbidden-wording guard
// ---------------------------------------------------------------------------

/**
 * Phrases that PROOVRA NEVER emits on any SIU surface — used as a
 * source-contract sweep in tests.
 */
export const SIU_FORBIDDEN_PHRASES = [
  "fraud detected",
  "fraud proven",
  "fake evidence",
  "claim false",
  "claim is true",
  "guilty",
  "deception confirmed",
  "legally admissible",
  "court-ready proof",
  "authenticity proven",
] as const;

// ---------------------------------------------------------------------------
// Standing limitations — surfaced on every SIU export bundle.
// ---------------------------------------------------------------------------

export const SIU_STANDING_LIMITATIONS = [
  "SIU_BUNDLE_IS_NOT_A_FRAUD_DETERMINATION",
  "SIU_BUNDLE_DOES_NOT_PROVE_CONTENT_TRUTH",
  "SIU_BUNDLE_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY",
  "REVIEW_INDICATORS_ARE_OPERATIONAL_SIGNALS_NOT_FINDINGS",
  "PROOVRA_DOES_NOT_REPLACE_INSURER_CORE_SYSTEMS",
] as const;
export type SiuStandingLimitationCode =
  (typeof SIU_STANDING_LIMITATIONS)[number];

// ---------------------------------------------------------------------------
// Preflight + export bundle types
// ---------------------------------------------------------------------------

export type SiuPreflightFinding = {
  code: SiuPreflightCode;
  severity: "warning" | "blocker";
  /** Bounded operator-readable detail (≤240 chars). */
  detail: string;
  /** Optional evidence id reference. */
  evidenceId: string | null;
};

export type SiuPreflightResult = {
  caseId: string;
  evaluatedAtUtc: string;
  readiness: SiuExportReadinessState;
  findings: ReadonlyArray<SiuPreflightFinding>;
  /** Convenience aggregations for the UI. */
  totals: {
    warnings: number;
    blockers: number;
    requiredChecklistItems: number;
    satisfiedChecklistItems: number;
    openFollowUps: number;
  };
  /** Bounded standing limitations. */
  limitations: ReadonlyArray<SiuStandingLimitationCode>;
};

export const SIU_EXPORT_SCHEMA_VERSION = "PROOVRA_SIU_EXPORT_V1" as const;

/**
 * Structured SIU export summary written as `siu-summary.json` inside
 * the bundle. The bundle ZIP layout is documented in
 * `docs/verticals/insurance-siu-export-format.md`.
 */
export type SiuExportSummary = {
  schemaVersion: typeof SIU_EXPORT_SCHEMA_VERSION;
  generatedAtUtc: string;
  caseId: string;
  teamId: string;
  profile: SiuProfile;
  readiness: SiuExportReadinessState;
  /** Bounded reason captured when readiness === "ready_with_warnings". */
  warningExportReason: string | null;
  /** Counts mirrored from preflight. */
  totals: SiuPreflightResult["totals"];
  /** Bounded standing limitations — always the full set. */
  limitations: ReadonlyArray<SiuStandingLimitationCode>;
  /** Bounded operator-readable note (≤240 chars). */
  note: string;
  /** Evidence ids included in the bundle. */
  includedEvidenceIds: ReadonlyArray<string>;
};

// ---------------------------------------------------------------------------
// Intake template shape (additive)
// ---------------------------------------------------------------------------

export type SiuIntakeTemplate = {
  id: SiuIntakeTemplateId;
  /** Bounded display name (≤120 chars). */
  name: string;
  /** Bounded description (≤480 chars). */
  description: string;
  /** Bounded claim type this template targets. */
  claimType: SiuClaimType;
  /** Bounded list of required checklist items. */
  items: ReadonlyArray<{
    itemId: string;
    label: string;
    /** Bounded explanation (≤240 chars). */
    purpose: string;
    required: boolean;
    /** Whether a captured location is recommended for this item. */
    recommendLocation: boolean;
    /** Bounded list of accepted evidence kinds. */
    acceptedKinds: ReadonlyArray<"PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT">;
  }>;
};

export const SIU_INTAKE_TEMPLATES: ReadonlyArray<SiuIntakeTemplate> = [
  {
    id: "insurance-auto-claim",
    name: "Auto insurance claim",
    description:
      "Required evidence for an auto insurance claim — scene overview, vehicle damage, identifiers, repair documentation, optional witness material.",
    claimType: "auto",
    items: [
      {
        itemId: "scene_overview",
        label: "Scene overview",
        purpose:
          "Wide shot of the scene establishing context and any environmental factors.",
        required: true,
        recommendLocation: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
      {
        itemId: "vehicle_damage_closeups",
        label: "Vehicle damage close-ups",
        purpose:
          "Close-up images of every panel and component with visible damage.",
        required: true,
        recommendLocation: false,
        acceptedKinds: ["PHOTO"],
      },
      {
        itemId: "vehicle_identifier",
        label: "License plate / VIN",
        purpose:
          "License plate and / or VIN image confirming the involved vehicle.",
        required: true,
        recommendLocation: false,
        acceptedKinds: ["PHOTO"],
      },
      {
        itemId: "repair_estimate",
        label: "Repair estimate or invoice",
        purpose: "Document supporting the claimed repair cost.",
        required: true,
        recommendLocation: false,
        acceptedKinds: ["DOCUMENT", "PHOTO"],
      },
      {
        itemId: "police_report",
        label: "Police report (if available)",
        purpose: "Official report from law enforcement, when one was filed.",
        required: false,
        recommendLocation: false,
        acceptedKinds: ["DOCUMENT", "PHOTO"],
      },
      {
        itemId: "witness_statement",
        label: "Witness statement (if available)",
        purpose:
          "Voluntary witness statement audio or written transcript. Optional.",
        required: false,
        recommendLocation: false,
        acceptedKinds: ["AUDIO", "VIDEO", "DOCUMENT"],
      },
    ],
  },
  {
    id: "insurance-property-claim",
    name: "Property insurance claim",
    description:
      "Required evidence for a property claim — damage overview, close-ups, cause context, receipts, repair quote, optional before/after.",
    claimType: "property",
    items: [
      {
        itemId: "damage_overview",
        label: "Damage overview",
        purpose: "Wide shot of the damaged area.",
        required: true,
        recommendLocation: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
      {
        itemId: "damage_closeups",
        label: "Damage close-ups",
        purpose: "Close-up images of each damaged element.",
        required: true,
        recommendLocation: false,
        acceptedKinds: ["PHOTO"],
      },
      {
        itemId: "cause_context",
        label: "Cause / context photos",
        purpose:
          "Images showing the cause of the loss (e.g. burst pipe, fallen tree).",
        required: true,
        recommendLocation: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
      {
        itemId: "receipts_invoices",
        label: "Receipts / invoices",
        purpose: "Proof of value or recent repair / replacement cost.",
        required: false,
        recommendLocation: false,
        acceptedKinds: ["DOCUMENT", "PHOTO"],
      },
      {
        itemId: "repair_quote",
        label: "Repair quote",
        purpose: "Estimated cost to restore the damaged property.",
        required: true,
        recommendLocation: false,
        acceptedKinds: ["DOCUMENT", "PHOTO"],
      },
      {
        itemId: "before_after",
        label: "Before / after (if available)",
        purpose: "Comparative images establishing the pre-loss state.",
        required: false,
        recommendLocation: false,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
    ],
  },
  {
    id: "insurance-injury-liability-claim",
    name: "Injury or liability claim",
    description:
      "Required evidence for an injury / liability claim — incident scene, supporting documents, optional medical / witness material.",
    claimType: "injury",
    items: [
      {
        itemId: "incident_scene",
        label: "Incident scene",
        purpose: "Photos / video establishing the location of the incident.",
        required: true,
        recommendLocation: true,
        acceptedKinds: ["PHOTO", "VIDEO"],
      },
      {
        itemId: "supporting_documents",
        label: "Supporting documents",
        purpose: "Any supporting paperwork the claimant chooses to provide.",
        required: false,
        recommendLocation: false,
        acceptedKinds: ["DOCUMENT", "PHOTO"],
      },
      {
        itemId: "medical_report",
        label: "Medical report (if claimant provides)",
        purpose:
          "Medical documentation. PROOVRA never requires claimants to share medical content.",
        required: false,
        recommendLocation: false,
        acceptedKinds: ["DOCUMENT", "PHOTO"],
      },
      {
        itemId: "witness_media",
        label: "Witness media",
        purpose:
          "Optional witness audio / video / statement. Voluntary and bounded.",
        required: false,
        recommendLocation: false,
        acceptedKinds: ["AUDIO", "VIDEO", "DOCUMENT"],
      },
      {
        itemId: "timeline_note",
        label: "Timeline note",
        purpose: "Bounded chronological narrative from the claimant.",
        required: false,
        recommendLocation: false,
        acceptedKinds: ["DOCUMENT"],
      },
    ],
  },
  {
    id: "insurance-cyber-incident-claim",
    name: "Cyber / digital incident claim",
    description:
      "Required evidence for a cyber claim — screenshots, logs, correspondence, affected account / device notes, timestamped exports.",
    claimType: "cyber",
    items: [
      {
        itemId: "screenshots",
        label: "Screenshots",
        purpose:
          "Screenshots of the affected systems, browser windows, error messages.",
        required: true,
        recommendLocation: false,
        acceptedKinds: ["PHOTO", "DOCUMENT"],
      },
      {
        itemId: "logs_documents",
        label: "Logs / documents",
        purpose: "Application / system logs and any supporting documentation.",
        required: true,
        recommendLocation: false,
        acceptedKinds: ["DOCUMENT"],
      },
      {
        itemId: "correspondence",
        label: "Correspondence",
        purpose: "Emails, chat exports, or any relevant communication.",
        required: false,
        recommendLocation: false,
        acceptedKinds: ["DOCUMENT"],
      },
      {
        itemId: "affected_account_device_notes",
        label: "Affected account / device notes",
        purpose: "Bounded note describing affected accounts / devices.",
        required: true,
        recommendLocation: false,
        acceptedKinds: ["DOCUMENT"],
      },
      {
        itemId: "timestamped_exports",
        label: "Timestamped exports",
        purpose:
          "System-generated exports with platform timestamps where available.",
        required: false,
        recommendLocation: false,
        acceptedKinds: ["DOCUMENT"],
      },
    ],
  },
];

export function getSiuIntakeTemplate(
  id: SiuIntakeTemplateId,
): SiuIntakeTemplate {
  const t = SIU_INTAKE_TEMPLATES.find((x) => x.id === id);
  if (!t) {
    throw new Error(`Unknown SIU intake template: ${id}`);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function buildEmptySiuChecklist(
  template: SiuIntakeTemplate,
): ReadonlyArray<SiuChecklistItem> {
  return template.items.map((item) => ({
    itemId: item.itemId,
    label: item.label,
    required: item.required,
    status: "missing" as const,
    mappedEvidenceIds: [],
    note: null,
  }));
}
