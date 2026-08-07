/**
 * Phase 25.7 — Reviewer queue intelligence projection.
 *
 * Single orchestrator service that wraps the shared engines (priority,
 * stuck-workflow, assignment ranking) into one typed projection the
 * reviewer-ops UI can render directly. The route layer NEVER calls
 * the shared engines individually — it goes through this service so
 * the orchestration order (eligibility → score → stuck → suggestion)
 * stays consistent.
 *
 * Hard rules:
 *   - The route layer does not query Prisma directly. Every fetch
 *     happens here.
 *   - The projection NEVER exposes:
 *       - private reviewer notes
 *       - legal-hold reason text
 *       - storage keys / signed URLs
 *       - raw GPS / private contributor fields
 *       - other actors' reviewer notes
 *   - Workflow IDs / evidence IDs / reviewer IDs ARE exposed because
 *     they are operator-routing identifiers the UI needs for action
 *     buttons. Anti-enumeration: every read filters on (teamId, …) so
 *     cross-workspace lookups are impossible.
 *   - Fail-closed: any per-engine error returns the engine's safe
 *     default ("unknown" priority, empty suggestion list, "isStuck:
 *     false") rather than throwing to the caller. Operators see the
 *     UI render in a graceful degraded mode.
 *   - Bounded: the route can request projections for at most 100
 *     workflows in one call; reviewer-suggestion fan-out is capped at
 *     50 candidates per workflow.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  computeReviewerPriority,
  detectStuckWorkflow,
  rankReviewerSuggestions,
  type EscalationSeverity,
  type PriorityFacts,
  type PriorityScoreResult,
  type RankerResult,
  type ReviewerCandidate,
  type StuckClassification,
  type WorkflowAssignmentFacts,
  type WorkflowReviewStatus,
  type WorkflowSlaStatus,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";

// =============================================================================
// Inputs / projection shape
// =============================================================================

export type QueueIntelligenceInput = {
  teamId: string;
  /**
   * Workflow IDs to project. Bounded — at most 100 per call so a
   * pathological caller cannot fan out across the whole queue.
   */
  workflowIds: ReadonlyArray<string>;
  /**
   * Caller is responsible for asserting that the actor has the
   * canonical permission to read reviewer queue rows for this team.
   * The orchestrator does NOT re-derive permissions — RBAC stays at
   * the route boundary.
   */
  actorUserId: string;
  /** Whether the actor is reviewer-capable; affects suggestion
   *  ranking + stuck detection. */
  isReviewerCapable: boolean;
};

export type GovernanceBlockerProjection = {
  legalHold: boolean;
  /** Storage governance drift (Phase 28-J operational incident open). */
  immutableDrift: boolean;
  packageBlocked: boolean;
  exportBlocked: boolean;
  retentionExpired: boolean;
};

export type QueueWorkflowIntelligence = {
  workflowId: string;
  evidenceId: string | null;
  /** Stable workflow status — bounded vocabulary. */
  status: string;
  /** Priority score + band + reasons (top-3 sorted). */
  priority: PriorityScoreResult;
  /** Stuck workflow classification. */
  stuckState: StuckClassification;
  /** Bounded ranking of recommended reviewers. NEVER returns
   *  ineligible reviewers — they sit in `ineligible` for operator
   *  audit. */
  assignmentSuggestions: RankerResult;
  /** Workload pressure of the currently-assigned reviewer, or null when
   *  the workflow is unassigned. */
  reviewerPressure: "available" | "balanced" | "overloaded" | null;
  /** Governance blockers — operator-facing booleans. */
  governanceBlockers: GovernanceBlockerProjection;
  /** SLA snapshot. */
  slaState: {
    status: WorkflowSlaStatus;
    dueAtUtc: string | null;
    breachedAtUtc: string | null;
  };
  /** Escalation snapshot. */
  escalationState: {
    activeEscalationId: string | null;
    severity: EscalationSeverity;
  };
  /** Aging — driver of "submitted N days ago" UI label. */
  queueAging: {
    createdAtUtc: string;
    daysOpen: number;
    lastReviewerTouchAtUtc: string | null;
  };
};

export type QueueIntelligenceResult = {
  projections: ReadonlyArray<QueueWorkflowIntelligence>;
  /** Operator-readable summary of any per-row failures the
   *  orchestrator caught + degraded gracefully. */
  degradations: ReadonlyArray<{
    workflowId: string;
    reason: "workflow_not_found" | "team_mismatch" | "compute_error";
  }>;
};

// =============================================================================
// Bounded request size
// =============================================================================

const MAX_WORKFLOWS_PER_CALL = 100;
const MAX_CANDIDATES_PER_WORKFLOW = 50;

// =============================================================================
// Helpers
// =============================================================================

function epochMsOrNull(date: Date | null | undefined): number | null {
  if (!date) return null;
  const v = date.getTime();
  return Number.isFinite(v) ? v : null;
}

function epochMs(date: Date): number {
  return date.getTime();
}

function safeDayDiff(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000));
}

function mapSeverity(
  severity: string | null | undefined,
): EscalationSeverity {
  if (!severity) return null;
  const upper = severity.toUpperCase();
  if (
    upper === "INFO" ||
    upper === "WARNING" ||
    upper === "HIGH" ||
    upper === "CRITICAL"
  ) {
    return upper;
  }
  return null;
}

function mapSlaStatus(status: string | null | undefined): WorkflowSlaStatus {
  if (status === "ON_TRACK" || status === "DUE_SOON" || status === "BREACHED") {
    return status;
  }
  return null;
}

function mapReviewStatus(status: string | null | undefined): string {
  return status ?? "UNKNOWN";
}

function isExternalIntakeFromActor(role: string | null | undefined): boolean {
  return role === "EXTERNAL_CONTRIBUTOR" || role === "ANONYMOUS_SOURCE";
}

// =============================================================================
// Reviewer candidate fetch — bounded.
// =============================================================================

async function loadReviewerCandidates(
  client: PrismaClient,
  teamId: string,
): Promise<ReadonlyArray<ReviewerCandidate>> {
  // Bounded: at most MAX_CANDIDATES_PER_WORKFLOW team members.
  let memberships: Array<{
    userId: string;
    role: string;
  }> = [];
  try {
    // PHASE 12 REMEDIATION (2026-08-06) — `suspendedAtUtc: null` was a PROXY
    // for liveness that a REVOKED row also satisfies (revocation stamps
    // `revokedAtUtc`, not `suspendedAtUtc`), so revoked members were offered
    // as assignment candidates. The canonical status is authoritative.
    memberships = await client.teamMember.findMany({
      where: { teamId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      take: MAX_CANDIDATES_PER_WORKFLOW,
      select: { userId: true, role: true },
    });
  } catch {
    return [];
  }
  if (memberships.length === 0) return [];
  const userIds = memberships.map((m) => m.userId);

  // Per-reviewer workload — best-effort. Failures collapse to the safe
  // default (zero workload) so the suggestion engine still ranks the
  // candidate (eligibility gate still runs).
  let workloadByUser = new Map<
    string,
    {
      activeReviews: number;
      overdueReviews: number;
      dueSoonReviews: number;
      escalatedReviews: number;
      completedLast7d: number;
      lastReviewerActivityAtUtc: Date | null;
    }
  >();
  try {
    const workloads = await client.reviewerWorkloadSnapshot.findMany({
      where: { teamId, reviewerUserId: { in: userIds } },
      select: {
        reviewerUserId: true,
        activeReviewCount: true,
        overdueReviewCount: true,
        dueSoonReviewCount: true,
        escalatedReviewCount: true,
        // The Prisma model exposes per-reviewer counts only; the
        // completed-last-7d + last-activity columns may not exist on
        // every deployed DB. Field selection is intentionally narrow
        // so a future column add doesn't force an indexer rebuild.
      },
    });
    workloadByUser = new Map(
      workloads.map((w) => [
        w.reviewerUserId,
        {
          activeReviews: w.activeReviewCount,
          overdueReviews: w.overdueReviewCount,
          dueSoonReviews: w.dueSoonReviewCount,
          escalatedReviews: w.escalatedReviewCount,
          // Not yet surfaced by the current snapshot table — bounded
          // safe defaults. Suggestion ranker tolerates zero.
          completedLast7d: 0,
          lastReviewerActivityAtUtc: null,
        },
      ]),
    );
  } catch {
    workloadByUser = new Map();
  }

  return memberships.map((m): ReviewerCandidate => {
    const w = workloadByUser.get(m.userId);
    const activeReviews = w?.activeReviews ?? 0;
    const overdueReviews = w?.overdueReviews ?? 0;
    const escalatedReviews = w?.escalatedReviews ?? 0;
    const pressure: ReviewerCandidate["workload"]["pressure"] =
      activeReviews + overdueReviews >= 12
        ? "overloaded"
        : activeReviews + overdueReviews >= 5
          ? "balanced"
          : "available";
    return {
      reviewerId: m.userId,
      workspaceTeamId: teamId,
      role: m.role,
      permissions: {
        // Canonical roles eligible for review assignment. The engine
        // refuses non-eligible roles via the bounded check; OWNER /
        // ADMIN / REVIEWER are the eligible set.
        canAssignReviewer:
          m.role === "OWNER" || m.role === "ADMIN" || m.role === "REVIEWER",
        canSeeReviewerRestricted: m.role === "OWNER" || m.role === "ADMIN",
        canSeeContributorPrivate:
          m.role === "OWNER" || m.role === "ADMIN" || m.role === "REVIEWER",
        canActOnLegalHold: m.role === "OWNER" || m.role === "ADMIN",
      },
      isCaseTeamMember: true, // bounded simplification — case-team
      // membership is the same as workspace membership for the Phase
      // 25.7 ship. Future revisions can pull from a per-case team
      // table.
      expertiseTags: [],
      workload: {
        activeReviews,
        overdueReviews,
        dueSoonReviews: w?.dueSoonReviews ?? 0,
        escalatedReviews,
        recentCompleted: w?.completedLast7d ?? 0,
        pressure,
        lastActivityAtEpochMs: epochMsOrNull(
          w?.lastReviewerActivityAtUtc ?? null,
        ),
        recentAssignmentBurstCount: 0,
      },
    };
  });
}

// =============================================================================
// Main orchestrator
// =============================================================================

export async function projectQueueIntelligence(
  input: QueueIntelligenceInput,
  client: PrismaClient = defaultPrisma,
): Promise<QueueIntelligenceResult> {
  const requested = input.workflowIds.slice(0, MAX_WORKFLOWS_PER_CALL);
  if (requested.length === 0) {
    return { projections: [], degradations: [] };
  }

  // Single batch fetch — every workflow row plus the related evidence
  // governance pointers + active-escalation severity + open-incident
  // pointer. Bounded by MAX_WORKFLOWS_PER_CALL.
  let workflows: Array<prismaPkg.EvidenceReviewWorkflow & {
    evidence: prismaPkg.Evidence | null;
  }>;
  try {
    workflows = (await client.evidenceReviewWorkflow.findMany({
      where: {
        teamId: input.teamId,
        id: { in: requested as string[] },
      },
      include: {
        evidence: true,
      },
    })) as never;
  } catch {
    bump("reviewer_priority_computed_total");
    return {
      projections: [],
      degradations: requested.map((id) => ({
        workflowId: id,
        reason: "compute_error" as const,
      })),
    };
  }

  const foundIds = new Set(workflows.map((w) => w.id));
  const degradations: Array<
    QueueIntelligenceResult["degradations"][number]
  > = requested
    .filter((id) => !foundIds.has(id))
    .map((id) => ({ workflowId: id, reason: "workflow_not_found" as const }));

  // Active escalation severity — single batch lookup.
  const workflowIds = workflows.map((w) => w.id);
  let escalationByWorkflow: Map<
    string,
    { id: string; severity: string }
  > = new Map();
  try {
    if (workflowIds.length > 0) {
      const escalations = await client.reviewEscalation.findMany({
        where: {
          teamId: input.teamId,
          workflowId: { in: workflowIds },
          status: { in: ["OPEN", "ACKNOWLEDGED", "REASSIGNED"] },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, workflowId: true, severity: true },
      });
      // Latest open escalation per workflow.
      for (const e of escalations) {
        if (!escalationByWorkflow.has(e.workflowId)) {
          escalationByWorkflow.set(e.workflowId, {
            id: e.id,
            severity: e.severity,
          });
        }
      }
    }
  } catch {
    escalationByWorkflow = new Map();
  }

  // Open immutable-drift incident pointer — single batch lookup against
  // OperationalIncident with the canonical runbookSlug.
  const evidenceIds = workflows
    .map((w) => w.evidenceId)
    .filter((id): id is string => typeof id === "string");
  let driftEvidenceSet: Set<string> = new Set();
  try {
    if (evidenceIds.length > 0) {
      const incidents = await client.operationalIncident.findMany({
        where: {
          teamId: input.teamId,
          relatedEvidenceId: { in: evidenceIds },
          status: { in: ["OPEN", "ACKNOWLEDGED"] },
          runbookSlug: "immutable-drift",
        },
        select: { relatedEvidenceId: true },
      });
      driftEvidenceSet = new Set(
        incidents
          .map((i) => i.relatedEvidenceId)
          .filter((id): id is string => typeof id === "string"),
      );
    }
  } catch {
    driftEvidenceSet = new Set();
  }

  // Reviewer candidates — single fetch, reused across all workflows in
  // the batch to keep the cost bounded.
  const candidates = await loadReviewerCandidates(client, input.teamId);

  const now = new Date();
  const nowMs = epochMs(now);

  const projections: QueueWorkflowIntelligence[] = [];
  for (const wf of workflows) {
    try {
      const evidence = wf.evidence;
      const legalHold =
        evidence?.storageObjectLockLegalHoldStatus === "ON" ||
        evidence?.storageObjectLockLegalHoldStatus === "ACTIVE";
      const immutableDrift = evidence
        ? driftEvidenceSet.has(evidence.id)
        : false;
      const lifecycle = (evidence?.lifecycleState ?? "ACTIVE").toUpperCase();
      const packageBlocked =
        legalHold ||
        immutableDrift ||
        lifecycle === "PENDING_DESTRUCTION" ||
        lifecycle === "DESTROYED";
      const exportBlocked =
        legalHold ||
        lifecycle === "PENDING_DESTRUCTION" ||
        lifecycle === "DESTROYED" ||
        lifecycle === "ON_HOLD";
      const retentionExpired = !!(
        evidence?.retentionUntilUtc &&
        evidence.retentionUntilUtc.getTime() < nowMs
      );

      const escalation = escalationByWorkflow.get(wf.id);
      const slaStatus = mapSlaStatus(wf.slaStatus);

      const stuckState = detectStuckWorkflow({
        nowEpochMs: nowMs,
        status: mapReviewStatus(wf.status) as WorkflowReviewStatus,
        submittedAtEpochMs: epochMs(wf.createdAt),
        assignedAtEpochMs: epochMsOrNull(wf.assignedAtUtc),
        firstOpenedAtEpochMs: epochMsOrNull(wf.lastReviewedAt),
        lastReviewerTouchAtEpochMs: epochMsOrNull(wf.lastReviewedAt),
        lastContributorResponseAtEpochMs: null,
        slaStatus,
        hasOpenEscalation: !!escalation,
        escalationAcknowledged:
          escalation?.severity ? false : false,
        approvedButExportBlocked:
          (wf.status === "APPROVED_INTERNAL" ||
            wf.status === "READY_FOR_EXTERNAL_REVIEW") &&
          exportBlocked,
      });

      // Assigned reviewer pressure — lookup in the loaded candidate list.
      const assigned = wf.assignedToUserId
        ? candidates.find((c) => c.reviewerId === wf.assignedToUserId)
        : null;
      const reviewerPressure = assigned?.workload.pressure ?? null;

      const priorityFacts: PriorityFacts = {
        nowEpochMs: nowMs,
        slaStatus,
        activeEscalationSeverity: mapSeverity(escalation?.severity),
        hasActiveLegalHold: legalHold,
        hasOpenImmutableDriftIncident: immutableDrift,
        packageBlocked,
        exportBlocked,
        // Evidence model does not currently expose a per-row priority
        // field — Phase 25's priority engine treats null as "no
        // signal" and continues. Future revisions can plumb a per-
        // workflow priority hint here.
        evidencePriority: null,
        isExternalIntake: isExternalIntakeFromActor(
          evidence?.captureMethod ?? null,
        ),
        isStuck: stuckState.isStuck,
        assignedReviewerPressure: reviewerPressure,
        workflowCreatedAtEpochMs: epochMs(wf.createdAt),
        lastTouchAtEpochMs: epochMsOrNull(wf.lastReviewedAt),
        caseCriticality: null,
      };
      const priority = computeReviewerPriority(priorityFacts);
      bump("reviewer_priority_computed_total");

      // Assignment suggestions — bounded fan-out. We pass the SAME
      // candidate list because the eligibility gate inside the ranker
      // filters per (workflow, candidate) pair.
      const assignmentFacts: WorkflowAssignmentFacts = {
        nowEpochMs: nowMs,
        workflowId: wf.id,
        teamId: input.teamId,
        status: wf.status,
        hasActiveLegalHold: legalHold,
        reviewerRestricted: false,
        contributorPrivate: isExternalIntakeFromActor(
          evidence?.captureMethod ?? null,
        ),
        actorUserId: input.actorUserId,
        currentReviewerUserId: wf.assignedToUserId ?? null,
        requiredCaseTeamId: null,
        escalationOwnerUserId: null,
      };
      const assignmentSuggestions = rankReviewerSuggestions(
        assignmentFacts,
        candidates,
      );
      bump("reviewer_assignment_rank_computed_total");

      projections.push({
        workflowId: wf.id,
        evidenceId: wf.evidenceId ?? null,
        status: wf.status,
        priority,
        stuckState,
        assignmentSuggestions,
        reviewerPressure,
        governanceBlockers: {
          legalHold,
          immutableDrift,
          packageBlocked,
          exportBlocked,
          retentionExpired,
        },
        slaState: {
          status: slaStatus,
          dueAtUtc: wf.dueAt?.toISOString() ?? null,
          breachedAtUtc:
            slaStatus === "BREACHED"
              ? (wf.updatedAt?.toISOString() ?? null)
              : null,
        },
        escalationState: {
          activeEscalationId: escalation?.id ?? null,
          severity: mapSeverity(escalation?.severity),
        },
        queueAging: {
          createdAtUtc: wf.createdAt.toISOString(),
          daysOpen: safeDayDiff(wf.createdAt, now),
          lastReviewerTouchAtUtc: wf.lastReviewedAt?.toISOString() ?? null,
        },
      });
    } catch {
      degradations.push({ workflowId: wf.id, reason: "compute_error" });
    }
  }

  return { projections, degradations };
}
