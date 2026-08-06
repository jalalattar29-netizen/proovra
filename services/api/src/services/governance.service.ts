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
import { evaluateEffectiveLegalHold } from "./governance/effective-legal-hold.js";
import {
  LegalHoldError,
  placeCanonicalLegalHold,
  releaseCanonicalLegalHold,
} from "./governance/legal-hold.service.js";
import { emitWebhookEvent } from "./integrations/webhook-dispatcher.js";

// -----------------------------------------------------------------------------
// Default policy
// -----------------------------------------------------------------------------

/**
 * PHASE 12B CLUSTER 9 — `version` is deliberately EXCLUDED from the effective
 * policy shape. It is concurrency metadata, not a governance decision: the
 * dozens of enforcement call sites that consume `EffectivePolicy` must never
 * be able to branch on it, and the wire contract carries it as a sibling of
 * `policy`, not a member of it. A workspace with no row at all reports
 * `POLICY_VERSION_ABSENT` (0) — see `loadWorkspaceGovernancePolicyVersion`.
 */
export const DEFAULT_POLICY: Readonly<
  Omit<DbPolicy, "id" | "teamId" | "updatedByUserId" | "createdAt" | "updatedAt" | "metadataRedactionDefault" | "version">
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

export type GovernancePolicyPatch = Partial<{
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

export type UpdateGovernancePolicyInput = {
  teamId: string;
  actorUserId: string;
  patch: GovernancePolicyPatch;
  /**
   * The version the caller believes it is editing.
   * `POLICY_VERSION_ABSENT` (0) means "I saw no policy row" — the write is then
   * an INSERT whose uniqueness constraint on `team_id` is the concurrency guard.
   */
  expectedVersion: number;
};

/**
 * PHASE 12B CLUSTER 9 — the version reported for a workspace that has NO
 * policy row. A caller that read `0` and then submits `expectedVersion: 0` is
 * asserting "no policy existed when I looked"; if a row appeared in the
 * meantime the INSERT loses on the unique index and the caller gets a 409.
 */
export const POLICY_VERSION_ABSENT = 0;

export class GovernancePolicyVersionConflictError extends Error {
  readonly code = "POLICY_VERSION_CONFLICT" as const;
  readonly statusCode = 409 as const;
  readonly expectedVersion: number;
  readonly currentVersion: number | null;

  constructor(expectedVersion: number, currentVersion: number | null) {
    super("Workspace governance policy changed since it was read.");
    this.name = "GovernancePolicyVersionConflictError";
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
}

/**
 * Read ONLY the concurrency version of the workspace policy row.
 * Returns `POLICY_VERSION_ABSENT` when the workspace has no row (which is a
 * legitimate steady state — absence means `DEFAULT_POLICY`).
 */
export async function loadWorkspaceGovernancePolicyVersion(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<number> {
  const row = await client.workspaceGovernancePolicy.findUnique({
    where: { teamId },
    select: { version: true },
  });
  return row?.version ?? POLICY_VERSION_ABSENT;
}

/** Names (never values) of the fields this patch actually writes. */
export function changedGovernancePolicyFields(
  patch: GovernancePolicyPatch,
): string[] {
  return Object.entries(patch)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k)
    .sort();
}

/**
 * PHASE 12B CLUSTER 9 — the ONE versioned writer for
 * `WorkspaceGovernancePolicy`.
 *
 * The predecessor (`upsertWorkspaceGovernancePolicy`) was an unconditional
 * upsert. Two administrators editing the deletion mode and the legal-hold
 * approval gate at the same time both received 200 and the second silently
 * erased the first — a governance control reverting with no trace. That is the
 * race this function closes, and it closes it in the DATABASE, not in a
 * read-then-compare in application memory:
 *
 *   * existing row → `updateMany` predicated on BOTH `teamId` AND
 *     `version: expectedVersion`, incrementing `version` in the same
 *     statement. `count === 0` means somebody else moved the row: throw,
 *     having written nothing.
 *   * no row → `create`. The unique index on `team_id` is the guard; a
 *     concurrent creator makes this throw P2002, which is the same conflict.
 *
 * There is deliberately NO fallback that writes without the precondition.
 */
export async function updateWorkspaceGovernancePolicyWithVersion(
  input: UpdateGovernancePolicyInput,
  client: PrismaClient = defaultPrisma,
): Promise<{
  row: DbPolicy;
  previousVersion: number;
  newVersion: number;
  changedFields: string[];
}> {
  const changedFields = changedGovernancePolicyFields(input.patch);

  if (input.expectedVersion === POLICY_VERSION_ABSENT) {
    try {
      const row = await client.workspaceGovernancePolicy.create({
        data: {
          teamId: input.teamId,
          updatedByUserId: input.actorUserId,
          version: 1,
          ...input.patch,
        },
      });
      return {
        row,
        previousVersion: POLICY_VERSION_ABSENT,
        newVersion: row.version,
        changedFields,
      };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        // A row appeared between the caller's read and this write. The
        // caller's view of "no policy" is stale — nothing was mutated.
        throw new GovernancePolicyVersionConflictError(
          input.expectedVersion,
          await loadWorkspaceGovernancePolicyVersion(input.teamId, client),
        );
      }
      throw err;
    }
  }

  const written = await client.workspaceGovernancePolicy.updateMany({
    where: { teamId: input.teamId, version: input.expectedVersion },
    data: {
      ...input.patch,
      updatedByUserId: input.actorUserId,
      version: { increment: 1 },
    },
  });
  if (written.count === 0) {
    throw new GovernancePolicyVersionConflictError(
      input.expectedVersion,
      await loadWorkspaceGovernancePolicyVersion(input.teamId, client),
    );
  }

  const row = await client.workspaceGovernancePolicy.findUniqueOrThrow({
    where: { teamId: input.teamId },
  });
  return {
    row,
    previousVersion: input.expectedVersion,
    newVersion: row.version,
    changedFields,
  };
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

/**
 * PHASE 12B CLUSTER 8 — delegates to THE effective-hold evaluator
 * (services/governance/effective-legal-hold.ts).
 *
 * This function used to hand-roll a partial union: it read
 * `evidence_legal_holds` + the scope-generic `legal_holds`, but NEVER read
 * `case_legal_holds`, and it swallowed EVERY error from the second half —
 * a transient database failure silently reported "no hold" on the direct
 * delete gate. Both defects are gone: the evaluator reads all three stores
 * and only degrades on a genuinely-absent relation.
 */
export async function isUnderActiveLegalHold(
  evidenceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const ev = await client.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      teamId: true,
      caseLinks: { select: { caseId: true }, take: 200 },
    },
  });

  const result = await evaluateEffectiveLegalHold(client, {
    teamId: ev?.teamId ?? null,
    evidenceId,
    caseIds: (ev?.caseLinks ?? []).map((l) => l.caseId),
  });
  return result.held;
}

export async function listLegalHoldsForEvidence(
  evidenceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<Array<DbLegalHold & { evidenceId: string }>> {
  const rows = await client.evidenceLegalHold.findMany({
    // Explicit target — an evidence id predicate can never match a
    // NULL-target CASE or WORKSPACE hold, but the scope filter states the
    // intent so a future refactor cannot widen it by accident.
    where: { evidenceId, scope: "EVIDENCE" },
    orderBy: { placedAtUtc: "desc" },
  });
  return rows.filter(
    (r): r is DbLegalHold & { evidenceId: string } =>
      typeof r.evidenceId === "string",
  );
}

// Phase 32.7.3 — explicit `select` clause to bound the query
// surface to columns the projection actually uses. Without this,
// Prisma's default-select pulls every declared field of
// `EvidenceLegalHold`, and the entire query P2022s if ANY column is
// missing in production (even columns the route doesn't return).
//
// Production reality (per Phase 32.7.3 brief): the runtime schema
// validator only confirms TABLE existence, not COLUMN existence.
// `evidence_legal_holds` exists in production with the bounded set
// of columns confirmed by operator inspection. The columns
// projected here are a strict subset of that confirmed set — they
// are the same columns `projectLegalHold` consumes.
const LEGAL_HOLD_SELECT = {
  id: true,
  teamId: true,
  evidenceId: true,
  caseId: true,
  title: true,
  reason: true,
  status: true,
  placedByUserId: true,
  placedAtUtc: true,
  releasedByUserId: true,
  releasedAtUtc: true,
  releaseNote: true,
} as const;

export type LegalHoldProjection = Pick<
  DbLegalHold,
  keyof typeof LEGAL_HOLD_SELECT
>;

/**
 * PHASE 12B CLUSTER 8 — `evidence_legal_holds.evidence_id` became NULLABLE
 * when the table absorbed CASE and WORKSPACE scoped holds. Every reader in
 * THIS module is an EVIDENCE-scope reader, so each query below is now
 * EXPLICIT about scope (`scope: "EVIDENCE"` + `evidenceId: { not: null }`).
 *
 * That explicitness matters twice over: a nullable target must never widen a
 * hold lookup into "matches everything", and an evidence surface must never
 * render a workspace hold as if it named a record.
 */
export type EvidenceScopedLegalHoldProjection = LegalHoldProjection & {
  evidenceId: string;
};

function isEvidenceScoped(
  hold: LegalHoldProjection,
): hold is EvidenceScopedLegalHoldProjection {
  return typeof hold.evidenceId === "string" && hold.evidenceId.length > 0;
}

export async function listLegalHoldsForTeam(
  input: {
    teamId: string;
    status?: prismaPkg.LegalHoldStatus;
    limit?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<EvidenceScopedLegalHoldProjection[]> {
  const rows = await client.evidenceLegalHold.findMany({
    where: {
      teamId: input.teamId,
      scope: "EVIDENCE",
      evidenceId: { not: null },
      historical: false,
      ...(input.status ? { status: input.status } : {}),
    },
    orderBy: { placedAtUtc: "desc" },
    take: Math.min(Math.max(input.limit ?? 100, 1), 500),
    select: LEGAL_HOLD_SELECT,
  });
  return rows.filter(isEvidenceScoped);
}

export type PlaceLegalHoldInput = {
  teamId: string;
  evidenceId: string;
  actorUserId: string;
  title: string;
  reason?: string | null;
  caseId?: string | null;
};

/**
 * PHASE 12B CLUSTER 8 — thin adapter over the ONE placement command
 * (services/governance/legal-hold.service.ts). The workspace check, the
 * custody event and the webhook fan-out all still happen — they now happen
 * once, in the canonical service, for every scope. Only the legacy error
 * codes are preserved here so existing callers keep their contract.
 */
export async function placeLegalHold(
  input: PlaceLegalHoldInput,
  client: PrismaClient = defaultPrisma,
): Promise<EvidenceScopedLegalHoldProjection> {
  try {
    const hold = await placeCanonicalLegalHold(
      {
        teamId: input.teamId,
        scope: "EVIDENCE",
        evidenceId: input.evidenceId,
        actorUserId: input.actorUserId,
        title: input.title,
        reason: input.reason ?? null,
      },
      client,
    );
    return {
      id: hold.id,
      teamId: hold.teamId,
      evidenceId: hold.evidenceId ?? input.evidenceId,
      caseId: input.caseId ?? hold.caseId,
      title: hold.title,
      reason: hold.reason,
      status: hold.status as prismaPkg.LegalHoldStatus,
      placedByUserId: hold.placedByUserId,
      placedAtUtc: hold.placedAtUtc,
      releasedByUserId: hold.releasedByUserId,
      releasedAtUtc: hold.releasedAtUtc,
      releaseNote: hold.releaseNote,
    };
  } catch (err) {
    if (err instanceof LegalHoldError) {
      throw Object.assign(new Error("evidence_not_in_workspace"), {
        statusCode: err.statusCode,
        code:
          err.code === "target_not_in_workspace" ||
          err.code === "scope_target_required"
            ? "evidence_not_found"
            : err.code,
      });
    }
    throw err;
  }
}

export type ReleaseLegalHoldInput = {
  id: string;
  teamId: string;
  actorUserId: string;
  releaseNote: string;
  /** CLUSTER 8 — optimistic concurrency; a stale value is a 409. */
  expectedVersion?: number | null;
  /** CLUSTER 8 — operator confirmation when the approval gate is armed. */
  approvalAcknowledged?: boolean;
};

/**
 * PHASE 12B CLUSTER 8 — thin adapter over the ONE release command. The
 * release-approval policy gate and the optimistic-concurrency check now
 * apply here too: this route previously enforced NEITHER, so an evidence
 * hold placed under `requireLegalHoldReleaseApproval` could be released
 * without the approval its case-scoped sibling demanded.
 */
export async function releaseLegalHold(
  input: ReleaseLegalHoldInput,
  client: PrismaClient = defaultPrisma,
): Promise<EvidenceScopedLegalHoldProjection> {
  try {
    const released = await releaseCanonicalLegalHold(
      {
        teamId: input.teamId,
        holdId: input.id,
        actorUserId: input.actorUserId,
        releaseNote: input.releaseNote,
        expectedVersion: input.expectedVersion ?? null,
        approvalAcknowledged: input.approvalAcknowledged === true,
      },
      client,
    );
    return {
      id: released.id,
      teamId: released.teamId,
      evidenceId: released.evidenceId ?? "",
      caseId: released.caseId,
      title: released.title,
      reason: released.reason,
      status: released.status as prismaPkg.LegalHoldStatus,
      placedByUserId: released.placedByUserId,
      placedAtUtc: released.placedAtUtc,
      releasedByUserId: released.releasedByUserId,
      releasedAtUtc: released.releasedAtUtc,
      releaseNote: released.releaseNote,
    };
  } catch (err) {
    if (err instanceof LegalHoldError) {
      throw Object.assign(new Error(err.code), {
        statusCode: err.statusCode,
        code: err.code === "hold_not_found" ? "legal_hold_not_found" : err.code,
      });
    }
    throw err;
  }
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
  /**
   * Phase 5 — opt-in: consult the workflow template `exportPolicyJson`
   * AFTER the workspace decision has already returned `allowed: true`.
   *
   * When true, the enforcer resolves the workflow template UUID for
   * `evidence.id` via the existing
   * `resolveTemplateIdForEvidence` join helper, loads the template's
   * exportPolicy, and applies it as a tightening overlay on top of the
   * workspace decision. The overlay can ONLY restrict an
   * already-allowed action — it can never enable a workspace-denied
   * action.
   *
   * Fail-safe end-to-end: if template id resolution or policy load
   * throws, the workspace decision stands. A template-resolution
   * failure must NEVER block an action workspace policy already
   * allowed.
   *
   * Default false: omitting this preserves pre-Phase-5 behavior bit-
   * for-bit.
   */
  consultTemplatePolicy?: boolean;
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

  let workspaceDecision: EnforcementResult;
  try {
    workspaceDecision = await evaluateWorkspaceSensitiveAction(
      action,
      ctx,
      policy,
      client,
    );
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

  if (!workspaceDecision.allowed) return workspaceDecision;

  // Phase 5 — workflow template `exportPolicyJson` overlay. This block
  // can ONLY flip an already-ALLOWED workspace decision to a denial;
  // it can never enable an action workspace policy disallowed.
  //
  // The overlay is opt-in via `ctx.consultTemplatePolicy`. Callers
  // opt in for the four "export-shaped" actions; routes that don't
  // care (or are downstream of a non-template-bound capture) don't
  // opt in and behavior is identical to today.
  //
  // The whole block is wrapped in try/catch: a template-resolution
  // failure or an overlay-evaluation failure must NEVER break the
  // primary export lifecycle. We fall back to the workspace decision
  // (which already returned allowed).
  if (ctx.consultTemplatePolicy && isTemplateExportAction(action)) {
    try {
      const { resolveTemplateIdForEvidence } = await import(
        "./reviewer-ops/reviewer-operations-engine.service.js"
      );
      const { loadTemplateExportPolicy, evaluateTemplateExportOverlay } =
        await import("./governance/template-export-policy.service.js");
      const resolved = await resolveTemplateIdForEvidence(
        ctx.evidence.id,
        client,
      );
      if (resolved.templateId) {
        const templatePolicy = await loadTemplateExportPolicy(
          resolved.templateId,
          client,
        );
        const overlay = evaluateTemplateExportOverlay({
          action,
          role: (ctx.role ?? null) as
            | import("@proovra/shared").WorkflowWorkspaceRole
            | null,
          policy: templatePolicy,
        });
        if (!overlay.allowed) {
          return overlay;
        }
      }
    } catch {
      // Fail-safe: any failure in the overlay path falls through to
      // the workspace decision (which already returned allowed).
    }
  }

  return workspaceDecision;
}

// -----------------------------------------------------------------------------
// Workspace-policy decision — the original Phase 9.5 logic, extracted so
// the enforcer can layer the Phase 5 template overlay on top without
// touching the per-action rules.
// -----------------------------------------------------------------------------

async function evaluateWorkspaceSensitiveAction(
  action: SensitiveAction,
  ctx: SensitiveActionContext,
  policy: EffectivePolicy,
  client: PrismaClient,
): Promise<EnforcementResult> {
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
}

function isTemplateExportAction(
  action: SensitiveAction,
): action is
  | "generate_report"
  | "download_report"
  | "generate_package"
  | "download_package"
  | "publish_public_verify" {
  return (
    action === "generate_report" ||
    action === "download_report" ||
    action === "generate_package" ||
    action === "download_package" ||
    action === "publish_public_verify"
  );
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

  // Phase 6 — Resolve template-identity trio for audit traceability.
  // Identity-only; never drives the retention decision (which has
  // already been resolved above). Wrapped in try/catch — a
  // propagation failure must NEVER break the retention application
  // lifecycle. Legacy rows surface NULL members.
  let templateProvenance: {
    templateSlug: string | null;
    templateVersion: number | null;
    templateDbId: string | null;
  } = { templateSlug: null, templateVersion: null, templateDbId: null };
  try {
    const ev = await client.evidence.findUnique({
      where: { id: input.evidenceId },
      select: {
        templateSlug: true,
        templateVersion: true,
        templateDbId: true,
      },
    });
    if (ev) {
      templateProvenance = {
        templateSlug: ev.templateSlug ?? null,
        templateVersion: ev.templateVersion ?? null,
        templateDbId: ev.templateDbId ?? null,
      };
    }
  } catch {
    /* identity propagation must never break retention application */
  }

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
        // Phase 6 — template provenance trio for downstream
        // traceability. Identity-only; never drives policy.
        templateSlug: templateProvenance.templateSlug,
        templateVersion: templateProvenance.templateVersion,
        templateDbId: templateProvenance.templateDbId,
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

// Phase 32.7.3 — accept the bounded projection type so callers
// using the explicit `select` clause in `listLegalHoldsForTeam`
// type-check correctly. Existing callers that pass a full
// `DbLegalHold` continue to work (it's a superset).
// PHASE 12B CLUSTER 8 — narrowed to the EVIDENCE-scoped projection. This
// projector is the wire shape of /v1/governance/legal-holds, which is an
// evidence-hold surface; accepting a nullable target here would let a CASE or
// WORKSPACE hold be rendered as though it named a record.
export function projectLegalHold(hold: EvidenceScopedLegalHoldProjection): {
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
