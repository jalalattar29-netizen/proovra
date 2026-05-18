/**
 * Visibility, review, and export policies for the workflow engine.
 *
 * Phase 1: policy types, schemas, and the baseline policy objects only.
 * The baseline policies in this module are the codified version of
 * today's implicit behavior. When no workflow policy is attached to an
 * evidence record, the visibility resolver returns the same answers the
 * platform already gives — bit-for-bit. Nothing here changes runtime
 * behavior on its own; later phases will read these values from the
 * frozen template snapshot on Evidence.
 *
 * Why JSON-shaped rather than separate Prisma tables: a policy is read
 * every time a record is rendered and must be snapshotted onto Evidence
 * at finalize time. Embedding it in a JSON column keeps reads cheap and
 * snapshots atomic. If a field ever needs to be queried by, it can be
 * denormalized later without changing this shape.
 *
 * Authority for the baseline values:
 *   - services/api/src/services/evidence-review/governance.service.ts
 *     (reviewer comments, legal notes, annotations, AI advisory:
 *     reviewerOnly across publicVerify/report/verificationPackage)
 *   - services/api/src/routes/evidence.routes.ts
 *     (internalNotes and EvidencePart.privateNote are returned via
 *     authenticated GET endpoints; never serialized into report-v2 or
 *     verification-package outputs)
 *   - packages/shared/src/public-identifiers.ts
 *     (identity emails are masked on public/report surfaces via
 *     maskPublicEmail)
 */

import { z } from "zod";

import { WorkflowWorkspaceRoleSchema } from "./workflow-types.js";

// -----------------------------------------------------------------------------
// Audience vocabulary
// -----------------------------------------------------------------------------

export const WORKFLOW_AUDIENCES = [
  "public",
  "authenticated_workspace",
  "reviewer_only",
  "submitter_only",
  "internal_admin_only",
  "hidden",
] as const;

export const WorkflowAudienceSchema = z.enum(WORKFLOW_AUDIENCES);
export type WorkflowAudience = z.infer<typeof WorkflowAudienceSchema>;

// -----------------------------------------------------------------------------
// GPS precision
// -----------------------------------------------------------------------------

export const WORKFLOW_GPS_PRECISIONS = ["exact", "approximate", "hidden"] as const;
export const WorkflowGpsPrecisionSchema = z.enum(WORKFLOW_GPS_PRECISIONS);
export type WorkflowGpsPrecision = z.infer<typeof WorkflowGpsPrecisionSchema>;

// -----------------------------------------------------------------------------
// Visibility policy
//
// Each entry maps a logical data class to the audience that may see it. The
// resolver layers surface-specific transforms (email masking, GPS rounding,
// custody summary) on top of these audience decisions.
// -----------------------------------------------------------------------------

const AudienceFieldSchema = z.object({
  audience: WorkflowAudienceSchema,
});

export const WorkflowVisibilityPolicySchema = z.object({
  sessionInternalNotes: AudienceFieldSchema,
  perPartPrivateNote: AudienceFieldSchema,
  perPartPrivateRole: AudienceFieldSchema,
  publicDescription: AudienceFieldSchema,
  metadataTechnical: AudienceFieldSchema,
  identityFields: AudienceFieldSchema,
  consentRecord: AudienceFieldSchema,
  claimReference: AudienceFieldSchema,
  aiAdvisory: AudienceFieldSchema.extend({
    includeInReport: z.boolean(),
  }),
  gps: z.object({
    audience: WorkflowAudienceSchema,
    precision: WorkflowGpsPrecisionSchema,
  }),
  reviewerCommentInternal: AudienceFieldSchema,
  reviewerCommentExternal: AudienceFieldSchema,
  legalNotes: AudienceFieldSchema,
  annotations: AudienceFieldSchema,
  custodyChainAccess: AudienceFieldSchema,
});
export type WorkflowVisibilityPolicy = z.infer<typeof WorkflowVisibilityPolicySchema>;

/**
 * Baseline visibility policy — the codified version of today's implicit
 * behavior.
 *
 * Changing any value here without a matching change in the renderer /
 * route layer will cause a visibility regression. Treat this object as
 * a contract.
 *
 * Forensic custody events (custody_chain_forensic) and cryptographic
 * anchor proofs (anchor_proof) are not listed because their public
 * audience is invariant — they are integrity-proof material and the
 * workflow engine never gates them.
 */
export const WORKFLOW_BASELINE_VISIBILITY_POLICY: WorkflowVisibilityPolicy = {
  sessionInternalNotes: { audience: "reviewer_only" },
  perPartPrivateNote: { audience: "reviewer_only" },
  perPartPrivateRole: { audience: "reviewer_only" },
  publicDescription: { audience: "public" },
  metadataTechnical: { audience: "public" },
  identityFields: { audience: "public" },
  consentRecord: { audience: "reviewer_only" },
  claimReference: { audience: "authenticated_workspace" },
  aiAdvisory: { audience: "reviewer_only", includeInReport: false },
  gps: { audience: "public", precision: "exact" },
  reviewerCommentInternal: { audience: "reviewer_only" },
  reviewerCommentExternal: { audience: "reviewer_only" },
  legalNotes: { audience: "reviewer_only" },
  annotations: { audience: "reviewer_only" },
  custodyChainAccess: { audience: "authenticated_workspace" },
};

// -----------------------------------------------------------------------------
// Review policy
// -----------------------------------------------------------------------------

export const WORKFLOW_REVIEW_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export const WorkflowReviewPrioritySchema = z.enum(WORKFLOW_REVIEW_PRIORITIES);
export type WorkflowReviewPriority = z.infer<typeof WorkflowReviewPrioritySchema>;

export const WORKFLOW_REVIEW_AUTO_ASSIGN_STRATEGIES = [
  "none",
  "round_robin",
  "least_loaded",
] as const;
export const WorkflowReviewAutoAssignStrategySchema = z.enum(
  WORKFLOW_REVIEW_AUTO_ASSIGN_STRATEGIES,
);
export type WorkflowReviewAutoAssignStrategy = z.infer<
  typeof WorkflowReviewAutoAssignStrategySchema
>;

export const WorkflowReviewPolicySchema = z.object({
  requireReview: z.boolean(),
  defaultPriority: WorkflowReviewPrioritySchema,
  dueWithinHours: z.number().int().min(1).max(24 * 365).nullable(),
  requiredReviewerRoles: z.array(WorkflowWorkspaceRoleSchema).max(4),
  autoAssignStrategy: WorkflowReviewAutoAssignStrategySchema,
});
export type WorkflowReviewPolicy = z.infer<typeof WorkflowReviewPolicySchema>;

/**
 * Baseline review policy — today the platform does not require review on any
 * intake by default. `EvidenceReviewWorkflow` rows are created on demand by
 * reviewers/admins, not auto-instantiated. Preserve that.
 */
export const WORKFLOW_BASELINE_REVIEW_POLICY: WorkflowReviewPolicy = {
  requireReview: false,
  defaultPriority: "NORMAL",
  dueWithinHours: null,
  requiredReviewerRoles: [],
  autoAssignStrategy: "none",
};

// -----------------------------------------------------------------------------
// Export policy
// -----------------------------------------------------------------------------

export const WorkflowExportPolicySchema = z.object({
  allowPublicVerify: z.boolean(),
  allowReportPdf: z.boolean(),
  allowVerificationPackage: z.boolean(),
  watermark: z.string().max(120).nullable(),
  allowedDownloaderRoles: z.array(WorkflowWorkspaceRoleSchema).max(4),
});
export type WorkflowExportPolicy = z.infer<typeof WorkflowExportPolicySchema>;

/**
 * Baseline export policy — today every workspace can publish public verify,
 * generate report-v2, and download verification packages subject to billing
 * entitlements. The workflow engine never tightens this by default; an
 * explicit policy override must opt out.
 */
export const WORKFLOW_BASELINE_EXPORT_POLICY: WorkflowExportPolicy = {
  allowPublicVerify: true,
  allowReportPdf: true,
  allowVerificationPackage: true,
  watermark: null,
  allowedDownloaderRoles: ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
};
