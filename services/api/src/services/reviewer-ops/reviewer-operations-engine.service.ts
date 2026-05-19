/**
 * Phase 25 — Reviewer Operations Engine.
 *
 * Single orchestrator on top of the Phase 13 review-operations service
 * (assignment, decision, SLA), the Phase 25 escalation engine, and the
 * Phase 25 workload service. The route layer talks to this file ONLY.
 *
 * Hard rules:
 *   - Deterministic; no auto-assignment.
 *   - Every mutation logs an audit event + bumps a metric.
 *   - Lifecycle transitions go through the shared matrix
 *     (`isAllowedLifecycleTransition`) AND the underlying Phase 13
 *     stage matrix; invalid transitions surface `REVIEW_INVALID_TRANSITION`.
 *   - Reviewer-only actions: service accounts and contributors are
 *     blocked. The route layer pre-checks permissions; the engine
 *     re-checks at the service boundary as a fail-closed safety net.
 *   - No private reviewer note content ever leaves the projection.
 */

import type { PrismaClient, EvidenceReviewWorkflow as DbWorkflow } from "@prisma/client";
import {
  REVIEWER_OPS_DEFAULT_SLA_POLICY,
  computeReviewerOpsSlaSnapshot,
  deriveLifecycleState,
  isAllowedLifecycleTransition,
  mapDbStatusToReviewStage,
  rollupReviewerOpsSlaState,
  stringContainsForbiddenOverclaim,
  type ReviewSlaDimensionSnapshot,
  type ReviewerOpsLifecycleState,
  type ReviewerOpsQueueType,
  type ReviewerOpsSlaState,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump, setGauge } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { recordIncident } from "../observability/incident.service.js";
import {
  assignReviewer as legacyAssignReviewer,
  bulkReviewAction as legacyBulkReviewAction,
  claimReviewerWorkflow as legacyClaimReviewerWorkflow,
  ensureReviewWorkflow,
  getReviewQueueCounts as legacyGetReviewQueueCounts,
  listReviewQueue as legacyListReviewQueue,
  projectReviewWorkflow as legacyProjectReviewWorkflow,
  reconcileReviewSlas as legacyReconcileReviewSlas,
  recordReviewDecision as legacyRecordReviewDecision,
  updateReviewSla as legacyUpdateReviewSla,
} from "../review-operations/review-operations.service.js";
import {
  createEscalation,
  findOpenEscalationForWorkflow,
  type EscalationProjection,
} from "./escalation-engine.service.js";
import {
  snapshotWorkspaceWorkload,
  suggestReviewers,
  listLatestWorkloadSnapshots,
  type ReviewerSuggestion,
  type WorkloadDashboardRow,
} from "./workload.service.js";
import {
  loadWorkspaceReviewerOpsFlags,
  resolveEffectiveSlaPolicy,
} from "./sla-policy.service.js";
import {
  sweepDueSoonReminders,
  sweepInactivityReminders,
} from "./reminder-engine.service.js";
import {
  detectStuckWorkflow,
  type StuckClassification,
  type WorkflowReviewStatus,
  type WorkflowSlaStatus,
} from "@proovra/shared";

// -----------------------------------------------------------------------------
// Error
// -----------------------------------------------------------------------------

export class ReviewerOpsError extends Error {
  constructor(
    public readonly code:
      | "REVIEW_INVALID_TRANSITION"
      | "REVIEW_SLA_BREACHED"
      | "REVIEW_GOVERNANCE_BLOCKED"
      | "REVIEW_STEP_UP_REQUIRED"
      | "REVIEW_ESCALATION_EXISTS"
      | "REVIEW_PERMISSION_DENIED"
      | "REVIEW_NOTE_REQUIRED"
      | "REVIEW_WORKFLOW_NOT_FOUND"
      | "REVIEW_ACTOR_BLOCKED",
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "ReviewerOpsError";
  }
}

// -----------------------------------------------------------------------------
// SLA policy resolution
// -----------------------------------------------------------------------------

function resolveSlaPolicy() {
  // Phase 25 env-tunable defaults. We read at call time so test
  // harnesses can override per-test. Fallback to shared defaults.
  const env = process.env;
  const parse = (key: string, fallback: number) => {
    const raw = env[key];
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    assignmentHours: parse(
      "REVIEW_SLA_ASSIGNMENT_HOURS",
      REVIEWER_OPS_DEFAULT_SLA_POLICY.assignmentHours,
    ),
    firstReviewHours: parse(
      "REVIEW_SLA_FIRST_REVIEW_HOURS",
      REVIEWER_OPS_DEFAULT_SLA_POLICY.firstReviewHours,
    ),
    completionHours: parse(
      "REVIEW_SLA_COMPLETION_HOURS",
      REVIEWER_OPS_DEFAULT_SLA_POLICY.completionHours,
    ),
    escalationHours: parse(
      "REVIEW_SLA_ESCALATION_HOURS",
      REVIEWER_OPS_DEFAULT_SLA_POLICY.escalationHours,
    ),
    dueSoonHours: parse(
      "REVIEW_SLA_DUE_SOON_HOURS",
      REVIEWER_OPS_DEFAULT_SLA_POLICY.dueSoonHours,
    ),
  };
}

// -----------------------------------------------------------------------------
// Projection — Phase 25 enriched workflow projection.
// -----------------------------------------------------------------------------

export type ReviewerOpsWorkflowProjection = {
  workflowId: string;
  evidenceId: string;
  teamId: string | null;
  lifecycleState: ReviewerOpsLifecycleState;
  assignedToUserId: string | null;
  assignedAtUtc: string | null;
  priority: string;
  slaRollupState: ReviewerOpsSlaState;
  slaDimensions: ReadonlyArray<ReviewSlaDimensionSnapshot>;
  legacy: ReturnType<typeof legacyProjectReviewWorkflow>;
};

export function buildWorkflowProjection(
  row: DbWorkflow,
  opts?: { hasOpenEscalation?: boolean; nowUtc?: Date },
): ReviewerOpsWorkflowProjection {
  const stage = mapDbStatusToReviewStage(row.status as string);
  const lifecycleState = deriveLifecycleState(
    stage,
    Boolean(opts?.hasOpenEscalation),
  );
  const snapshots = computeReviewerOpsSlaSnapshot({
    nowUtc: opts?.nowUtc,
    paused: Boolean(row.slaPausedAtUtc),
    hasOpenEscalation: Boolean(opts?.hasOpenEscalation),
    assignmentDueAtUtc: row.assignmentDueAtUtc ?? null,
    assignedAtUtc: row.assignedAtUtc ?? null,
    firstReviewDueAtUtc: row.firstResponseDueAtUtc ?? row.dueAt ?? null,
    firstReviewedAtUtc: row.lastReviewedAt ?? null,
    completionDueAtUtc: row.completionDueAtUtc ?? null,
    completedAtUtc: row.completedAtUtc ?? null,
    escalationDueAtUtc: row.escalationDueAtUtc ?? null,
    escalationResolvedAtUtc: null,
    dueSoonMinutes: resolveSlaPolicy().dueSoonHours * 60,
  });
  return {
    workflowId: row.id,
    evidenceId: row.evidenceId,
    teamId: row.teamId,
    lifecycleState,
    assignedToUserId: row.assignedToUserId,
    assignedAtUtc: row.assignedAtUtc?.toISOString() ?? null,
    priority: row.priority,
    slaRollupState: rollupReviewerOpsSlaState(snapshots),
    slaDimensions: snapshots,
    legacy: legacyProjectReviewWorkflow(row),
  };
}

// -----------------------------------------------------------------------------
// Lifecycle transition gate
// -----------------------------------------------------------------------------

function assertLifecycleTransition(
  from: ReviewerOpsLifecycleState,
  to: ReviewerOpsLifecycleState,
): void {
  if (!isAllowedLifecycleTransition(from, to)) {
    bump("reviewer_invalid_transition_blocked_total");
    throw new ReviewerOpsError("REVIEW_INVALID_TRANSITION", { from, to });
  }
}

function assertNoteIfRequired(note: string | null | undefined): void {
  if (!note || note.trim().length === 0) {
    throw new ReviewerOpsError("REVIEW_NOTE_REQUIRED");
  }
  if (stringContainsForbiddenOverclaim(note)) {
    throw new ReviewerOpsError("REVIEW_PERMISSION_DENIED", {
      reason: "forbidden_wording",
    });
  }
}

// -----------------------------------------------------------------------------
// Queue (Phase 25 surface)
//
// We layer over the Phase 13 queue. Each queue type maps to a Prisma
// filter; for queue types the Phase 13 service can't already express,
// we build the filter here.
// -----------------------------------------------------------------------------

export type ReviewerOpsQueueRow = ReviewerOpsWorkflowProjection;

export type ReviewerOpsQueueInput = {
  teamId: string;
  meUserId: string;
  queue: ReviewerOpsQueueType;
  /** Bounded; route layer also bounds. */
  limit?: number;
  cursor?: string | null;
};

export async function listReviewerOpsQueue(
  input: ReviewerOpsQueueInput,
  client: PrismaClient = defaultPrisma,
): Promise<{
  rows: ReadonlyArray<ReviewerOpsQueueRow>;
  nextCursor: string | null;
}> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const baseWhere: Record<string, unknown> = { teamId: input.teamId };
  switch (input.queue) {
    case "MY_REVIEWS":
      baseWhere.assignedToUserId = input.meUserId;
      baseWhere.status = {
        notIn: ["CLOSED", "REJECTED_INSUFFICIENT", "APPROVED_INTERNAL"],
      };
      break;
    case "UNASSIGNED":
      baseWhere.assignedToUserId = null;
      baseWhere.status = {
        notIn: ["CLOSED", "REJECTED_INSUFFICIENT", "APPROVED_INTERNAL"],
      };
      break;
    case "OVERDUE":
      baseWhere.slaStatus = { in: ["OVERDUE", "BREACHED"] };
      break;
    case "DUE_SOON":
      baseWhere.slaStatus = "DUE_SOON";
      break;
    case "ESCALATED":
      baseWhere.OR = [
        { status: "ESCALATED" },
        { activeEscalationId: { not: null } },
      ];
      break;
    case "HIGH_PRIORITY":
      baseWhere.priority = { in: ["HIGH", "URGENT"] };
      break;
    case "WORKFLOW_BLOCKED":
      baseWhere.pausedReason = { not: null };
      break;
    case "LEGAL_HOLD":
      // Phase 14 legal-hold join: use the evidence relation; we cast
      // through the included filter shape.
      baseWhere.evidence = { legalHolds: { some: { status: "ACTIVE" } } };
      break;
    case "INTEGRITY_RISK":
      // Best-available proxy: escalations of reason VERIFICATION_MISMATCH
      // or INTEGRITY_RISK.
      baseWhere.activeEscalationId = { not: null };
      break;
    case "EXTERNAL_INTAKE":
      baseWhere.workspaceType = "EXTERNAL_INTAKE";
      break;
    case "COMPLETED_RECENTLY":
      baseWhere.completedAtUtc = {
        gte: new Date(Date.now() - 7 * 86400_000),
      };
      break;
  }
  const rows = await client.evidenceReviewWorkflow.findMany({
    where: baseWhere as never,
    orderBy: [
      { priority: "desc" },
      { dueAt: "asc" },
      { updatedAt: "desc" },
    ],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();

  // Single batch query for any open escalations.
  const workflowIds = rows.map((r) => r.id);
  const openEsc =
    workflowIds.length === 0
      ? []
      : await client.reviewEscalation.findMany({
          where: {
            teamId: input.teamId,
            workflowId: { in: workflowIds },
            status: { in: ["OPEN", "ACKNOWLEDGED", "REASSIGNED"] },
          },
          select: { workflowId: true },
        });
  const escSet = new Set(openEsc.map((e) => e.workflowId));

  const now = new Date();
  const projected = rows.map((r) =>
    buildWorkflowProjection(r, {
      hasOpenEscalation: escSet.has(r.id),
      nowUtc: now,
    }),
  );

  bump("reviewer_queue_viewed_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "reviewer_queue_viewed",
    severity: "INFO",
    details: {
      queue: input.queue,
      returned: projected.length,
      actorUserId: input.meUserId,
    },
  });

  return {
    rows: projected,
    nextCursor: hasMore && rows.length > 0 ? rows[rows.length - 1].id : null,
  };
}

// -----------------------------------------------------------------------------
// Dashboard projection
// -----------------------------------------------------------------------------

export type ReviewerOpsDashboard = {
  counts: Awaited<ReturnType<typeof legacyGetReviewQueueCounts>>;
  openEscalations: number;
  criticalEscalationsOpen: number;
  workloadTop: ReadonlyArray<WorkloadDashboardRow>;
  suggestions: ReadonlyArray<ReviewerSuggestion>;
};

export async function buildDashboard(
  input: { teamId: string; meUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewerOpsDashboard> {
  const [counts, openEsc, critEsc, workloadTop, suggestions] = await Promise.all(
    [
      legacyGetReviewQueueCounts(
        { teamId: input.teamId, meUserId: input.meUserId },
        client,
      ),
      client.reviewEscalation.count({
        where: {
          teamId: input.teamId,
          status: { in: ["OPEN", "ACKNOWLEDGED", "REASSIGNED"] },
        },
      }),
      client.reviewEscalation.count({
        where: {
          teamId: input.teamId,
          status: { in: ["OPEN", "ACKNOWLEDGED", "REASSIGNED"] },
          severity: "CRITICAL",
        },
      }),
      listLatestWorkloadSnapshots({ teamId: input.teamId, limit: 10 }, client),
      suggestReviewers({ teamId: input.teamId, topN: 5 }, client),
    ],
  );
  setGauge(
    "reviewer_queue_backlog_total",
    counts.unassigned + counts.overdue + counts.dueSoon,
  );
  setGauge("reviewer_queue_unassigned", counts.unassigned);
  setGauge("reviewer_queue_overdue", counts.overdue);
  setGauge("reviewer_queue_due_soon", counts.dueSoon);
  setGauge("reviewer_escalations_open", openEsc);
  setGauge("reviewer_escalations_critical_open", critEsc);
  return {
    counts,
    openEscalations: openEsc,
    criticalEscalationsOpen: critEsc,
    workloadTop,
    suggestions,
  };
}

// -----------------------------------------------------------------------------
// Workspace (single review)
// -----------------------------------------------------------------------------

export type ReviewerOpsWorkspaceProjection = {
  projection: ReviewerOpsWorkflowProjection;
  openEscalation: EscalationProjection | null;
  allowedLifecycleTransitions: ReadonlyArray<ReviewerOpsLifecycleState>;
};

export async function getReviewerOpsWorkspace(
  input: { teamId: string; workflowId: string },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewerOpsWorkspaceProjection> {
  const row = await client.evidenceReviewWorkflow.findFirst({
    where: { id: input.workflowId, teamId: input.teamId },
  });
  if (!row) throw new ReviewerOpsError("REVIEW_WORKFLOW_NOT_FOUND");
  const open = await findOpenEscalationForWorkflow(
    { teamId: input.teamId, workflowId: row.id },
    client,
  );
  const projection = buildWorkflowProjection(row, {
    hasOpenEscalation: !!open,
  });
  // Allowed transitions = the shared lifecycle matrix for the current
  // lifecycle state. The route layer enforces step-up where needed.
  const { listAllowedLifecycleTransitions } = await import("@proovra/shared");
  const allowed = listAllowedLifecycleTransitions(projection.lifecycleState);
  return {
    projection,
    openEscalation: open,
    allowedLifecycleTransitions: allowed,
  };
}

// -----------------------------------------------------------------------------
// Lifecycle actions — thin wrappers over the Phase 13 service.
//
// We re-derive the underlying ReviewStage transition and use the
// existing service so the canonical event + SLA + notification chain
// stays intact.
// -----------------------------------------------------------------------------

export type LifecycleActorContext = {
  teamId: string;
  actorUserId: string;
  /** Asserted by the route layer; the engine re-checks for safety. */
  isReviewerCapable: boolean;
  /** Asserted by the route layer; service accounts CANNOT approve / reject. */
  isServiceAccount: boolean;
};

function requireHuman(ctx: LifecycleActorContext): void {
  if (ctx.isServiceAccount) {
    bump("reviewer_invalid_transition_blocked_total");
    throw new ReviewerOpsError("REVIEW_ACTOR_BLOCKED", {
      reason: "service_account_blocked",
    });
  }
  if (!ctx.isReviewerCapable) {
    throw new ReviewerOpsError("REVIEW_PERMISSION_DENIED");
  }
}

async function loadWorkflowOrThrow(
  ctx: LifecycleActorContext,
  workflowId: string,
  client: PrismaClient,
): Promise<DbWorkflow> {
  const row = await client.evidenceReviewWorkflow.findFirst({
    where: { id: workflowId, teamId: ctx.teamId },
  });
  if (!row) throw new ReviewerOpsError("REVIEW_WORKFLOW_NOT_FOUND");
  return row;
}

async function currentLifecycle(
  ctx: LifecycleActorContext,
  row: DbWorkflow,
  client: PrismaClient,
): Promise<ReviewerOpsLifecycleState> {
  const open = await findOpenEscalationForWorkflow(
    { teamId: ctx.teamId, workflowId: row.id },
    client,
  );
  const stage = mapDbStatusToReviewStage(row.status as string);
  return deriveLifecycleState(stage, !!open);
}

// ----- assignReviewer ---------------------------------------------------------

export async function assignReviewerToWorkflow(
  ctx: LifecycleActorContext,
  input: { workflowId: string; assignedToUserId: string; note?: string | null },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewerOpsWorkflowProjection> {
  requireHuman(ctx);
  const row = await loadWorkflowOrThrow(ctx, input.workflowId, client);
  const fromLc = await currentLifecycle(ctx, row, client);
  // Assignment from QUEUED → ASSIGNED is the canonical path; from
  // ASSIGNED/IN_REVIEW it's a no-op for lifecycle (reassignment).
  if (
    fromLc === "QUEUED" ||
    fromLc === "SUBMITTED" ||
    fromLc === "ASSIGNED" ||
    fromLc === "IN_REVIEW" ||
    fromLc === "NEEDS_INFORMATION" ||
    fromLc === "ESCALATED"
  ) {
    // OK; reassignment is allowed across all live states.
  } else {
    throw new ReviewerOpsError("REVIEW_INVALID_TRANSITION", { fromLc });
  }
  const updated = await legacyAssignReviewer(
    {
      evidenceId: row.evidenceId,
      assignedToUserId: input.assignedToUserId,
      actorUserId: ctx.actorUserId,
      note: input.note ?? null,
    },
    client,
  );
  // Initialise assignmentDueAtUtc if not set. Phase 25.5 reads the
  // effective policy from template → workspace → env so per-team and
  // per-template overrides take effect at the moment of assignment.
  if (!updated.assignmentDueAtUtc) {
    const { policy } = await resolveEffectiveSlaPolicy(
      { teamId: ctx.teamId },
      client,
    );
    await client.evidenceReviewWorkflow.update({
      where: { id: updated.id },
      data: {
        assignmentDueAtUtc: new Date(
          Date.now() - 1000, // mark assigned-on-time; assignment SLA met by the assign action.
        ),
        completionDueAtUtc:
          updated.completionDueAtUtc ??
          new Date(Date.now() + policy.completionHours * 3600_000),
      },
    });
  }
  const isReassignment = !!row.assignedToUserId;
  bump(
    isReassignment
      ? "reviewer_reassigned_total"
      : "reviewer_assignment_created_total",
  );
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: isReassignment ? "reviewer_reassigned" : "reviewer_assignment_created",
    severity: "INFO",
    details: {
      workflowId: row.id,
      assignedToUserId: input.assignedToUserId,
      actorUserId: ctx.actorUserId,
    },
  });
  await appendPlatformAuditLog({
    userId: ctx.actorUserId,
    action: isReassignment ? "reviewer.reassign" : "reviewer.assign",
    category: "review",
    severity: "info",
    source: "reviewer_ops_engine",
    outcome: "success",
    resourceType: "review_workflow",
    resourceId: row.id,
    metadata: {
      teamId: ctx.teamId,
      newAssignee: input.assignedToUserId,
    },
    db: client,
  });
  return buildWorkflowProjection(updated, {
    hasOpenEscalation: await findOpenEscalationForWorkflow(
      { teamId: ctx.teamId, workflowId: row.id },
      client,
    ).then((e) => !!e),
  });
}

// ----- startReview ------------------------------------------------------------

export async function startReview(
  ctx: LifecycleActorContext,
  input: { workflowId: string },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewerOpsWorkflowProjection> {
  requireHuman(ctx);
  const row = await loadWorkflowOrThrow(ctx, input.workflowId, client);
  const fromLc = await currentLifecycle(ctx, row, client);
  assertLifecycleTransition(fromLc, "IN_REVIEW");
  if (row.assignedToUserId !== ctx.actorUserId) {
    throw new ReviewerOpsError("REVIEW_PERMISSION_DENIED", {
      reason: "actor_not_assignee",
    });
  }
  const now = new Date();
  const updated = await client.evidenceReviewWorkflow.update({
    where: { id: row.id },
    data: {
      status: "IN_REVIEW",
      lastReviewedAt: now,
    },
  });
  bump("reviewer_review_started_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "reviewer_review_started",
    severity: "INFO",
    details: { workflowId: row.id, actorUserId: ctx.actorUserId },
  });
  return buildWorkflowProjection(updated, {
    hasOpenEscalation: false,
  });
}

// ----- pauseReview ------------------------------------------------------------

export async function pauseReview(
  ctx: LifecycleActorContext,
  input: { workflowId: string; pausedReason: string },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewerOpsWorkflowProjection> {
  requireHuman(ctx);
  assertNoteIfRequired(input.pausedReason);
  const row = await loadWorkflowOrThrow(ctx, input.workflowId, client);
  const now = new Date();
  const updated = await client.evidenceReviewWorkflow.update({
    where: { id: row.id },
    data: {
      slaPausedAtUtc: now,
      pausedReason: input.pausedReason.trim().slice(0, 400),
    },
  });
  bump("reviewer_review_paused_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "reviewer_review_paused",
    severity: "INFO",
    details: { workflowId: row.id, actorUserId: ctx.actorUserId },
  });
  return buildWorkflowProjection(updated);
}

// ----- requestInformation -----------------------------------------------------

export async function requestInformation(
  ctx: LifecycleActorContext,
  input: { workflowId: string; note: string },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewerOpsWorkflowProjection> {
  requireHuman(ctx);
  assertNoteIfRequired(input.note);
  const row = await loadWorkflowOrThrow(ctx, input.workflowId, client);
  const fromLc = await currentLifecycle(ctx, row, client);
  assertLifecycleTransition(fromLc, "NEEDS_INFORMATION");
  const updated = await legacyRecordReviewDecision(
    {
      evidenceId: row.evidenceId,
      decision: "REQUEST_MORE_INFO",
      actorUserId: ctx.actorUserId,
      note: input.note,
    },
    client,
  );
  bump("reviewer_information_requested_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "reviewer_information_requested",
    severity: "INFO",
    details: { workflowId: row.id, actorUserId: ctx.actorUserId },
  });
  return buildWorkflowProjection(updated);
}

// ----- approveReview ----------------------------------------------------------

export async function approveReview(
  ctx: LifecycleActorContext,
  input: { workflowId: string; note?: string | null },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewerOpsWorkflowProjection> {
  requireHuman(ctx);
  if (input.note && stringContainsForbiddenOverclaim(input.note)) {
    throw new ReviewerOpsError("REVIEW_PERMISSION_DENIED", {
      reason: "forbidden_wording",
    });
  }
  const row = await loadWorkflowOrThrow(ctx, input.workflowId, client);
  const fromLc = await currentLifecycle(ctx, row, client);
  assertLifecycleTransition(fromLc, "APPROVED");
  const updated = await legacyRecordReviewDecision(
    {
      evidenceId: row.evidenceId,
      decision: "APPROVE_INTERNAL",
      actorUserId: ctx.actorUserId,
      note: input.note ?? null,
    },
    client,
  );
  bump("reviewer_review_approved_total");
  bump("reviewer_review_completed_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "reviewer_review_approved",
    severity: "INFO",
    details: { workflowId: row.id, actorUserId: ctx.actorUserId },
  });
  return buildWorkflowProjection(updated);
}

// ----- rejectReview -----------------------------------------------------------

export async function rejectReview(
  ctx: LifecycleActorContext,
  input: { workflowId: string; note: string },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewerOpsWorkflowProjection> {
  requireHuman(ctx);
  assertNoteIfRequired(input.note);
  const row = await loadWorkflowOrThrow(ctx, input.workflowId, client);
  const fromLc = await currentLifecycle(ctx, row, client);
  assertLifecycleTransition(fromLc, "REJECTED");
  const updated = await legacyRecordReviewDecision(
    {
      evidenceId: row.evidenceId,
      decision: "REJECT_INSUFFICIENT",
      actorUserId: ctx.actorUserId,
      note: input.note,
    },
    client,
  );
  bump("reviewer_review_rejected_total");
  bump("reviewer_review_completed_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "reviewer_review_rejected",
    severity: "INFO",
    details: { workflowId: row.id, actorUserId: ctx.actorUserId },
  });
  return buildWorkflowProjection(updated);
}

// -----------------------------------------------------------------------------
// Reconciliation entrypoint
// -----------------------------------------------------------------------------

export type ReconcileResult = {
  scanned: number;
  flippedBreached: number;
  flippedDueSoon: number;
  escalationsCreated: number;
  workloadReviewersComputed: number;
  /** Phase 25.5 — reminders scheduled in this pass. */
  dueSoonRemindersScheduled: number;
  /** Phase 25.5 — inactivity reminders scheduled in this pass. */
  inactivityRemindersScheduled: number;
};

/**
 * Phase 25 reconciliation — wraps the Phase 13 SLA sweep, opens
 * escalations for newly-breached workflows, and refreshes workload
 * snapshots. Idempotent + bounded.
 */
export async function runReconcile(
  input: { teamId: string; batchSize?: number },
  client: PrismaClient = defaultPrisma,
): Promise<ReconcileResult> {
  bump("reviewer_reconcile_run_total");
  let escalationsCreated = 0;
  try {
    const sla = await legacyReconcileReviewSlas(
      { teamId: input.teamId, batchSize: input.batchSize ?? 200 },
      client,
    );

    // Any workflow that just flipped to BREACHED but has no open
    // escalation gets a fresh REVIEW_OVERDUE escalation. The escalation
    // engine's fingerprint dedup prevents duplicates for the same day.
    if (sla.flippedBreached > 0) {
      const breached = await client.evidenceReviewWorkflow.findMany({
        where: {
          teamId: input.teamId,
          slaStatus: "BREACHED",
          activeEscalationId: null,
          status: {
            notIn: ["CLOSED", "REJECTED_INSUFFICIENT", "APPROVED_INTERNAL"],
          },
        },
        take: 100,
      });
      for (const wf of breached) {
        const res = await createEscalation(
          {
            teamId: input.teamId,
            workflowId: wf.id,
            reason: "REVIEW_OVERDUE",
            safeSummary: "Review past due — automatic escalation by reviewer ops reconcile.",
            severity: "HIGH",
            evidenceId: wf.evidenceId,
          },
          client,
        );
        if (res.ok && res.created) {
          escalationsCreated += 1;
          bump("reviewer_sla_breached_total");
          safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "reviewer_sla_breached",
            severity: "WARNING",
            details: { workflowId: wf.id, escalationId: res.escalation.id },
          });
        }
      }
    }

    const workload = await snapshotWorkspaceWorkload(
      { teamId: input.teamId },
      client,
    );

    // Phase 25.5 — sweep reminders + inactivity.
    const dueSoonReminders = await sweepDueSoonReminders(
      { teamId: input.teamId, batchSize: input.batchSize },
      client,
    );

    const flags = await loadWorkspaceReviewerOpsFlags(input.teamId, client);
    const inactivityResult =
      flags.reviewerInactivityHours && flags.reviewerInactivityHours > 0
        ? await sweepInactivityReminders(
            {
              teamId: input.teamId,
              thresholdHours: flags.reviewerInactivityHours,
              batchSize: input.batchSize,
            },
            client,
          )
        : { scanned: 0, scheduled: 0, duplicates: 0 };

    // Escalation-storm detection — if a single reconcile cycle creates
    // more than ESCALATION_STORM_THRESHOLD escalations for the same
    // team, file a single GOVERNANCE OperationalIncident so the
    // on-call sees one alert (the dedupe key collapses repeated
    // bursts within the day). Threshold is conservative; tune via env
    // without redeploying the engine.
    const stormThreshold = (() => {
      const raw = Number(process.env.REVIEWER_ESCALATION_STORM_THRESHOLD ?? 10);
      return Number.isFinite(raw) && raw > 0 ? raw : 10;
    })();
    if (escalationsCreated >= stormThreshold) {
      const today = new Date().toISOString().slice(0, 10);
      try {
        await recordIncident(
          {
            teamId: input.teamId,
            category: "GOVERNANCE",
            severity: "HIGH",
            fingerprint: `reviewer:escalation_storm:${input.teamId}:${today}`,
            title: "Reviewer escalation storm",
            safeSummary:
              `Reviewer reconcile created ${escalationsCreated} escalations in a single sweep. ` +
              `Investigate workload distribution and SLA policy before escalation backlog grows.`,
            runbookSlug: "reviewer-escalation-storm",
            metadata: {
              escalationsCreated,
              flippedBreached: sla.flippedBreached,
              flippedDueSoon: sla.flippedDueSoon,
              workloadReviewersComputed: workload.reviewersComputed,
            },
          },
          client,
        );
      } catch {
        // Storm detection is observability; never let it fail the
        // reconcile itself. Worst case the storm goes unrecorded for
        // this sweep — the next sweep will retry with the same
        // fingerprint (per-team + per-day). The reconcile failure
        // counter would already increment if the outer try threw.
        bump("reviewer_reconcile_failed_total");
      }
    }

    // Operational gauges so dashboards / Prometheus see live counts
    // even when no escalation fired. Cheap counts (single SQL each)
    // bounded to a reasonable window.
    try {
      const overdue = await client.evidenceReviewWorkflow.count({
        where: {
          teamId: input.teamId,
          slaStatus: "BREACHED",
          status: { notIn: ["CLOSED", "REJECTED_INSUFFICIENT", "APPROVED_INTERNAL"] },
        },
      });
      const dueSoon = await client.evidenceReviewWorkflow.count({
        where: {
          teamId: input.teamId,
          slaStatus: "DUE_SOON",
          status: { notIn: ["CLOSED", "REJECTED_INSUFFICIENT", "APPROVED_INTERNAL"] },
        },
      });
      setGauge("reviewer_queue_overdue", overdue);
      setGauge("reviewer_workload_max_active", workload.reviewersComputed);
      // `reviewer_queue_overdue` is also referenced by the Phase Y
      // alert catalog (overdue backlog > 50). Operators see it on
      // the alerts ribbon without any extra wiring.
      // dueSoon is informational — surfaced through metrics only.
      bump("reviewer_workload_computed_total", workload.reviewersComputed);
      void dueSoon;
    } catch {
      // Gauge updates are best-effort; never block reconcile.
    }

    // Phase 25.7 — stuck workflow sweep. Catches the operational
    // states the SLA flip path doesn't catch (submitted_never_assigned,
    // escalated_unacknowledged, approved_export_blocked, etc.) and
    // raises a fresh escalation for any CRITICAL-severity stuck row.
    // Bounded scan + the escalation engine's fingerprint dedup keeps
    // re-runs idempotent.
    let stuckDetected = 0;
    let stuckEscalated = 0;
    try {
      const nonTerminal = await client.evidenceReviewWorkflow.findMany({
        where: {
          teamId: input.teamId,
          status: {
            notIn: [
              "CLOSED",
              "APPROVED_INTERNAL",
              "REJECTED_INSUFFICIENT",
            ] as never,
          },
        },
        take: 200,
        select: {
          id: true,
          evidenceId: true,
          status: true,
          createdAt: true,
          assignedAtUtc: true,
          lastReviewedAt: true,
          slaStatus: true,
          activeEscalationId: true,
        },
      });
      const nowMs = Date.now();
      for (const wf of nonTerminal) {
        const slaStatus: WorkflowSlaStatus =
          wf.slaStatus === "ON_TRACK" ||
          wf.slaStatus === "DUE_SOON" ||
          wf.slaStatus === "BREACHED"
            ? wf.slaStatus
            : null;
        const classification: StuckClassification = detectStuckWorkflow({
          nowEpochMs: nowMs,
          status: wf.status as WorkflowReviewStatus,
          submittedAtEpochMs: wf.createdAt.getTime(),
          assignedAtEpochMs: wf.assignedAtUtc?.getTime() ?? null,
          firstOpenedAtEpochMs: wf.lastReviewedAt?.getTime() ?? null,
          lastReviewerTouchAtEpochMs: wf.lastReviewedAt?.getTime() ?? null,
          lastContributorResponseAtEpochMs: null,
          slaStatus,
          hasOpenEscalation: !!wf.activeEscalationId,
          escalationAcknowledged: false,
          approvedButExportBlocked: false,
        });
        if (!classification.isStuck) continue;
        stuckDetected += 1;
        bump("reviewer_stuck_workflow_detected_total");
        // Only CRITICAL stuck-classifications raise an automated
        // escalation. WARNING / HIGH cases surface via the priority
        // engine + UI, but the reconciliation loop does not fan out
        // additional escalations for them — that would create the
        // escalation storm the engine explicitly guards against.
        if (
          classification.topSeverity === "CRITICAL" &&
          !wf.activeEscalationId
        ) {
          const top = classification.reasons[0]!;
          const res = await createEscalation(
            {
              teamId: input.teamId,
              workflowId: wf.id,
              // Map to the canonical escalation reason catalog. Stuck-
              // workflow CRITICAL is most often a stalled lifecycle —
              // route it through WORKFLOW_STALLED so the existing
              // fingerprint dedup keeps escalation storms bounded.
              reason: "WORKFLOW_STALLED",
              safeSummary: `Workflow stuck — ${top.label}. Automatic escalation by reviewer ops reconcile.`,
              severity: "HIGH",
              evidenceId: wf.evidenceId ?? null,
            },
            client,
          );
          if (res.ok && res.created) {
            stuckEscalated += 1;
            escalationsCreated += 1;
            bump("reviewer_stuck_workflow_escalated_total");
          }
        }
      }
    } catch {
      // Stuck sweep is best-effort; failure must not abort reconcile.
    }

    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "reviewer_reconcile_run",
      severity: "INFO",
      details: {
        scanned: sla.scanned,
        flippedBreached: sla.flippedBreached,
        flippedDueSoon: sla.flippedDueSoon,
        escalationsCreated,
        workloadReviewersComputed: workload.reviewersComputed,
        dueSoonRemindersScheduled: dueSoonReminders.scheduled,
        inactivityRemindersScheduled: inactivityResult.scheduled,
        stuckDetected,
        stuckEscalated,
      },
    });

    return {
      scanned: sla.scanned,
      flippedBreached: sla.flippedBreached,
      flippedDueSoon: sla.flippedDueSoon,
      escalationsCreated,
      workloadReviewersComputed: workload.reviewersComputed,
      dueSoonRemindersScheduled: dueSoonReminders.scheduled,
      inactivityRemindersScheduled: inactivityResult.scheduled,
    };
  } catch (err) {
    bump("reviewer_reconcile_failed_total");
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Re-export the Phase 13 helpers + Phase 25 sub-services for the route
// layer (so the routes import from this single facade).
// -----------------------------------------------------------------------------

export {
  ensureReviewWorkflow,
  legacyAssignReviewer,
  legacyClaimReviewerWorkflow,
  legacyBulkReviewAction,
  legacyUpdateReviewSla,
};
