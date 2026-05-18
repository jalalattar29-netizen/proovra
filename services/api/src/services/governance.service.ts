/**
 * Phase 9 — Workspace governance service.
 *
 * Central policy resolver + enforcement helpers. Every sensitive action
 * answers its allow/deny question via one of these functions so policy
 * logic lives in exactly ONE place.
 *
 * Default behavior: a workspace with no `WorkspaceGovernancePolicy` row
 * gets `DEFAULT_POLICY` (permissive — preserves pre-Phase-9 behavior).
 * Existing teams require no migration.
 *
 * Privacy: governance policy + legal hold reasons are workspace-internal.
 * The route layer NEVER returns them to public verify, external intake,
 * or any unauthenticated surface.
 */

import { Prisma } from "@prisma/client";
import type {
  PrismaClient,
  WorkspaceGovernancePolicy as DbPolicy,
  EvidenceLegalHold as DbLegalHold,
  Evidence as DbEvidence,
} from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  Permission,
  roleHasPermission,
  type DbTeamRole,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../db.js";
import { appendCustodyEvent } from "./custody-events.service.js";
import { emitWebhookEvent } from "./integrations/webhook-dispatcher.js";

// -----------------------------------------------------------------------------
// Default policy
// -----------------------------------------------------------------------------

export const DEFAULT_POLICY: Readonly<
  Omit<DbPolicy, "id" | "teamId" | "updatedByUserId" | "createdAt" | "updatedAt" | "metadataRedactionDefault">
> = {
  defaultRetentionDays: null,
  evidenceDeletionMode: prismaPkg.EvidenceDeletionMode.ALLOWED,
  requireLegalHoldApprovalForDeletion: false,
  requireReviewBeforeReport: false,
  requireReviewBeforePackage: false,
  requireReviewBeforePublicVerify: false,
  allowExternalIntake: true,
  allowAnonymousIntake: true,
  allowPublicVerify: true,
  allowPackageDownload: true,
  allowReportDownload: true,
  // Phase 10 — original-file download gate. Default permissive.
  allowOriginalDownload: true,
  // Phase 13.5 — review SLA default foundation. Null means no auto-SLA.
  defaultReviewDueHours: null,
  defaultFirstResponseDueHours: null,
  defaultEscalationDueHours: null,
  // Phase 14 — governance approval flags. False preserves pre-14 behavior.
  requirePublicationApproval: false,
  requireLegalHoldReleaseApproval: false,
  // Phase 25.5 — reviewer-ops SLA + step-up overrides. All optional /
  // false by default so existing workspaces continue to work unchanged.
  defaultAssignmentDueHours: null,
  defaultCompletionDueHours: null,
  defaultDueSoonHours: null,
  requireStepUpForApprove: false,
  requireStepUpForReject: false,
  requireStepUpForEscalationResolve: false,
  requireStepUpForBulk: false,
  reviewerInactivityHours: null,
};

export type EffectivePolicy = typeof DEFAULT_POLICY & {
  source: "workspace_row" | "default";
};

export async function loadWorkspaceGovernancePolicy(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<EffectivePolicy> {
  const row = await client.workspaceGovernancePolicy.findUnique({
    where: { teamId },
  });
  if (!row) {
    return { ...DEFAULT_POLICY, source: "default" };
  }
  return {
    defaultRetentionDays: row.defaultRetentionDays,
    evidenceDeletionMode: row.evidenceDeletionMode,
    requireLegalHoldApprovalForDeletion: row.requireLegalHoldApprovalForDeletion,
    requireReviewBeforeReport: row.requireReviewBeforeReport,
    requireReviewBeforePackage: row.requireReviewBeforePackage,
    requireReviewBeforePublicVerify: row.requireReviewBeforePublicVerify,
    allowExternalIntake: row.allowExternalIntake,
    allowAnonymousIntake: row.allowAnonymousIntake,
    allowPublicVerify: row.allowPublicVerify,
    allowPackageDownload: row.allowPackageDownload,
    allowReportDownload: row.allowReportDownload,
    allowOriginalDownload: row.allowOriginalDownload,
    defaultReviewDueHours: row.defaultReviewDueHours,
    defaultFirstResponseDueHours: row.defaultFirstResponseDueHours,
    defaultEscalationDueHours: row.defaultEscalationDueHours,
    requirePublicationApproval: row.requirePublicationApproval,
    requireLegalHoldReleaseApproval: row.requireLegalHoldReleaseApproval,
    // Phase 25.5 — reviewer-ops SLA + step-up flags.
    defaultAssignmentDueHours: row.defaultAssignmentDueHours,
    defaultCompletionDueHours: row.defaultCompletionDueHours,
    defaultDueSoonHours: row.defaultDueSoonHours,
    requireStepUpForApprove: row.requireStepUpForApprove,
    requireStepUpForReject: row.requireStepUpForReject,
    requireStepUpForEscalationResolve: row.requireStepUpForEscalationResolve,
    requireStepUpForBulk: row.requireStepUpForBulk,
    reviewerInactivityHours: row.reviewerInactivityHours,
    source: "workspace_row",
  };
}

// -----------------------------------------------------------------------------
// Upsert / read
// -----------------------------------------------------------------------------

export type UpsertGovernancePolicyInput = {
  teamId: string;
  actorUserId: string;
  patch: Partial<{
    defaultRetentionDays: number | null;
    evidenceDeletionMode: prismaPkg.EvidenceDeletionMode;
    requireLegalHoldApprovalForDeletion: boolean;
    requireReviewBeforeReport: boolean;
    requireReviewBeforePackage: boolean;
    requireReviewBeforePublicVerify: boolean;
    allowExternalIntake: boolean;
    allowAnonymousIntake: boolean;
    allowPublicVerify: boolean;
    allowPackageDownload: boolean;
    allowReportDownload: boolean;
    allowOriginalDownload: boolean;
    // Phase 14 — governance approval flags.
    requirePublicationApproval: boolean;
    requireLegalHoldReleaseApproval: boolean;
  }>;
};

export async function upsertWorkspaceGovernancePolicy(
  input: UpsertGovernancePolicyInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbPolicy> {
  return client.workspaceGovernancePolicy.upsert({
    where: { teamId: input.teamId },
    create: {
      teamId: input.teamId,
      updatedByUserId: input.actorUserId,
      ...input.patch,
    },
    update: {
      ...input.patch,
      updatedByUserId: input.actorUserId,
    },
  });
}

// -----------------------------------------------------------------------------
// Permission checks
// -----------------------------------------------------------------------------

export type PermissionCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export function requirePermission(
  role: DbTeamRole | null | undefined,
  permission: Permission,
): PermissionCheckResult {
  if (!role) {
    return { allowed: false, reason: "no_workspace_membership" };
  }
  if (roleHasPermission(role, permission)) {
    return { allowed: true };
  }
  return { allowed: false, reason: `role_${role}_lacks_${permission}` };
}

// -----------------------------------------------------------------------------
// Legal hold helpers
// -----------------------------------------------------------------------------

export async function isUnderActiveLegalHold(
  evidenceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const row = await client.evidenceLegalHold.findFirst({
    where: { evidenceId, status: prismaPkg.LegalHoldStatus.ACTIVE },
    select: { id: true },
  });
  return Boolean(row);
}

export async function listLegalHoldsForEvidence(
  evidenceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<DbLegalHold[]> {
  return client.evidenceLegalHold.findMany({
    where: { evidenceId },
    orderBy: { placedAtUtc: "desc" },
  });
}

export async function listLegalHoldsForTeam(
  input: {
    teamId: string;
    status?: prismaPkg.LegalHoldStatus;
    limit?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<DbLegalHold[]> {
  return client.evidenceLegalHold.findMany({
    where: {
      teamId: input.teamId,
      ...(input.status ? { status: input.status } : {}),
    },
    orderBy: { placedAtUtc: "desc" },
    take: Math.min(Math.max(input.limit ?? 100, 1), 500),
  });
}

export type PlaceLegalHoldInput = {
  teamId: string;
  evidenceId: string;
  actorUserId: string;
  title: string;
  reason?: string | null;
  caseId?: string | null;
};

export async function placeLegalHold(
  input: PlaceLegalHoldInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbLegalHold> {
  // Verify the evidence belongs to the workspace before placing the hold.
  const evidence = await client.evidence.findUnique({
    where: { id: input.evidenceId },
    select: { id: true, teamId: true },
  });
  if (!evidence || evidence.teamId !== input.teamId) {
    throw Object.assign(new Error("evidence_not_in_workspace"), {
      statusCode: 404,
      code: "evidence_not_found",
    });
  }

  const hold = await client.evidenceLegalHold.create({
    data: {
      teamId: input.teamId,
      evidenceId: input.evidenceId,
      caseId: input.caseId ?? null,
      title: input.title.slice(0, 180),
      reason: input.reason?.slice(0, 4000) ?? null,
      status: prismaPkg.LegalHoldStatus.ACTIVE,
      placedByUserId: input.actorUserId,
    },
  });

  // Emit a custody event into the existing forensic chain so the legal
  // hold is visible in the same audit timeline as integrity events.
  // Failures don't block — the hold is durable; chain emission is
  // observability.
  await appendCustodyEvent({
    evidenceId: input.evidenceId,
    eventType: prismaPkg.CustodyEventType.LEGAL_HOLD_PLACED,
    payload: {
      legalHoldId: hold.id,
      title: hold.title,
      placedByUserId: input.actorUserId,
    },
  }).catch(() => null);

  // Phase 10 — fire `governance.legal_hold_placed`. Reason is NEVER
  // emitted to the outbound payload (workspace-internal context).
  await emitWebhookEvent({
    teamId: input.teamId,
    eventType: "governance.legal_hold_placed",
    payload: {
      legalHoldId: hold.id,
      evidenceId: input.evidenceId,
      title: hold.title,
      caseId: hold.caseId,
      placedAtUtc: hold.placedAtUtc.toISOString(),
      // Deliberately NOT projected: reason.
    },
    attemptInline: false,
  }).catch(() => null);

  return hold;
}

export type ReleaseLegalHoldInput = {
  id: string;
  teamId: string;
  actorUserId: string;
  releaseNote: string;
};

export async function releaseLegalHold(
  input: ReleaseLegalHoldInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbLegalHold> {
  const note = input.releaseNote.trim();
  if (note.length === 0) {
    throw Object.assign(new Error("release_note_required"), {
      statusCode: 422,
      code: "release_note_required",
    });
  }

  const hold = await client.evidenceLegalHold.findUnique({
    where: { id: input.id },
  });
  if (!hold || hold.teamId !== input.teamId) {
    throw Object.assign(new Error("legal_hold_not_found"), {
      statusCode: 404,
      code: "legal_hold_not_found",
    });
  }
  if (hold.status === prismaPkg.LegalHoldStatus.RELEASED) {
    return hold;
  }

  const released = await client.evidenceLegalHold.update({
    where: { id: input.id },
    data: {
      status: prismaPkg.LegalHoldStatus.RELEASED,
      releasedAtUtc: new Date(),
      releasedByUserId: input.actorUserId,
      releaseNote: note.slice(0, 4000),
    },
  });

  await appendCustodyEvent({
    evidenceId: hold.evidenceId,
    eventType: prismaPkg.CustodyEventType.LEGAL_HOLD_RELEASED,
    payload: {
      legalHoldId: hold.id,
      releasedByUserId: input.actorUserId,
    },
  }).catch(() => null);

  return released;
}

// -----------------------------------------------------------------------------
// Policy enforcement decisions
//
// Each helper returns { allowed, reason } so the caller can both block
// the action AND emit a uniform audit event explaining why. None throw
// — that keeps the call sites tidy.
// -----------------------------------------------------------------------------

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export async function canDeleteEvidence(input: {
  role: DbTeamRole | null | undefined;
  evidence: Pick<DbEvidence, "id" | "teamId" | "retentionUntilUtc">;
  policy: EffectivePolicy;
  client?: PrismaClient;
}): Promise<PolicyDecision> {
  const perm = requirePermission(input.role, "evidence.delete");
  if (!perm.allowed) return perm;

  if (input.policy.evidenceDeletionMode === "DISABLED") {
    return { allowed: false, reason: "deletion_disabled_by_policy" };
  }
  if (
    input.policy.evidenceDeletionMode === "ADMIN_ONLY" &&
    input.role !== "OWNER" &&
    input.role !== "ADMIN"
  ) {
    return { allowed: false, reason: "deletion_restricted_to_admin" };
  }

  // Retention check — never delete before retentionUntilUtc.
  if (
    input.evidence.retentionUntilUtc &&
    input.evidence.retentionUntilUtc.getTime() > Date.now()
  ) {
    return { allowed: false, reason: "blocked_by_retention" };
  }

  // Legal hold check — pull holds via the client.
  const client = input.client ?? defaultPrisma;
  if (await isUnderActiveLegalHold(input.evidence.id, client)) {
    return { allowed: false, reason: "blocked_by_legal_hold" };
  }

  return { allowed: true };
}

export async function canArchiveEvidence(input: {
  role: DbTeamRole | null | undefined;
  evidence: Pick<DbEvidence, "id" | "teamId">;
  policy: EffectivePolicy;
  client?: PrismaClient;
}): Promise<PolicyDecision> {
  const perm = requirePermission(input.role, "evidence.archive");
  if (!perm.allowed) return perm;

  const client = input.client ?? defaultPrisma;
  if (await isUnderActiveLegalHold(input.evidence.id, client)) {
    return { allowed: false, reason: "blocked_by_legal_hold" };
  }
  return { allowed: true };
}

export function canGenerateReport(input: {
  role: DbTeamRole | null | undefined;
  policy: EffectivePolicy;
  reviewState?: { isReviewed: boolean } | null;
}): PolicyDecision {
  const perm = requirePermission(input.role, "evidence.generate_report");
  if (!perm.allowed) return perm;
  if (
    input.policy.requireReviewBeforeReport &&
    !input.reviewState?.isReviewed
  ) {
    return { allowed: false, reason: "review_required_before_report" };
  }
  if (!input.policy.allowReportDownload) {
    return { allowed: false, reason: "report_disabled_by_policy" };
  }
  return { allowed: true };
}

export function canGeneratePackage(input: {
  role: DbTeamRole | null | undefined;
  policy: EffectivePolicy;
  reviewState?: { isReviewed: boolean } | null;
}): PolicyDecision {
  const perm = requirePermission(input.role, "evidence.generate_package");
  if (!perm.allowed) return perm;
  if (
    input.policy.requireReviewBeforePackage &&
    !input.reviewState?.isReviewed
  ) {
    return { allowed: false, reason: "review_required_before_package" };
  }
  if (!input.policy.allowPackageDownload) {
    return { allowed: false, reason: "package_disabled_by_policy" };
  }
  return { allowed: true };
}

export function canPublishPublicVerify(input: {
  role: DbTeamRole | null | undefined;
  policy: EffectivePolicy;
  reviewState?: { isReviewed: boolean } | null;
}): PolicyDecision {
  const perm = requirePermission(input.role, "evidence.publish_verify");
  if (!perm.allowed) return perm;
  if (
    input.policy.requireReviewBeforePublicVerify &&
    !input.reviewState?.isReviewed
  ) {
    return { allowed: false, reason: "review_required_before_public_verify" };
  }
  if (!input.policy.allowPublicVerify) {
    return { allowed: false, reason: "public_verify_disabled_by_policy" };
  }
  return { allowed: true };
}

export function canCreateIntakeLink(input: {
  role: DbTeamRole | null | undefined;
  intakeMode: string;
  policy: EffectivePolicy;
}): PolicyDecision {
  const perm = requirePermission(input.role, "workflow.intake_link.create");
  if (!perm.allowed) return perm;
  if (!input.policy.allowExternalIntake) {
    return { allowed: false, reason: "external_intake_disabled_by_policy" };
  }
  const isAnonymous =
    input.intakeMode === "EXTERNAL_ANONYMOUS" ||
    input.intakeMode === "EXTERNAL_PSEUDONYMOUS";
  if (isAnonymous && !input.policy.allowAnonymousIntake) {
    return { allowed: false, reason: "anonymous_intake_disabled_by_policy" };
  }
  return { allowed: true };
}

export function canDownloadPackage(input: {
  role: DbTeamRole | null | undefined;
  policy: EffectivePolicy;
}): PolicyDecision {
  const perm = requirePermission(input.role, "evidence.download_package");
  if (!perm.allowed) return perm;
  if (!input.policy.allowPackageDownload) {
    return { allowed: false, reason: "package_disabled_by_policy" };
  }
  return { allowed: true };
}

// -----------------------------------------------------------------------------
// Review-state resolver — answers "is this evidence reviewed enough to
// satisfy a `requireReviewBefore*` policy gate?"
//
// `IN_REVIEW`, `APPROVED_INTERNAL`, `READY_FOR_EXTERNAL_REVIEW` all
// count as "reviewed". `NOT_STARTED` and `NEEDS_INFO` do not.
// -----------------------------------------------------------------------------

/**
 * Phase 13.5 — pure predicate used by both `evidenceIsReviewed` (DB
 * lookup) and the governance regression tests. Returns true ONLY for
 * the two statuses that count as "approved for export":
 *   - APPROVED_INTERNAL (explicit operator decision)
 *   - READY_FOR_EXTERNAL_REVIEW (legacy: internal review concluded;
 *     handed off to external review)
 *
 * Everything else — including IN_REVIEW (mid-review),
 * NEEDS_INFO/NEEDS_MORE_INFO, RESPONSE_RECEIVED, ESCALATED, REOPENED,
 * QUEUED, ASSIGNED, REJECTED_INSUFFICIENT, CLOSED, NOT_STARTED — does
 * NOT satisfy the gate.
 */
export function reviewStatusSatisfiesGovernanceGate(
  status: string | null | undefined,
): boolean {
  if (!status) return false;
  return (
    status ===
      prismaPkg.EvidenceReviewWorkflowStatus.APPROVED_INTERNAL ||
    status ===
      prismaPkg.EvidenceReviewWorkflowStatus.READY_FOR_EXTERNAL_REVIEW
  );
}

/**
 * Phase 14 — read + resolve the workspace metadata redaction policy.
 * The policy is stored as JSON on `WorkspaceGovernancePolicy.metadataRedactionDefault`
 * and merged with `DEFAULT_REDACTION_POLICY` (with public-verify floor
 * enforcement) by `resolveRedactionPolicy`. Returns the canonical
 * default policy when no override exists.
 */
export async function loadRedactionPolicy(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<
  ReturnType<typeof import("@proovra/shared").resolveRedactionPolicy>
> {
  const { DEFAULT_REDACTION_POLICY, resolveRedactionPolicy } = await import(
    "@proovra/shared"
  );
  try {
    const row = await client.workspaceGovernancePolicy.findUnique({
      where: { teamId },
      select: { metadataRedactionDefault: true },
    });
    if (!row || !row.metadataRedactionDefault) {
      return DEFAULT_REDACTION_POLICY;
    }
    const override = row.metadataRedactionDefault as Parameters<
      typeof resolveRedactionPolicy
    >[0];
    return resolveRedactionPolicy(override);
  } catch {
    return DEFAULT_REDACTION_POLICY;
  }
}

export async function evidenceIsReviewed(
  evidenceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const wf = await client.evidenceReviewWorkflow.findUnique({
    where: { evidenceId },
    select: { status: true },
  });
  if (!wf) return false;
  return reviewStatusSatisfiesGovernanceGate(wf.status);
}

// -----------------------------------------------------------------------------
// Fail-closed enforcement wrappers — used by destructive / export routes.
//
// Phase 9 used best-effort try/catch around governance checks ("fail
// open"). Phase 9.5 makes export/destructive paths fail closed: if
// policy or hold cannot be checked, the action is BLOCKED with a
// `GOVERNANCE_CHECK_FAILED` reason and the route emits the appropriate
// EXPORT_BLOCKED_BY_POLICY / DELETE_BLOCKED audit event.
//
// Read-only operations continue to fail open — they should never be
// blocked by a transient governance lookup failure.
// -----------------------------------------------------------------------------

export type SensitiveActionContext = {
  teamId: string | null;
  role: DbTeamRole | null | undefined;
  evidence: Pick<DbEvidence, "id" | "teamId" | "retentionUntilUtc">;
  reviewState?: { isReviewed: boolean } | null;
};

export type SensitiveAction =
  | "delete_evidence"
  | "archive_evidence"
  | "generate_report"
  | "generate_package"
  | "download_report"
  | "download_package"
  | "download_original"
  | "publish_public_verify";

export type EnforcementResult =
  | { allowed: true }
  | { allowed: false; code: string; reason: string };

export async function enforceSensitiveAction(
  action: SensitiveAction,
  ctx: SensitiveActionContext,
  client: PrismaClient = defaultPrisma,
): Promise<EnforcementResult> {
  if (!ctx.teamId) {
    // Personal-scope evidence — Phase 9.5 governance applies only at the
    // workspace level. Allow.
    return { allowed: true };
  }

  let policy: EffectivePolicy;
  try {
    policy = await loadWorkspaceGovernancePolicy(ctx.teamId, client);
  } catch (err) {
    // Fail closed on export / destructive actions. Read-only actions are
    // not routed through this function.
    return {
      allowed: false,
      code: "GOVERNANCE_CHECK_FAILED",
      reason:
        err instanceof Error
          ? `policy_lookup_failed:${err.message.slice(0, 120)}`
          : "policy_lookup_failed",
    };
  }

  try {
    switch (action) {
      case "delete_evidence": {
        const decision = await canDeleteEvidence({
          role: ctx.role,
          evidence: ctx.evidence,
          policy,
          client,
        });
        return decision.allowed
          ? { allowed: true }
          : {
              allowed: false,
              code: deletionDecisionToCode(decision.reason),
              reason: decision.reason,
            };
      }
      case "archive_evidence": {
        const decision = await canArchiveEvidence({
          role: ctx.role,
          evidence: ctx.evidence,
          policy,
          client,
        });
        return decision.allowed
          ? { allowed: true }
          : {
              allowed: false,
              code: "ARCHIVE_BLOCKED_BY_LEGAL_HOLD",
              reason: decision.reason,
            };
      }
      case "generate_report": {
        const decision = canGenerateReport({
          role: ctx.role,
          policy,
          reviewState: ctx.reviewState,
        });
        return decision.allowed
          ? { allowed: true }
          : {
              allowed: false,
              code: "REPORT_BLOCKED_BY_POLICY",
              reason: decision.reason,
            };
      }
      case "download_report": {
        // Download is gated by the same `allowReportDownload` flag as
        // generation; the review gate doesn't apply to a download
        // because the report only exists if generation was permitted.
        if (!policy.allowReportDownload) {
          return {
            allowed: false,
            code: "REPORT_BLOCKED_BY_POLICY",
            reason: "report_disabled_by_policy",
          };
        }
        const perm = requirePermission(ctx.role, "evidence.download_report");
        if (!perm.allowed) {
          return {
            allowed: false,
            code: "REPORT_BLOCKED_BY_POLICY",
            reason: perm.reason,
          };
        }
        return { allowed: true };
      }
      case "generate_package": {
        const decision = canGeneratePackage({
          role: ctx.role,
          policy,
          reviewState: ctx.reviewState,
        });
        return decision.allowed
          ? { allowed: true }
          : {
              allowed: false,
              code: "PACKAGE_BLOCKED_BY_POLICY",
              reason: decision.reason,
            };
      }
      case "download_package": {
        const decision = canDownloadPackage({ role: ctx.role, policy });
        return decision.allowed
          ? { allowed: true }
          : {
              allowed: false,
              code: "PACKAGE_BLOCKED_BY_POLICY",
              reason: decision.reason,
            };
      }
      case "download_original": {
        if (!policy.allowOriginalDownload) {
          return {
            allowed: false,
            code: "ORIGINAL_DOWNLOAD_BLOCKED_BY_POLICY",
            reason: "original_download_disabled_by_policy",
          };
        }
        const perm = requirePermission(ctx.role, "evidence.download_original");
        if (!perm.allowed) {
          return {
            allowed: false,
            code: "ORIGINAL_DOWNLOAD_BLOCKED_BY_POLICY",
            reason: perm.reason,
          };
        }
        // Legal hold does NOT block original downloads — a hold preserves
        // the record, it does not seal it from authorized review. The
        // existing storage object-lock fields handle physical immutability.
        return { allowed: true };
      }
      case "publish_public_verify": {
        const decision = canPublishPublicVerify({
          role: ctx.role,
          policy,
          reviewState: ctx.reviewState,
        });
        return decision.allowed
          ? { allowed: true }
          : {
              allowed: false,
              code: "PUBLIC_VERIFY_BLOCKED_BY_POLICY",
              reason: decision.reason,
            };
      }
    }
  } catch (err) {
    return {
      allowed: false,
      code: "GOVERNANCE_CHECK_FAILED",
      reason:
        err instanceof Error
          ? `decision_failed:${err.message.slice(0, 120)}`
          : "decision_failed",
    };
  }
}

function deletionDecisionToCode(reason: string): string {
  if (reason === "blocked_by_legal_hold") return "DELETE_BLOCKED_BY_LEGAL_HOLD";
  if (reason === "blocked_by_retention") return "DELETE_BLOCKED_BY_RETENTION";
  if (reason === "deletion_disabled_by_policy") return "DELETE_BLOCKED_BY_POLICY";
  if (reason === "deletion_restricted_to_admin") return "DELETE_RESTRICTED_TO_ADMIN";
  return "DELETE_BLOCKED";
}

// -----------------------------------------------------------------------------
// Retention application — called at evidence-create time.
//
// If the workspace policy specifies `defaultRetentionDays`, compute the
// resulting `retentionUntilUtc` and return it. Existing explicit retention
// (passed by the caller or pre-set on the evidence) is never SHORTENED;
// the longer of (explicit, policy-derived) wins.
//
// Returns null when no policy retention applies. Caller writes the value
// onto the Evidence row.
// -----------------------------------------------------------------------------

export async function resolveRetentionOnCreate(input: {
  teamId: string | null | undefined;
  existingRetentionUntilUtc?: Date | null;
  now?: Date;
  client?: PrismaClient;
}): Promise<{ retentionUntilUtc: Date; source: "workspace_policy" } | null> {
  if (!input.teamId) return null;
  const client = input.client ?? defaultPrisma;
  let policy: EffectivePolicy;
  try {
    policy = await loadWorkspaceGovernancePolicy(input.teamId, client);
  } catch {
    return null; // create path is not destructive; degrade safely
  }
  if (!policy.defaultRetentionDays || policy.defaultRetentionDays <= 0) {
    return null;
  }
  const now = input.now ?? new Date();
  const policyRetention = new Date(
    now.getTime() + policy.defaultRetentionDays * 24 * 3600 * 1000,
  );
  if (
    input.existingRetentionUntilUtc &&
    input.existingRetentionUntilUtc.getTime() >= policyRetention.getTime()
  ) {
    // Existing explicit retention is at least as long — keep it.
    return null;
  }
  return { retentionUntilUtc: policyRetention, source: "workspace_policy" };
}

export async function applyRetentionPolicyOnCreate(input: {
  evidenceId: string;
  teamId: string | null | undefined;
  existingRetentionUntilUtc?: Date | null;
  client?: PrismaClient;
}): Promise<{ applied: boolean; retentionUntilUtc: Date | null }> {
  const client = input.client ?? defaultPrisma;
  const resolved = await resolveRetentionOnCreate({
    teamId: input.teamId,
    existingRetentionUntilUtc: input.existingRetentionUntilUtc,
    client,
  });
  if (!resolved) return { applied: false, retentionUntilUtc: null };

  await client.evidence.update({
    where: { id: input.evidenceId },
    data: { retentionUntilUtc: resolved.retentionUntilUtc },
  });

  // No new custody event type for retention application — we reuse
  // the existing chain via a dedicated payload tag. The chain hashes
  // the payload, so reviewers can still inspect "retention applied by
  // policy" in the timeline.
  try {
    await appendCustodyEvent({
      evidenceId: input.evidenceId,
      eventType: prismaPkg.CustodyEventType.EVIDENCE_CREATED,
      payload: {
        retentionPolicyApplied: true,
        retentionUntilUtc: resolved.retentionUntilUtc.toISOString(),
        source: resolved.source,
      },
    });
  } catch {
    /* observability-only */
  }

  return { applied: true, retentionUntilUtc: resolved.retentionUntilUtc };
}

// -----------------------------------------------------------------------------
// emitPolicyBlockedEvent — helper for routes that need to record a
// blocked attempt into the custody chain.
// -----------------------------------------------------------------------------

export async function emitPolicyBlockedEvent(input: {
  evidenceId: string;
  action: string;
  reason: string;
  actorUserId?: string | null;
}): Promise<void> {
  try {
    await appendCustodyEvent({
      evidenceId: input.evidenceId,
      eventType: prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY,
      payload: {
        action: input.action,
        reason: input.reason,
        actorUserId: input.actorUserId ?? null,
      },
    });
  } catch {
    /* observability-only — never block the operator's response */
  }
  // Phase 10 — surface the blocked attempt to integration subscribers.
  // Look up the evidence's workspace; never emit when unknown.
  try {
    const ev = await defaultPrisma.evidence.findUnique({
      where: { id: input.evidenceId },
      select: { id: true, teamId: true },
    });
    if (ev && ev.teamId) {
      await emitWebhookEvent({
        teamId: ev.teamId,
        eventType: "governance.export_blocked",
        payload: {
          evidenceId: ev.id,
          action: input.action,
          reason: input.reason,
          // Deliberately NOT projected: actorUserId.
        },
        attemptInline: false,
      });
    }
  } catch {
    /* never break the caller on webhook emission */
  }
}

// -----------------------------------------------------------------------------
// Public projection — internal-only fields only.
// -----------------------------------------------------------------------------

export function projectEffectivePolicy(policy: EffectivePolicy): EffectivePolicy {
  // Currently the same shape; placeholder for future redaction.
  return policy;
}

export function projectLegalHold(hold: DbLegalHold): {
  id: string;
  teamId: string;
  evidenceId: string;
  caseId: string | null;
  title: string;
  reason: string | null;
  status: string;
  placedByUserId: string;
  placedAtUtc: string;
  releasedByUserId: string | null;
  releasedAtUtc: string | null;
  releaseNote: string | null;
} {
  return {
    id: hold.id,
    teamId: hold.teamId,
    evidenceId: hold.evidenceId,
    caseId: hold.caseId,
    title: hold.title,
    reason: hold.reason,
    status: hold.status,
    placedByUserId: hold.placedByUserId,
    placedAtUtc: hold.placedAtUtc.toISOString(),
    releasedByUserId: hold.releasedByUserId,
    releasedAtUtc: hold.releasedAtUtc?.toISOString() ?? null,
    releaseNote: hold.releaseNote,
  };
}
