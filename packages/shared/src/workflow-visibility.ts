/**
 * Pure visibility resolver for the PROOVRA Evidence Workflow Engine.
 *
 * Contract: when called with no policy arguments (or with the baseline
 * policies from workflow-policy.ts), this function returns decisions
 * that match today's implicit platform behavior exactly. It is the
 * single, testable seam through which any future policy change must
 * flow.
 *
 * Phase 1 wiring: nothing in production reads this resolver yet.
 * Defining the seam is a no-op for live traffic. Later phases will
 * route report-v2, verification-package, and public-verify rendering
 * through it after extensive snapshot testing.
 *
 * Why pure: no DB, no fetch, no time, no logging. A decision depends
 * only on (dataClass, surface, viewer?, visibilityPolicy?,
 * exportPolicy?). Same inputs always produce the same output. This
 * makes the resolver trivially testable and safe to call from worker,
 * API, and web tiers without coordination.
 */

import {
  WORKFLOW_BASELINE_EXPORT_POLICY,
  WORKFLOW_BASELINE_VISIBILITY_POLICY,
  WorkflowAudience,
  WorkflowExportPolicy,
  WorkflowGpsPrecision,
  WorkflowVisibilityPolicy,
} from "./workflow-policy.js";
import {
  WorkflowIntakeMode,
  WorkflowWorkspaceRole,
} from "./workflow-types.js";

// -----------------------------------------------------------------------------
// Data classes
//
// Every distinct piece of evidence-bearing information the engine knows how
// to gate. Adding one requires a baseline decision and a test case.
// -----------------------------------------------------------------------------

export const WORKFLOW_DATA_CLASSES = [
  "session_internal_notes",
  "per_part_private_note",
  "per_part_private_role",
  "public_description",
  "metadata_technical",
  "gps_exact",
  "gps_approximate",
  "identity_fields",
  "consent_record",
  "claim_reference",
  "ai_advisory_output",
  "reviewer_comment_internal",
  "reviewer_comment_external",
  "legal_note",
  "annotation",
  "custody_chain_forensic",
  "custody_chain_access",
  "anchor_proof",
] as const;

export type WorkflowDataClass = (typeof WORKFLOW_DATA_CLASSES)[number];

// -----------------------------------------------------------------------------
// Surfaces
// -----------------------------------------------------------------------------

export const WORKFLOW_SURFACES = [
  "AUTHENTICATED_APP",
  "PUBLIC_VERIFY",
  "REPORT_PDF",
  "VERIFICATION_PACKAGE",
  "EXTERNAL_SUBMITTER_VIEW",
  "INTERNAL_REVIEWER",
] as const;

export type WorkflowSurface = (typeof WORKFLOW_SURFACES)[number];

// -----------------------------------------------------------------------------
// Viewer context
// -----------------------------------------------------------------------------

export type WorkflowViewerKind =
  | "workspace_member"
  | "public_anonymous"
  | "external_submitter"
  | "platform_admin";

export type WorkflowViewerContext = {
  kind: WorkflowViewerKind;
  role?: WorkflowWorkspaceRole | null;
  intakeMode?: WorkflowIntakeMode | null;
  intakeLinkId?: string | null;
};

// -----------------------------------------------------------------------------
// Decision
// -----------------------------------------------------------------------------

export type WorkflowVisibilityTransform =
  | "none"
  | "mask_email"
  | "approx_gps"
  | "summary_only"
  | "hidden";

export type WorkflowVisibilityDecisionSource =
  | "baseline_default"
  | "visibility_policy"
  | "export_policy"
  | "viewer_role"
  | "export_disabled"
  | "hardcoded_public_proof";

export type WorkflowVisibilityDecision = {
  allowed: boolean;
  transform: WorkflowVisibilityTransform;
  reason: string;
  source: WorkflowVisibilityDecisionSource;
};

export type WorkflowVisibilityResolverInput = {
  dataClass: WorkflowDataClass;
  surface: WorkflowSurface;
  viewer?: WorkflowViewerContext;
  visibilityPolicy?: WorkflowVisibilityPolicy;
  exportPolicy?: WorkflowExportPolicy;
};

// -----------------------------------------------------------------------------
// Audience-to-surface compatibility
// -----------------------------------------------------------------------------

function audienceAllowsSurface(
  audience: WorkflowAudience,
  surface: WorkflowSurface,
): boolean {
  if (audience === "hidden") return false;

  switch (surface) {
    case "AUTHENTICATED_APP":
      // Anything not strictly external-only is visible in the authenticated
      // app (subject to viewer-role gating below).
      return audience !== "submitter_only";

    case "PUBLIC_VERIFY":
      return audience === "public";

    case "REPORT_PDF":
      return audience === "public" || audience === "authenticated_workspace";

    case "VERIFICATION_PACKAGE":
      return audience === "public" || audience === "authenticated_workspace";

    case "EXTERNAL_SUBMITTER_VIEW":
      return audience === "public" || audience === "submitter_only";

    case "INTERNAL_REVIEWER":
      return audience !== "submitter_only";

    default: {
      const _exhaustive: never = surface;
      return _exhaustive;
    }
  }
}

// -----------------------------------------------------------------------------
// Policy lookup
//
// Forensic custody events and anchor proofs are integrity-proof material and
// are never gated by the workflow visibility policy. They are returned as
// hardcoded public.
// -----------------------------------------------------------------------------

type PolicyEntry = {
  audience: WorkflowAudience;
  precision?: WorkflowGpsPrecision;
  includeInReport?: boolean;
  hardcoded?: boolean;
};

function policyForDataClass(
  dataClass: WorkflowDataClass,
  visibility: WorkflowVisibilityPolicy,
): PolicyEntry {
  switch (dataClass) {
    case "session_internal_notes":
      return visibility.sessionInternalNotes;
    case "per_part_private_note":
      return visibility.perPartPrivateNote;
    case "per_part_private_role":
      return visibility.perPartPrivateRole;
    case "public_description":
      return visibility.publicDescription;
    case "metadata_technical":
      return visibility.metadataTechnical;
    case "gps_exact":
    case "gps_approximate":
      return {
        audience: visibility.gps.audience,
        precision: visibility.gps.precision,
      };
    case "identity_fields":
      return visibility.identityFields;
    case "consent_record":
      return visibility.consentRecord;
    case "claim_reference":
      return visibility.claimReference;
    case "ai_advisory_output":
      return {
        audience: visibility.aiAdvisory.audience,
        includeInReport: visibility.aiAdvisory.includeInReport,
      };
    case "reviewer_comment_internal":
      return visibility.reviewerCommentInternal;
    case "reviewer_comment_external":
      return visibility.reviewerCommentExternal;
    case "legal_note":
      return visibility.legalNotes;
    case "annotation":
      return visibility.annotations;
    case "custody_chain_access":
      return visibility.custodyChainAccess;
    case "custody_chain_forensic":
    case "anchor_proof":
      return { audience: "public", hardcoded: true };
    default: {
      const _exhaustive: never = dataClass;
      return _exhaustive;
    }
  }
}

// -----------------------------------------------------------------------------
// Surface-specific transforms
//
// When a (dataClass, surface) pair is allowed, some classes ship with a
// transform that downsamples the value for that surface. These transforms
// match today's behavior:
//   - identity_fields on PUBLIC_VERIFY / REPORT_PDF / EXTERNAL_SUBMITTER_VIEW
//     -> mask emails via maskPublicEmail (see public-identifiers.ts and
//        services/worker/src/report-v2/formatters.ts).
//   - gps_approximate when precision is "approximate"
//     -> coordinates downgraded to city-level accuracy.
//
// Note on custody access events: today the report-v2 PDF and public verify
// expose only the *count* of access events (build-view-model.ts uses
// `custody.access.length`), not the events themselves. The count is a
// public aggregate covered by the `metadata_technical` data class. The
// `custody_chain_access` data class — meaning the events with detail — is
// gated to `authenticated_workspace` audience and ships with no transform.
// "summary_only" is reserved for a future renderer-level summarization
// hook; Phase 1 does not return it from the baseline.
// -----------------------------------------------------------------------------

function chooseTransform(
  dataClass: WorkflowDataClass,
  surface: WorkflowSurface,
  precision: WorkflowGpsPrecision | undefined,
): WorkflowVisibilityTransform {
  if (dataClass === "identity_fields") {
    if (
      surface === "PUBLIC_VERIFY" ||
      surface === "REPORT_PDF" ||
      surface === "EXTERNAL_SUBMITTER_VIEW"
    ) {
      return "mask_email";
    }
    return "none";
  }

  if (dataClass === "gps_approximate" && precision === "approximate") {
    return "approx_gps";
  }

  return "none";
}

// -----------------------------------------------------------------------------
// Viewer-role gates
// -----------------------------------------------------------------------------

const REVIEWER_ROLES: ReadonlyArray<WorkflowWorkspaceRole> = [
  "OWNER",
  "ADMIN",
  "MEMBER",
];

function viewerHasReviewerRank(viewer: WorkflowViewerContext | undefined): boolean {
  if (!viewer) return false;
  if (viewer.kind === "platform_admin") return true;
  if (viewer.kind !== "workspace_member") return false;
  if (!viewer.role) return false;
  return REVIEWER_ROLES.includes(viewer.role);
}

// -----------------------------------------------------------------------------
// Resolver
// -----------------------------------------------------------------------------

function denied(
  reason: string,
  source: WorkflowVisibilityDecisionSource,
): WorkflowVisibilityDecision {
  return { allowed: false, transform: "hidden", reason, source };
}

export function resolveVisibilityForViewer(
  input: WorkflowVisibilityResolverInput,
): WorkflowVisibilityDecision {
  const visibility = input.visibilityPolicy ?? WORKFLOW_BASELINE_VISIBILITY_POLICY;
  const exportPolicy = input.exportPolicy ?? WORKFLOW_BASELINE_EXPORT_POLICY;
  const usingBaseline =
    input.visibilityPolicy === undefined && input.exportPolicy === undefined;

  // 1. Export policy gates the publication surfaces wholesale.
  if (input.surface === "PUBLIC_VERIFY" && !exportPolicy.allowPublicVerify) {
    return denied("export policy disables public verify", "export_disabled");
  }
  if (input.surface === "REPORT_PDF" && !exportPolicy.allowReportPdf) {
    return denied("export policy disables report pdf", "export_disabled");
  }
  if (
    input.surface === "VERIFICATION_PACKAGE" &&
    !exportPolicy.allowVerificationPackage
  ) {
    return denied(
      "export policy disables verification package",
      "export_disabled",
    );
  }

  const entry = policyForDataClass(input.dataClass, visibility);

  // 2. GPS precision gates (independent of audience).
  if (input.dataClass === "gps_exact" && entry.precision !== "exact") {
    return denied(
      `gps precision is ${entry.precision ?? "unset"}`,
      "visibility_policy",
    );
  }
  if (input.dataClass === "gps_approximate" && entry.precision === "hidden") {
    return denied("gps precision is hidden", "visibility_policy");
  }

  // 3. AI advisory: even when audience permits, report inclusion is opt-in.
  if (
    input.dataClass === "ai_advisory_output" &&
    input.surface === "REPORT_PDF" &&
    entry.includeInReport !== true
  ) {
    return denied(
      "ai advisory is not opted in for report inclusion",
      "visibility_policy",
    );
  }

  // 4. Audience compatibility with surface.
  if (!audienceAllowsSurface(entry.audience, input.surface)) {
    return denied(
      `audience ${entry.audience} does not include surface ${input.surface}`,
      "visibility_policy",
    );
  }

  // 5. Viewer-role gates for in-app surfaces.
  const viewer = input.viewer;
  if (viewer && input.surface === "AUTHENTICATED_APP") {
    if (entry.audience === "reviewer_only" && !viewerHasReviewerRank(viewer)) {
      return denied("viewer lacks reviewer rank", "viewer_role");
    }
    if (
      entry.audience === "internal_admin_only" &&
      viewer.kind !== "platform_admin" &&
      !(viewer.kind === "workspace_member" && viewer.role === "OWNER")
    ) {
      return denied("viewer lacks admin rank", "viewer_role");
    }
  }
  if (viewer && input.surface === "EXTERNAL_SUBMITTER_VIEW") {
    if (entry.audience === "submitter_only" && viewer.kind !== "external_submitter") {
      return denied("viewer is not the submitter", "viewer_role");
    }
  }

  // 6. Allowed. Pick the surface-specific transform.
  const transform = chooseTransform(input.dataClass, input.surface, entry.precision);

  let source: WorkflowVisibilityDecisionSource;
  if (entry.hardcoded) {
    source = "hardcoded_public_proof";
  } else if (usingBaseline) {
    source = "baseline_default";
  } else {
    source = "visibility_policy";
  }

  return {
    allowed: true,
    transform,
    reason: "permitted by policy",
    source,
  };
}
