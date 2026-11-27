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

import { recordReviewActivityTx } from "../evidence-review/reviewer-audit.service.js";
import type { PrismaClient, EvidenceReviewWorkflow as DbWorkflow } from "@prisma/client";
import { REVIEW_AUTO_ESCALATION_SUMMARY } from "@proovra/shared";
import { loadReviewerIdentities, withReviewerIdentity, type ReviewerIdentityProjection } from "./reviewer-identity.service.js";
import {
  REVIEWER_OPS_DEFAULT_SLA_POLICY,
  REVIEW_FINISHED_DB_STATUSES,
  computeReviewerOpsSlaSnapshot,
  deriveLifecycleState,
  isAllowedLifecycleTransition,
  isReviewOpenDbStatus,
  mapDbStatusToReviewStage,
  reviewSlaInputFromRow,
  rollupReviewerOpsSlaState,
  storedReviewSlaStatus,
  stringContainsForbiddenOverclaim,
  type ReviewSlaDimensionSnapshot,
  type ReviewerOpsLifecycleState,
  type ReviewerOpsQueueType,
  type ReviewerOpsSlaState,
  reviewStartRefusal,
  reviewWasHandedOver,
  stageMoveRefusal,
  verdictStageRefusal,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { evidenceVisibleThroughCasesWhere } from "../cases/case-visibility.js";
import { bump, setGauge } from "../ops/metrics.service.js";
// Phase O1.5D — bounded reviewer-ops spans. NEVER reviewer notes,
// PII, or workflow body content; bounded teamId + workflowId only.
import {
  PROOVRA_SPAN_NAMES,
  withProovraSpan,
} from "../../observability/otel.js";
// Phase 32.7 — canonical operational event contract. The worker
// heartbeat write site below MUST resolve the wire string through
// this constant so the reader (`runtime-readiness.checkWorkers`)
// cannot drift from the writer.
import {
  wireStringFor as canonicalOperationalWireStringFor,
} from "@proovra/shared-runtime/ops";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { recordIncident } from "../observability/incident.service.js";
import {
  assignReviewer as legacyAssignReviewer,
  bulkReviewAction as legacyBulkReviewAction,
  claimReviewerWorkflow as legacyClaimReviewerWorkflow,
  ensureReviewWorkflow,
  ReviewOperationError,
  getReviewQueueCounts as legacyGetReviewQueueCounts,
  projectReviewWorkflow as legacyProjectReviewWorkflow,
  reconcileReviewSlas as legacyReconcileReviewSlas,
  stampOpenReviewDeadlines,
  updateReviewSla as legacyUpdateReviewSla,
} from "../review-operations/review-operations.service.js";
// Track 1C — canonical review-decision authority. Approve / reject /
// request-info are reviewer VERDICTS: they append an immutable
// WorkflowReviewDecision row and derive the workflow.status projection
// in ONE transaction. The engine no longer writes decision status
// through the legacy lifecycle service.
import {
  ReviewDecisionAuthorityError,
  ReviewDecisionDryRunPassed,
  recordReviewDecision as recordCanonicalReviewDecision,
  // PHASE 13 §4 (2026-08-17) — projection repair, armed by this reconcile pass.
  scanReviewDecisionProjections,
  loadCurrentRoundDecisionState,
  type CurrentRoundDecisionState,
  type ReviewDecisionOutcome,
} from "./review-decision.service.js";
import {
  createEscalation,
  findActiveEscalationSummaryForWorkflow,
  findOpenEscalationForWorkflow,
  type EscalationProjection,
} from "./escalation-engine.service.js";
import {
  activeEscalationWhere,
  escalatedReviewWhere,
  hasActiveEscalationWhere,
} from "./review-count-definitions.js";
import { withReadTimeSlaFacts } from "./review-sla-read-facts.js";
import { REVIEW_ESCALATION_ACTIVE_STATUSES, selectGoverningEscalation } from "@proovra/shared";
import {
  snapshotWorkspaceWorkload,
  suggestReviewers,
  listLatestWorkloadSnapshots,
  type ReviewerSuggestion,
  type WorkloadDashboardRow,
} from "./workload.service.js";
import { loadWorkspaceReviewerOpsFlags } from "./sla-policy.service.js";
import {
  classifyCurrentRounds,
  computeReviewHandoff,
  handoffRequirementFor,
  REVIEWER_OPS_HANDOFF_QUEUE_TYPES,
  type ReviewHandoff,
  type ReviewerOpsHandoffQueueType,
} from "./review-handoff.service.js";
import { notifyReviewResponseReceived } from "../review-operations/review-notifications.service.js";
import { workspaceIncludesReviewCapability } from "../billing-enforcement.service.js";
import { warn as logWarn } from "../../utils/logger.js";
import { sampleClosedWorkflow } from "../reviewer-workspace/qc-sample.service.js";
import { resolveReviewPolicyForEvidence } from "./review-sla-stamp.service.js";
import { advanceSweepCursor, afterCursor, readSweepCursor } from "./sweep-cursor.js";
import {
  deliverScheduledReminders,
  sweepDueSoonReminders,
  sweepInactivityReminders,
} from "./reminder-engine.service.js";
// Phase 3 — QC sampling at workflow close. Single chokepoint so every
// approve / reject (route, bulk, future programmatic) is sampled
// exactly once. The service itself is idempotent per (workflowId, teamId).
import {
  detectStuckWorkflow,
  stuckStatusFromDbStatus,
  type StuckClassification,
  type WorkflowSlaStatus,
} from "@proovra/shared";

/**
 * THE WORK THIS MODULE RECOVERS.
 *
 * Declared here so the canonical work registry's `reconciler` field can be
 * checked against the module it names rather than merely against the
 * filesystem. The topology gate proves the two agree in both directions: a
 * registry entry pointing at a module that does not claim its work fails, and
 * a module claiming work no entry assigns it fails.
 *
 * That check exists because the weaker one — "the declared file exists" —
 * passed three false declarations in a row: UPGRADE_OTS and
 * PURGE_DELETED_EVIDENCE both named a module containing no such code, and
 * EMBED_SEMANTIC_CHUNKS named one whose every scan keyed on a table the embed
 * chain never writes. All three resolved to a real file. None of them was true.
 *
 * Keys, not values: the registry addresses work through `JOB_NAMES` /
 * `SWEEP_NAMES`, and a literal string here would be a second spelling of a
 * name the shared authority already owns.
 */
export {
  resolveTemplateIdForEvidence,
  type SlaTemplateResolution,
  type SlaTemplateResolutionSource,
} from "./review-sla-stamp.service.js";

export const RECOVERED_WORK_TYPES = [
  "REVIEWER_RECONCILIATION",
] as const;


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
      | "REVIEW_ACTOR_BLOCKED"
      | "REVIEW_ASSIGNEE_NOT_ELIGIBLE"
      | "REVIEW_ASSIGNEE_NOT_PLACED",
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "ReviewerOpsError";
  }
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
  /** Set while the SLA clock is stopped; the way out is resume. */
  slaPausedAtUtc: string | null;
  pausedReason: string | null;
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
  const snapshots = computeReviewerOpsSlaSnapshot(
    reviewSlaInputFromRow(row, {
      nowUtc: opts?.nowUtc,
      hasOpenEscalation: opts?.hasOpenEscalation,
    }),
  );
  return {
    workflowId: row.id,
    evidenceId: row.evidenceId,
    teamId: row.teamId,
    lifecycleState,
    assignedToUserId: row.assignedToUserId,
    assignedAtUtc: row.assignedAtUtc?.toISOString() ?? null,
    priority: row.priority,
    slaPausedAtUtc: row.slaPausedAtUtc?.toISOString() ?? null,
    pausedReason: row.pausedReason ?? null,
    slaRollupState: rollupReviewerOpsSlaState(snapshots),
    slaDimensions: snapshots,
    legacy: legacyProjectReviewWorkflow(row),
  };
}

/**
 * Stage C follow-up — THE async projection for one row read after a write:
 * read-time SLA facts (first decision, sweep-stamped-after deadlines) and,
 * unless the caller states it, whether an escalation is active (by query).
 */
export async function projectWorkflow(
  row: DbWorkflow,
  client: PrismaClient,
  opts?: { hasOpenEscalation?: boolean; nowUtc?: Date },
): Promise<ReviewerOpsWorkflowProjection> {
  const [facts] = await withReadTimeSlaFacts([row], client);
  const hasOpenEscalation =
    opts?.hasOpenEscalation ??
    (row.teamId
      ? !!(await findOpenEscalationForWorkflow({ teamId: row.teamId, workflowId: row.id }, client))
      : false);
  return buildWorkflowProjection(facts!, { ...opts, hasOpenEscalation });
}

// -----------------------------------------------------------------------------
// Lifecycle transition gate
// -----------------------------------------------------------------------------

function assertLifecycleTransition(
  from: ReviewerOpsLifecycleState,
  to: ReviewerOpsLifecycleState,
  reason: string = "invalid_transition",
): void {
  if (!isAllowedLifecycleTransition(from, to)) {
    bump("reviewer_invalid_transition_blocked_total");
    throw new ReviewerOpsError("REVIEW_INVALID_TRANSITION", { reason, from, to });
  }
}

/**
 * T-010 — the legacy verdict doors refuse input exactly as THE decision
 * authority does: it applies the non-empty / 4000-character rule (answered as
 * REVIEW_NOTE_REQUIRED, details.reason the authority code, status 400).
 */
function assertDecisionInput(note: string | null | undefined): void {
  // Emptiness and length are the authority's (checked after who may decide);
  // the overclaim screen stays first, as it always was on these doors.
  const trimmed = (note ?? "").trim();
  if (stringContainsForbiddenOverclaim(trimmed)) {
    throw new ReviewerOpsError("REVIEW_PERMISSION_DENIED", { reason: "forbidden_wording" });
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

/** T-086 (stage D) — a queue row names its assignee (display name / masked e-mail). */
/**
 * T-096 (stage D) — THE Inbox order: the deadline first (an overdue review
 * comes before one that is on track, whatever their priorities), then
 * priority, then the most recently touched; `id` keeps the order total for the
 * cursor. A review with no deadline comes after every dated one. (Before: the
 * priority came first, so an on-track HIGH review sorted above an overdue
 * NORMAL one.)
 */
export const REVIEW_QUEUE_ORDER = [
  { dueAt: { sort: "asc" as const, nulls: "last" as const } },
  { priority: "desc" as const },
  { updatedAt: "desc" as const },
  { id: "desc" as const },
];

export type ReviewerOpsQueueRow = ReviewerOpsWorkflowProjection & { assignee?: ReviewerIdentityProjection | null };

/**
 * The shared queue catalog plus the TEAM-SPEC R3 handoff slices
 * (AWAITING_SECOND_REVIEW / AWAITING_ADJUDICATION), which are derived from the
 * current round's decision state rather than a column.
 */
export type ReviewerOpsQueueName = ReviewerOpsQueueType | ReviewerOpsHandoffQueueType;
export { REVIEWER_OPS_HANDOFF_QUEUE_TYPES, type ReviewerOpsHandoffQueueType, type ReviewHandoff };

function isHandoffQueue(q: ReviewerOpsQueueName): q is ReviewerOpsHandoffQueueType {
  return (REVIEWER_OPS_HANDOFF_QUEUE_TYPES as ReadonlyArray<string>).includes(q);
}

export type ReviewerOpsQueueInput = {
  teamId: string;
  meUserId: string;
  queue: ReviewerOpsQueueName;
  /**
   * Handoff slices only: the most candidates one call may classify (default
   * and ceiling 1000). The console passes a small bound; a page cut short by
   * it still returns a cursor.
   */
  maxScan?: number;
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
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.REVIEWER_QUEUE_BUILD,
    { "proovra.team_id": input.teamId, "proovra.operation": "reviewer_queue_build" },
    () => listReviewerOpsQueueInner(input, client),
  );
}

async function listReviewerOpsQueueInner(
  input: ReviewerOpsQueueInput,
  client: PrismaClient,
): Promise<{
  rows: ReadonlyArray<ReviewerOpsQueueRow>;
  nextCursor: string | null;
}> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  if (isHandoffQueue(input.queue)) {
    return listHandoffQueue({ ...input, queue: input.queue, limit }, client);
  }
  // WORKFLOW-013 — every work queue shows open work. Only Completed recently looks
  // at finished reviews; it sets its own filter below.
  const baseWhere: Record<string, unknown> = {
    teamId: input.teamId,
    status: { notIn: [...REVIEW_FINISHED_DB_STATUSES] },
  };
  switch (input.queue) {
    case "ALL_OPEN":
      // Every open review (openReviewWhere): the base filter alone. The route
      // serves it only to review.assign holders; the record rule applies below.
      break;
    case "MY_REVIEWS":
      baseWhere.assignedToUserId = input.meUserId;
      break;
    case "UNASSIGNED":
      baseWhere.assignedToUserId = null;
      break;
    case "OVERDUE":
      baseWhere.slaStatus = { in: ["OVERDUE", "BREACHED"] };
      break;
    case "DUE_SOON":
      baseWhere.slaStatus = "DUE_SOON";
      break;
    case "ESCALATED":
      // T-050 / T-052 (stage C) — "escalated" is decided by query (EXISTS an
      // active escalation), never by the denormalised pointer, which drifted
      // when escalations were resolved out of order.
      Object.assign(baseWhere, escalatedReviewWhere());
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
      // An ordinary SLA escalation is not an integrity risk (WORKFLOW-013).
      // Any active integrity escalation counts, whichever the pointer names (T-050).
      Object.assign(
        baseWhere,
        hasActiveEscalationWhere({ reason: { in: ["INTEGRITY_RISK", "VERIFICATION_MISMATCH"] } }),
      );
      break;
    case "EXTERNAL_INTAKE":
      baseWhere.workspaceType = "EXTERNAL_INTAKE";
      break;
    case "COMPLETED_RECENTLY":
      delete baseWhere.status;
      baseWhere.completedAtUtc = {
        gte: new Date(Date.now() - 7 * 86400_000),
      };
      break;
  }
  // Phase RW3 — honest cursor pagination.
  //
  // The previous implementation produced a `nextCursor` from the last
  // row id but the route layer never piped it back in, so subsequent
  // pages were impossible. We now thread an optional `cursor` (the
  // workflow id last returned) and use Prisma's `cursor` + `skip: 1`
  // pagination contract.
  //
  // The functional sort tuple stays the same — operators still see
  // (priority desc, dueAt asc, updatedAt desc) — but we append an
  // explicit `{ id: "desc" }` tiebreaker so the ordering is total
  // and `cursor: { id }` is well-defined. Without that tiebreaker,
  // two workflows with the same (priority, dueAt, updatedAt) would
  // sort non-deterministically and the cursor could either re-emit
  // or skip rows.
  //
  // Cap mirrors the route layer (max 100).
  const cursorId =
    typeof input.cursor === "string" && input.cursor.length > 0
      ? input.cursor
      : null;
  /*
   * Members audit REV-03 (2026-10-25) — the queue is narrowed by the SAME
   * restricted-case rule every evidence read applies: a workflow whose evidence
   * sits on a restricted case the caller is not on is not in their queue. The
   * queue switch above may already constrain `evidence` (LEGAL_HOLD), so the
   * two are composed, never spread over each other.
   */
  const scopedWhere = {
    AND: [baseWhere, { evidence: evidenceVisibleThroughCasesWhere(input.meUserId) }],
  };
  const rows = await client.evidenceReviewWorkflow.findMany({
    where: scopedWhere as never,
    orderBy: REVIEW_QUEUE_ORDER,
    take: limit + 1,
    ...(cursorId
      ? { cursor: { id: cursorId }, skip: 1 }
      : {}),
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
            status: { in: [...REVIEW_ESCALATION_ACTIVE_STATUSES] },
          },
          select: { workflowId: true },
        });
  const escSet = new Set(openEsc.map((e) => e.workflowId));

  const now = new Date();
  // Stage C follow-up — read-time SLA facts for rows the repair has not touched.
  const factRows = await withReadTimeSlaFacts(rows, client);
  // T-086 (stage D) — the assignee as the server names them, in the row.
  const assigneeIdentities = await loadReviewerIdentities(factRows.map((r) => r.assignedToUserId), client);
  const projected = factRows.map((r) =>
    withAssigneeIdentity(
      buildWorkflowProjection(r, {
        hasOpenEscalation: escSet.has(r.id),
        nowUtc: now,
      }),
      assigneeIdentities,
    ),
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

/**
 * T-086 (stage D) — `assignee` beside `assignedToUserId`: the display name or
 * the masked e-mail, so the Inbox names the assignee the same way the picker
 * and the lineage do. Null when unassigned.
 */
export function withAssigneeIdentity<T extends { assignedToUserId: string | null }>(
  projection: T,
  identities: ReadonlyMap<string, ReviewerIdentityProjection>,
): T & { assignee: ReviewerIdentityProjection | null } {
  const id = projection.assignedToUserId;
  return {
    ...projection,
    assignee: id ? identities.get(id) ?? { displayName: null, maskedEmail: null } : null,
  };
}

// -----------------------------------------------------------------------------
// TEAM-SPEC R3 — handoff queue slices.
//
// "Awaiting second reviewer" = open reviews whose CURRENT round is
// second_required; "Awaiting adjudication" = current round in conflict. The
// state is derived (decision log of the current round + the live second-review
// requirement), so candidates are narrowed in SQL (open, a FIRST — or for a
// conflict a SECOND — decision on the log, the caller's reach) and each page of
// candidates is classified in ONE batched pass (classifyCurrentRounds: the
// same rule as loadCurrentRoundDecisionState, proven equal in
// test/team-review-handoff.integration.test.ts). Same ordering, cursor and projection as
// every other queue; the scan is bounded, and a page cut short by the bound
// still hands back a cursor so paging continues.
// -----------------------------------------------------------------------------

const HANDOFF_SCAN_BATCH = 100;
const HANDOFF_SCAN_MAX = 1000;
/** Upper bound on candidates a handoff COUNT classifies (one batched pass). */
const HANDOFF_COUNT_CAP = 2000;

function handoffCandidateWhere(input: { teamId: string; meUserId: string; queue: ReviewerOpsHandoffQueueType }) {
  return {
    AND: [
      {
        teamId: input.teamId,
        status: { notIn: [...REVIEW_FINISHED_DB_STATUSES] },
        reviewDecisions: { some: { stage: input.queue === "AWAITING_SECOND_REVIEW" ? "FIRST" : "SECOND" } },
      },
      { evidence: evidenceVisibleThroughCasesWhere(input.meUserId) },
    ],
  };
}

function wantedRequirement(queue: ReviewerOpsHandoffQueueType): "second_review" | "adjudication" {
  return queue === "AWAITING_SECOND_REVIEW" ? "second_review" : "adjudication";
}

/**
 * How many reviews a handoff slice holds, under the same candidate filter and
 * the same batched classification as the list (one pass, capped).
 */
export async function countHandoffQueue(
  input: { teamId: string; meUserId: string; queue: ReviewerOpsHandoffQueueType },
  client: PrismaClient = defaultPrisma,
): Promise<{ count: number; capped: boolean }> {
  const candidates = await client.evidenceReviewWorkflow.findMany({
    where: handoffCandidateWhere(input) as never,
    select: { id: true, teamId: true, evidenceId: true, status: true, decisionRound: true },
    orderBy: { id: "asc" },
    take: HANDOFF_COUNT_CAP + 1,
  });
  const capped = candidates.length > HANDOFF_COUNT_CAP;
  if (capped) candidates.pop();
  const states = await classifyCurrentRounds(
    candidates.map((c) => ({ ...c, status: String(c.status) })),
    client,
  );
  const want = wantedRequirement(input.queue);
  let count = 0;
  for (const st of states.values()) if (handoffRequirementFor(st) === want) count += 1;
  return { count, capped };
}

async function listHandoffQueue(
  input: ReviewerOpsQueueInput & { queue: ReviewerOpsHandoffQueueType; limit: number },
  client: PrismaClient,
): Promise<{ rows: ReadonlyArray<ReviewerOpsQueueRow>; nextCursor: string | null }> {
  const want = wantedRequirement(input.queue);
  const where = handoffCandidateWhere(input);
  const scanMax = Math.min(Math.max(input.maxScan ?? HANDOFF_SCAN_MAX, 1), HANDOFF_SCAN_MAX);
  const kept: DbWorkflow[] = [];
  let cursor: string | null =
    typeof input.cursor === "string" && input.cursor.length > 0 ? input.cursor : null;
  let scanned = 0;
  let exhausted = false;
  while (kept.length <= input.limit && scanned < scanMax) {
    const take = Math.min(HANDOFF_SCAN_BATCH, scanMax - scanned);
    const batch: DbWorkflow[] = await client.evidenceReviewWorkflow.findMany({
      where: where as never,
      orderBy: REVIEW_QUEUE_ORDER,
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    // ONE batched classification per page of candidates (TEAM-SPEC perf pass).
    const states = await classifyCurrentRounds(
      batch.map((r) => ({
        id: r.id,
        teamId: r.teamId,
        evidenceId: r.evidenceId,
        status: String(r.status),
        decisionRound: r.decisionRound,
      })),
      client,
    );
    for (const row of batch) {
      scanned += 1;
      cursor = row.id;
      const st = states.get(row.id);
      if (st && handoffRequirementFor(st) === want) {
        kept.push(row);
        if (kept.length > input.limit) break;
      }
    }
    if (batch.length < take) {
      exhausted = kept.length <= input.limit;
      break;
    }
  }
  let nextCursor: string | null = null;
  if (kept.length > input.limit) {
    kept.pop();
    nextCursor = kept.length > 0 ? kept[kept.length - 1]!.id : cursor;
  } else if (!exhausted) {
    // The scan bound was reached before the end: continue from where it stopped.
    nextCursor = cursor;
  }
  const ids = kept.map((r) => r.id);
  const openEsc =
    ids.length === 0
      ? []
      : await client.reviewEscalation.findMany({
          where: {
            teamId: input.teamId,
            workflowId: { in: ids },
            status: { in: [...REVIEW_ESCALATION_ACTIVE_STATUSES] },
          },
          select: { workflowId: true },
        });
  const escSet = new Set(openEsc.map((e) => e.workflowId));
  const now = new Date();
  bump("reviewer_queue_viewed_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "reviewer_queue_viewed",
    severity: "INFO",
    details: { queue: input.queue, returned: kept.length, actorUserId: input.meUserId },
  });
  const keptWithFacts = await withReadTimeSlaFacts(kept, client);
  const assigneeIdentities = await loadReviewerIdentities(keptWithFacts.map((r) => r.assignedToUserId), client);
  return {
    rows: keptWithFacts.map((r) =>
      withAssigneeIdentity(buildWorkflowProjection(r, { hasOpenEscalation: escSet.has(r.id), nowUtc: now }), assigneeIdentities),
    ),
    nextCursor,
  };
}

// -----------------------------------------------------------------------------
// Dashboard projection
// -----------------------------------------------------------------------------

export type ReviewerOpsDashboard = {
  /** unit: reviews (T-052). */
  counts: Awaited<ReturnType<typeof legacyGetReviewQueueCounts>>;
  /** unit: escalations — active escalation rows, not reviews (COR-A). */
  openEscalations: number;
  /** unit: escalations */
  criticalEscalationsOpen: number;
  /** T-052 (stage C) — the unit of every figure, so no surface guesses. */
  units: { counts: "reviews"; openEscalations: "escalations"; criticalEscalationsOpen: "escalations" };
  /** T-085 (stage D) — each row carries the reviewer's display name / masked e-mail. */
  workloadTop: ReadonlyArray<WorkloadDashboardRow & ReviewerIdentityColumns>;
  suggestions: ReadonlyArray<ReviewerSuggestion & ReviewerIdentityColumns>;
};

type ReviewerIdentityColumns = { reviewerDisplayName: string | null; reviewerMaskedEmail: string | null };

export async function buildDashboard(
  input: { teamId: string; meUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewerOpsDashboard> {
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.REVIEWER_CONSOLE_LOAD,
    { "proovra.team_id": input.teamId, "proovra.operation": "reviewer_console_load" },
    () => buildDashboardInner(input, client),
  );
}

async function buildDashboardInner(
  input: { teamId: string; meUserId: string },
  client: PrismaClient,
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
          status: { in: [...REVIEW_ESCALATION_ACTIVE_STATUSES] },
          // PRO-R2-12 — WORKFLOW-003: an escalation on a closed record moves no count.
          workflow: { evidence: evidenceVisibleThroughCasesWhere(input.meUserId) },
        },
      }),
      client.reviewEscalation.count({
        where: {
          teamId: input.teamId,
          status: { in: [...REVIEW_ESCALATION_ACTIVE_STATUSES] },
          severity: "CRITICAL",
          workflow: { evidence: evidenceVisibleThroughCasesWhere(input.meUserId) },
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
  // T-085 (stage D) — names, never id fragments, in Monitoring → Workload.
  const identities = await loadReviewerIdentities(
    [...workloadTop.map((w) => w.reviewerUserId), ...suggestions.map((x) => x.reviewerUserId)],
    client,
  );
  return {
    counts,
    openEscalations: openEsc,
    criticalEscalationsOpen: critEsc,
    units: { counts: "reviews", openEscalations: "escalations", criticalEscalationsOpen: "escalations" },
    workloadTop: workloadTop.map((w) => withReviewerIdentity(w, identities)),
    suggestions: suggestions.map((x) => withReviewerIdentity(x, identities)),
  };
}

// -----------------------------------------------------------------------------
// Workspace (single review)
// -----------------------------------------------------------------------------

export const REVIEWER_VIEWER_ACTIONS = [
  "start",
  "pause",
  "resume",
  "request_info",
  "record_response",
  "approve",
  "reject",
  "reassign",
  "adjudicate",
  "archive",
  // Team remediation — T-009 (Reopen on the Review page) and T-019 (Escalate
  // availability computed by the server, like every other action).
  "reopen",
  "escalate",
  // Review remediation 2026-11-27 — the explicit independence request and the
  // formal challenge are offered by the same server projection.
  "request_independent_review",
  "challenge",
] as const;
export type ReviewerViewerAction = (typeof REVIEWER_VIEWER_ACTIONS)[number];

export type ReviewerViewerProjection = {
  userId: string;
  isAssignee: boolean;
  actions: ReadonlyArray<{ action: ReviewerViewerAction; allowed: boolean; reason?: string }>;
  /** 2026-11-27 — recorded decisions of the current round this viewer may challenge. */
  challengeableDecisionIds?: string[];
};

export type ReviewerOpsWorkspaceProjection = {
  projection: ReviewerOpsWorkflowProjection;
  /**
   * The GOVERNING active escalation (T-049): highest severity, then newest.
   * Acknowledged and reassigned escalations are active.
   */
  openEscalation: EscalationProjection | null;
  /** unit: escalations — how many are active on this review (T-049). */
  activeEscalationCount: number;
  allowedLifecycleTransitions: ReadonlyArray<ReviewerOpsLifecycleState>;
  /** TEAM-SPEC §2.5 — present when the caller states who is viewing. */
  viewer?: ReviewerViewerProjection;
  /**
   * TEAM-SPEC R3 — the second-review / adjudication handoff: what the current
   * round still needs, whether anyone is eligible to do it, and a staffing
   * explanation when nobody is. Present when the caller states who is viewing.
   */
  handoff?: ReviewHandoff;
};

/** What the route proved about the viewer (role + capability set). */
export type ReviewerViewerFacts = {
  isReviewerCapable: boolean;
  /** Holds `review.assign`. */
  mayAssign: boolean;
  /** Canonical workspace role of the ACTIVE member. */
  role: string | null;
};

/**
 * TEAM-SPEC §2.5 — the actions THIS viewer may take now, each with the reason
 * the server would give when refusing it. Mirrors the engine and the decision
 * authority rule for rule (lifecycle matrix, assignment, decision stage,
 * independence, adjudicator role); the server still decides on submit.
 */
export function computeViewerActions(input: {
  row: DbWorkflow;
  lifecycle: ReviewerOpsLifecycleState;
  viewerUserId: string;
  facts: ReviewerViewerFacts;
  decision: CurrentRoundDecisionState;
  assignmentsIncluded: boolean;
  /** REVIEW_ESCALATION in the effective plan (escalate is a Team capability). Absent = included. */
  escalationIncluded?: boolean;
  /** The review was handed over to its assignee (reviewWasHandedOver). Absent = not. */
  handedOver?: boolean;
  /** 2026-11-27 — current-round decisions recorded by someone else (challengeable). */
  challengeableDecisionIds?: ReadonlyArray<string>;
}): ReviewerViewerProjection {
  const { row, lifecycle, viewerUserId, facts, decision } = input;
  const isAssignee = !!row.assignedToUserId && row.assignedToUserId === viewerUserId;
  const stage = mapDbStatusToReviewStage(String(row.status));
  const finished = !isReviewOpenDbStatus(String(row.status)) || !!row.completedAtUtc || !!row.closedAt;
  const isAdjudicatorRole = facts.role === "OWNER" || facts.role === "ADMIN";

  // Round 2 (2026-11-25, divergences #2 / #3) — the verdict's stage rule is the
  // AUTHORITY'S (verdictStageRefusal over the PERSISTED stage), not the derived
  // lifecycle: a reopened review, or an escalated one nobody has started, no
  // longer shows an Approve / Reject the server then refuses.
  const verdict = (to: ReviewerOpsLifecycleState, kind: "APPROVE" | "REJECT" | "REQUEST_INFO"): string | null => {
    if (!facts.isReviewerCapable) return "reviewer_required";
    const stageRefusal = verdictStageRefusal(stage, kind);
    if (stageRefusal) return stageRefusal;
    if (!isAllowedLifecycleTransition(lifecycle, to)) return "decision_not_from_stage";
    switch (decision.state) {
      case "resolved":
        return "review_already_resolved";
      case "first_required":
        return isAssignee ? null : "not_assignee";
      case "second_required":
        if (decision.firstReviewerUserId === viewerUserId) return "same_reviewer_blocked";
        return isAssignee ? null : "second_stage_needs_reassignment";
      default:
        return "use_adjudication";
    }
  };
  const clock = (wantPaused: boolean): string | null => {
    if (!facts.isReviewerCapable) return "reviewer_required";
    if (finished) return "review_finished";
    if (row.assignedToUserId && !isAssignee && !facts.mayAssign) return "not_assignee";
    // T-021 — only an assignment manager stops an unassigned review's clock.
    if (!row.assignedToUserId && !facts.mayAssign) return "review_assign_required";
    if (wantPaused && !row.slaPausedAtUtc) return "not_paused";
    if (!wantPaused && row.slaPausedAtUtc) return "already_paused";
    return null;
  };
  const reasons: Record<ReviewerViewerAction, string | null> = {
    // T-020 — Start is offered only for a review that has not started: the
    // PERSISTED stage, not the lifecycle an open escalation derives (an
    // in-review review with an escalation offered a no-op "Start review").
    // Round 2 (divergence #4) — Start is offered exactly when the PERSISTED
    // stage may move to IN_REVIEW under the canonical stage rule (the rule
    // startReview and the Evidence page's Begin review apply): an escalated,
    // response-received or needs-information review can be taken back into
    // review; an in-review one cannot be "started" again (T-020).
    start: !facts.isReviewerCapable
      ? "reviewer_required"
      : reviewStartRefusal(stage, !!input.handedOver) === "already_started"
        ? "already_started"
        : reviewStartRefusal(stage, !!input.handedOver) !== null || !isAllowedLifecycleTransition(lifecycle, "IN_REVIEW")
          ? "invalid_transition"
          : !isAssignee
            ? "not_assignee"
            : null,
    pause: clock(false),
    resume: clock(true),
    request_info: verdict("NEEDS_INFORMATION", "REQUEST_INFO"),
    record_response: !facts.isReviewerCapable
      ? "reviewer_required"
      : !isAssignee
        ? "not_assignee"
        : stage !== "NEEDS_MORE_INFO"
          ? "not_awaiting_information"
          : null,
    approve: verdict("APPROVED", "APPROVE"),
    reject: verdict("REJECTED", "REJECT"),
    reassign: !input.assignmentsIncluded
      ? "reviewer_operations_not_included"
      : !facts.isReviewerCapable
        ? "reviewer_required"
        : !facts.mayAssign
          ? "review_assign_required"
          : finished || lifecycle === "APPROVED" || lifecycle === "REJECTED" || lifecycle === "ARCHIVED"
            ? "review_finished"
            : null,
    adjudicate:
      decision.state !== "conflict_detected"
        ? "no_conflict"
        : !facts.isReviewerCapable
          ? "reviewer_required"
          : !isAdjudicatorRole
            ? "adjudicator_role_required"
            : decision.firstReviewerUserId === viewerUserId || decision.secondReviewerUserId === viewerUserId
              ? "adjudicator_not_independent"
              : null,
    // Round 2 (divergence #2) — archive is the lifecycle Close: the canonical
    // stage rule decides it, as precheckLifecycleTransition does.
    archive: !facts.isReviewerCapable
      ? "reviewer_required"
      : !isAllowedLifecycleTransition(lifecycle, "ARCHIVED") || stageMoveRefusal(stage, "CLOSED") !== null
        ? "invalid_transition"
        : decision.state === "second_required" || decision.state === "conflict_detected"
          ? "second_review_pending"
          : null,
    // T-009 — a finished review is reopened by the same people and the same
    // transition the Evidence page uses (REJECTED/APPROVED/CLOSED → REOPENED).
    reopen: !facts.isReviewerCapable
      ? "reviewer_required"
      : stageMoveRefusal(stage, "REOPENED") !== null
        ? "review_not_finished"
        : null,
    // T-019 — raising an escalation stays open to every reviewer-capable
    // member (ADDENDUM §4.2) on an open review, with no step-up.
    escalate:
      input.escalationIncluded === false
        ? "review_escalation_not_included"
        : !facts.isReviewerCapable
          ? "reviewer_required"
          : finished
            ? "review_finished"
            : null,
    // 2026-11-27 — an explicit, auditable request for an independent second
    // decision (BEHAVIOUR-SPEC §2.1). Not offered when the round already waits
    // for one or cannot take one.
    request_independent_review:
      input.escalationIncluded === false
        ? "review_escalation_not_included"
        : !facts.isReviewerCapable
          ? "reviewer_required"
          : finished
            ? "review_finished"
            : decision.secondReviewRequired || decision.state !== "first_required"
              ? "independent_review_already_required"
              : null,
    // F-07 — a challenge is offered only for a recorded decision this viewer
    // did not make (the server refuses the rest: DISAGREEMENT_SELF_FILE / NOT_FOUND).
    challenge: !facts.isReviewerCapable
      ? "reviewer_required"
      : (input.challengeableDecisionIds?.length ?? 0) === 0
        ? "no_challengeable_decision"
        : null,
  };
  return {
    userId: viewerUserId,
    isAssignee,
    challengeableDecisionIds: [...(input.challengeableDecisionIds ?? [])],
    actions: REVIEWER_VIEWER_ACTIONS.map((action) => {
      const reason = reasons[action];
      return reason ? { action, allowed: false, reason } : { action, allowed: true };
    }),
  };
}

export async function getReviewerOpsWorkspace(
  input: { teamId: string; workflowId: string; viewerUserId: string; viewerFacts?: ReviewerViewerFacts },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewerOpsWorkspaceProjection> {
  const row = await client.evidenceReviewWorkflow.findFirst({
    where: {
      id: input.workflowId,
      teamId: input.teamId,
      evidence: evidenceVisibleThroughCasesWhere(input.viewerUserId),
    },
  });
  if (!row) throw new ReviewerOpsError("REVIEW_WORKFLOW_NOT_FOUND");
  const { top: open, activeCount } = await findActiveEscalationSummaryForWorkflow(
    { teamId: input.teamId, workflowId: row.id },
    client,
  );
  const projection = buildWorkflowProjection((await withReadTimeSlaFacts([row], client))[0]!, {
    hasOpenEscalation: !!open,
  });
  // Allowed transitions = the shared lifecycle matrix for the current
  // lifecycle state. The route layer enforces step-up where needed.
  const { listAllowedLifecycleTransitions } = await import("@proovra/shared");
  const allowed = listAllowedLifecycleTransitions(projection.lifecycleState);
  let viewer: ReviewerViewerProjection | undefined;
  let handoff: ReviewHandoff | undefined;
  if (input.viewerFacts && row.teamId) {
    const [decision, assignmentsIncluded, escalationIncluded] = await Promise.all([
      loadCurrentRoundDecisionState(
        {
          id: row.id,
          teamId: row.teamId,
          evidenceId: row.evidenceId,
          status: String(row.status),
          decisionRound: row.decisionRound,
        },
        client,
      ),
      workspaceIncludesReviewCapability(input.teamId, "REVIEW_ASSIGNMENTS"),
      workspaceIncludesReviewCapability(input.teamId, "REVIEW_ESCALATION"),
    ]);
    viewer = computeViewerActions({
      row,
      lifecycle: projection.lifecycleState,
      viewerUserId: input.viewerUserId,
      facts: input.viewerFacts,
      decision,
      assignmentsIncluded,
      escalationIncluded,
      handedOver: await reviewHandedOver(row, client),
      challengeableDecisionIds: (
        await client.workflowReviewDecision.findMany({
          where: { workflowId: row.id, round: row.decisionRound, reviewerUserId: { not: input.viewerUserId } },
          select: { id: true },
          orderBy: { decidedAt: "asc" },
        })
      ).map((d) => d.id),
    });
    handoff = await computeReviewHandoff(row, decision, client);
  }
  return {
    projection,
    openEscalation: open,
    activeEscalationCount: activeCount,
    allowedLifecycleTransitions: allowed,
    ...(viewer ? { viewer } : {}),
    ...(handoff ? { handoff } : {}),
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
  /** Holds `review.assign`, so may act on a review held by someone else. */
  mayActOnOthersReviews?: boolean;
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

/**
 * Every lifecycle action loads its workflow here, so reach is decided where the
 * row is read and no route can act on a record it cannot open: a record closed
 * by a restricted case answers exactly like a missing workflow (WORKFLOW-003).
 */
async function loadWorkflowOrThrow(
  ctx: LifecycleActorContext,
  workflowId: string,
  client: PrismaClient,
): Promise<DbWorkflow> {
  const row = await client.evidenceReviewWorkflow.findFirst({
    where: {
      id: workflowId,
      teamId: ctx.teamId,
      evidence: evidenceVisibleThroughCasesWhere(ctx.actorUserId),
    },
  });
  if (!row) throw new ReviewerOpsError("REVIEW_WORKFLOW_NOT_FOUND");
  return row;
}

/**
 * Track 1C — invoke the canonical decision authority and translate its
 * error surface into the Phase 25 ReviewerOpsError catalog so the
 * route-layer status mapping stays unchanged.
 */
async function recordDecisionViaAuthority(
  input: Parameters<typeof recordCanonicalReviewDecision>[0],
  client: PrismaClient,
): Promise<Awaited<ReturnType<typeof recordCanonicalReviewDecision>>> {
  try {
    return await recordCanonicalReviewDecision({ source: "legacy_reviewer_ops", ...input }, client);
  } catch (err) {
    if (err instanceof ReviewDecisionAuthorityError) {
      switch (err.code) {
        case "workflow_not_found":
          throw new ReviewerOpsError("REVIEW_WORKFLOW_NOT_FOUND");
        // T-010 — the same input refusals as the canonical door, with the
        // authority code as details.reason (status 400 at the route).
        case "rationale_required":
        case "rationale_too_long":
          throw new ReviewerOpsError("REVIEW_NOTE_REQUIRED", { ...(err.details ?? {}), reason: err.code });
        case "forbidden_wording":
          throw new ReviewerOpsError("REVIEW_PERMISSION_DENIED", { reason: "forbidden_wording" });
        // TEAM-SPEC R3 — the decision belongs to the assignee
        // (not_assignee, second_stage_needs_reassignment).
        case "adjudicator_role_required":
        case "reviewer_required":
        case "not_assignee":
        case "second_stage_needs_reassignment":
          throw new ReviewerOpsError("REVIEW_PERMISSION_DENIED", {
            ...(err.details ?? {}),
            reason: err.code,
          });
        default:
          // stale_decision / review_already_resolved /
          // duplicate_stage_decision / same_reviewer_blocked /
          // decision_kind_not_allowed / use_adjudication /
          // decision_not_from_stage → conflict (409 at the route). The
          // authority's own code is the reason; a sub-reason it carried
          // (e.g. stale_decision's concurrent_change) stays as `detail`.
          throw new ReviewerOpsError("REVIEW_INVALID_TRANSITION", {
            ...(err.details ?? {}),
            ...(err.details && typeof err.details.reason === "string" && err.details.reason !== err.code
              ? { detail: err.details.reason }
              : {}),
            reason: err.code,
          });
      }
    }
    throw err;
  }
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
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.REVIEWER_ASSIGNMENT_CREATE,
    {
      "proovra.team_id": ctx.teamId,
      "proovra.operation": "reviewer_assignment_create",
    },
    () => assignReviewerToWorkflowInner(ctx, input, client),
  );
}

async function assignReviewerToWorkflowInner(
  ctx: LifecycleActorContext,
  input: { workflowId: string; assignedToUserId: string; note?: string | null },
  client: PrismaClient,
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
    throw new ReviewerOpsError("REVIEW_INVALID_TRANSITION", { reason: "review_finished", fromLc });
  }
  // TEAM-SPEC §2.6 — while the round awaits its SECOND decision, the review
  // cannot be handed back to the reviewer who made the FIRST one: the second
  // review must be independent. (Eligibility of the assignee — permission and
  // placement — is still decided by the assignment service below; an
  // assignment never grants a permission.)
  if (row.teamId) {
    const round = await loadCurrentRoundDecisionState(
      {
        id: row.id,
        teamId: row.teamId,
        evidenceId: row.evidenceId,
        status: String(row.status),
        decisionRound: row.decisionRound,
      },
      client,
    );
    if (round.state === "second_required" && round.firstReviewerUserId === input.assignedToUserId) {
      throw new ReviewerOpsError("REVIEW_ASSIGNEE_NOT_ELIGIBLE", {
        reason: "second_reviewer_not_independent",
      });
    }
  }
  // A refused move (a concurrent change committed between the read and the
  // conditional write — 2026-10-24) is an expected 409 refusal in this
  // engine's vocabulary, never an unmapped 500 reported to Sentry.
  const updated = await legacyAssignReviewer(
    {
      evidenceId: row.evidenceId,
      assignedToUserId: input.assignedToUserId,
      actorUserId: ctx.actorUserId,
      note: input.note ?? null,
    },
    client,
  ).catch((err: unknown) => {
    if (err instanceof ReviewOperationError) {
      if (err.code === "workflow_not_found") throw new ReviewerOpsError("REVIEW_WORKFLOW_NOT_FOUND");
      if (err.code === "assignee_not_eligible") throw new ReviewerOpsError("REVIEW_ASSIGNEE_NOT_ELIGIBLE", { reason: "assignee_not_eligible" });
      if (err.code === "assignee_not_placed") throw new ReviewerOpsError("REVIEW_ASSIGNEE_NOT_PLACED", { reason: "assignee_not_placed" });
      bump("reviewer_invalid_transition_blocked_total");
      throw new ReviewerOpsError("REVIEW_INVALID_TRANSITION", { fromLc, reason: err.code });
    }
    throw err;
  });
  // The deadlines were stamped inside the assignment's transaction
  // (`stampReviewDeadlines`). This records which layer set them, once, on the
  // first assignment. Audit must never break the assignment lifecycle.
  if (!row.assignedAtUtc) {
    const resolved = await resolveReviewPolicyForEvidence(
      { teamId: ctx.teamId, evidenceId: updated.evidenceId },
      client,
    );
    const sourceLabel: "template_override" | "team_default" | "platform_baseline" =
      resolved?.templateOverridden
        ? "template_override"
        : resolved?.stated
          ? "team_default"
          : "platform_baseline";
    try {
      await emitTenantAudit(
        {
          action: "reviewer.sla_policy.resolve",
          outcome: "success",
          sourceApp: "API",
          actorUserId: ctx.actorUserId,
          workspaceId: ctx.teamId,
          resourceType: "review_workflow",
          resourceId: updated.id,
          metadata: {
            workflowId: updated.id,
            templateId: resolved?.templateResolution.templateId ?? null,
            templateResolutionSource: resolved?.templateResolution.source ?? "error",
            source: sourceLabel,
            completionHours:
              resolved?.policy.completionHours ?? REVIEWER_OPS_DEFAULT_SLA_POLICY.completionHours,
          },
        },
        client,
      );
    } catch (err) {
      logWarn("reviewer_ops.sla_policy_audit_failed", {
        workflowId: updated.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
  await emitTenantAudit(
    {
      action: isReassignment ? "reviewer.reassign" : "reviewer.assign",
      outcome: "success",
      sourceApp: "API",
      actorUserId: ctx.actorUserId,
      workspaceId: ctx.teamId,
      resourceType: "review_workflow",
      resourceId: row.id,
      metadata: {
        newAssignee: input.assignedToUserId,
      },
    },
    client,
  );
  return projectWorkflow(updated, client, {
    hasOpenEscalation: await findOpenEscalationForWorkflow(
      { teamId: ctx.teamId, workflowId: row.id },
      client,
    ).then((e) => !!e),
  });
}

// ----- startReview ------------------------------------------------------------

/**
 * The handover fact for reviewStartRefusal: only an in-review review with an
 * assignee can have been handed over; it was if the latest recorded Start is
 * someone else's (reviewWasHandedOver).
 */
async function reviewHandedOver(
  row: Pick<DbWorkflow, "id" | "status" | "assignedToUserId">,
  client: PrismaClient,
): Promise<boolean> {
  if (String(row.status) !== "IN_REVIEW" || !row.assignedToUserId) return false;
  const latest = await client.evidenceReviewWorkflowEvent.findFirst({
    where: { workflowId: row.id, eventType: "REVIEW_STARTED" },
    orderBy: { createdAt: "desc" },
    select: { actorUserId: true },
  });
  return reviewWasHandedOver({ assignedToUserId: row.assignedToUserId, latestStartActorUserId: latest?.actorUserId });
}

export async function startReview(
  ctx: LifecycleActorContext,
  input: { workflowId: string },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewerOpsWorkflowProjection> {
  requireHuman(ctx);
  const row = await loadWorkflowOrThrow(ctx, input.workflowId, client);
  const fromLc = await currentLifecycle(ctx, row, client);
  assertLifecycleTransition(fromLc, "IN_REVIEW");
  // Round 2 (2026-11-25) — the canonical stage rule, the same one the Evidence
  // page's Begin review and the action projection apply: the PERSISTED stage
  // must be able to move to IN_REVIEW, and Start on an in-review review is
  // refused, not a silent rewrite.
  // A handed-over in-review review (the second reviewer after a FIRST verdict,
  // a new assignee after a reassignment) may be started by its new assignee.
  const startRefusal = reviewStartRefusal(
    mapDbStatusToReviewStage(String(row.status)),
    await reviewHandedOver(row, client),
  );
  if (startRefusal) {
    bump("reviewer_invalid_transition_blocked_total");
    throw new ReviewerOpsError("REVIEW_INVALID_TRANSITION", {
      from: fromLc,
      to: "IN_REVIEW",
      reason: startRefusal,
    });
  }
  if (row.assignedToUserId !== ctx.actorUserId) {
    throw new ReviewerOpsError("REVIEW_PERMISSION_DENIED", {
      reason: "actor_not_assignee",
    });
  }
  const now = new Date();
  // The move, its workflow event and its audit entry together (2026-10-24:
  // it used to write the status alone, invisible to the Review history).
  // CONDITIONAL (2026-10-24): the move applies only to the state this call
  // read, so a Close (or any move) that committed meanwhile is never undone
  // by a Start that read the earlier state — it is refused instead.
  const updated = await client.$transaction(async (tx) => {
    const claimed = await tx.evidenceReviewWorkflow.updateMany({
      where: { id: row.id, status: row.status },
      data: {
        status: "IN_REVIEW",
        lastReviewedAt: now,
      },
    });
    if (claimed.count !== 1) {
      bump("reviewer_invalid_transition_blocked_total");
      throw new ReviewerOpsError("REVIEW_INVALID_TRANSITION", { from: fromLc, to: "IN_REVIEW", reason: "concurrent_change" });
    }
    const moved = await tx.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: row.id } });
    await tx.evidenceReviewWorkflowEvent.create({
      data: {
        workflowId: row.id,
        evidenceId: row.evidenceId,
        actorUserId: ctx.actorUserId,
        eventType: "REVIEW_STARTED",
        previousValue: { status: row.status },
        nextValue: { status: "IN_REVIEW" },
        note: null,
      },
    });
    await recordReviewActivityTx(tx, {
      evidenceId: row.evidenceId,
      workflowId: row.id,
      teamId: ctx.teamId,
      actorUserId: ctx.actorUserId,
      code: "REVIEW_WORKFLOW_STATE_CHANGED",
      previousState: String(row.status),
      resultingState: "IN_REVIEW",
    });
    return moved;
  });
  bump("reviewer_review_started_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "reviewer_review_started",
    severity: "INFO",
    details: { workflowId: row.id, actorUserId: ctx.actorUserId },
  });
  return projectWorkflow(updated, client);
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
  assertMayChangeSlaClock(ctx, row);
  if (row.slaPausedAtUtc) {
    bump("reviewer_invalid_transition_blocked_total");
    throw new ReviewerOpsError("REVIEW_INVALID_TRANSITION", { reason: "already_paused" });
  }
  const now = new Date();
  // The pause, its workflow event and its audit entry together (2026-10-24):
  // it used to write the row alone, invisible to the Review history and the
  // tenant audit.
  const updated = await client.$transaction(async (tx) => {
    // Conditional on the state read: a Close that landed meanwhile refuses this.
    const claimed = await tx.evidenceReviewWorkflow.updateMany({
      where: { id: row.id, status: row.status, slaPausedAtUtc: null },
      data: {
        slaPausedAtUtc: now,
        pausedReason: input.pausedReason.trim().slice(0, 400),
        slaStatus: row.slaStatus ? "PAUSED" : null,
      },
    });
    if (claimed.count !== 1) {
      bump("reviewer_invalid_transition_blocked_total");
      throw new ReviewerOpsError("REVIEW_INVALID_TRANSITION", { reason: "concurrent_change" });
    }
    const paused = await tx.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: row.id } });
    await tx.evidenceReviewWorkflowEvent.create({
      data: {
        workflowId: row.id,
        evidenceId: row.evidenceId,
        actorUserId: ctx.actorUserId,
        eventType: "SLA_UPDATED",
        previousValue: { slaPausedAtUtc: row.slaPausedAtUtc?.toISOString() ?? null },
        nextValue: { slaPausedAtUtc: now.toISOString() },
        note: input.pausedReason.trim().slice(0, 1000),
      },
    });
    await recordReviewActivityTx(tx, {
      evidenceId: row.evidenceId,
      workflowId: row.id,
      teamId: ctx.teamId,
      actorUserId: ctx.actorUserId,
      code: "REVIEW_SLA_CHANGED",
      previousState: String(row.status),
      resultingState: String(paused.status),
    });
    return paused;
  });
  bump("reviewer_review_paused_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "reviewer_review_paused",
    severity: "INFO",
    details: { workflowId: row.id, actorUserId: ctx.actorUserId },
  });
  return projectWorkflow(updated, client);
}

/**
 * Pausing stops a review's clock, so it is refused on a finished review, and on a
 * review held by someone else unless the actor can reassign it (WORKFLOW-011).
 */
function assertMayChangeSlaClock(ctx: LifecycleActorContext, row: DbWorkflow): void {
  if (!isReviewOpenDbStatus(String(row.status)) || row.completedAtUtc || row.closedAt) {
    bump("reviewer_invalid_transition_blocked_total");
    throw new ReviewerOpsError("REVIEW_INVALID_TRANSITION", { reason: "review_finished" });
  }
  if (
    row.assignedToUserId &&
    row.assignedToUserId !== ctx.actorUserId &&
    !ctx.mayActOnOthersReviews
  ) {
    throw new ReviewerOpsError("REVIEW_PERMISSION_DENIED", { reason: "actor_not_assignee" });
  }
  // T-021 — an UNASSIGNED review clock is the assignment managers' to stop:
  // any reviewer could pause one and stop its SLA clock.
  if (!row.assignedToUserId && !ctx.mayActOnOthersReviews) {
    throw new ReviewerOpsError("REVIEW_PERMISSION_DENIED", { reason: "review_assign_required" });
  }
}

// ----- resumeReview -----------------------------------------------------------

/**
 * The way out of a pause (WORKFLOW-011). The clock stopped, so each deadline still
 * open moves later by exactly the time spent paused, and the status is recomputed
 * from the moved dates in the same write.
 */
export async function resumeReview(
  ctx: LifecycleActorContext,
  input: { workflowId: string; note?: string | null },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewerOpsWorkflowProjection> {
  requireHuman(ctx);
  if (input.note && stringContainsForbiddenOverclaim(input.note)) {
    throw new ReviewerOpsError("REVIEW_PERMISSION_DENIED", { reason: "forbidden_wording" });
  }
  const row = await loadWorkflowOrThrow(ctx, input.workflowId, client);
  assertMayChangeSlaClock(ctx, row);
  const pausedAt = row.slaPausedAtUtc;
  if (!pausedAt) {
    bump("reviewer_invalid_transition_blocked_total");
    throw new ReviewerOpsError("REVIEW_INVALID_TRANSITION", { reason: "not_paused" });
  }
  const now = new Date();
  // First review is met by the first recorded DECISION, never by Start (stage C
  // semantics; before 2026-11-25 a started-but-undecided review kept its
  // first-review deadline unmoved across the pause and read overdue on resume).
  // A decision recorded before first_decided_at_utc existed comes from the log.
  const [facts] = await withReadTimeSlaFacts([row], client, { stampedAfter: false });
  const heldMs = Math.max(now.getTime() - pausedAt.getTime(), 0);
  const moved = (d: Date | null, met: boolean = false) =>
    d && !met ? new Date(d.getTime() + heldMs) : d;
  const next = {
    assignmentDueAtUtc: moved(row.assignmentDueAtUtc, Boolean(row.assignedAtUtc)),
    firstResponseDueAtUtc: moved(row.firstResponseDueAtUtc, Boolean(facts?.firstDecidedAtUtc ?? row.firstDecidedAtUtc)),
    completionDueAtUtc: moved(row.completionDueAtUtc),
    dueAt: moved(row.dueAt),
    escalationDueAtUtc: moved(row.escalationDueAtUtc, Boolean(row.escalatedAtUtc)),
  };
  const slaStatus = storedReviewSlaStatus({ ...(facts ?? row), ...next, slaPausedAtUtc: null }, { nowUtc: now });
  const updated = await client.$transaction(async (tx) => {
    const claimed = await tx.evidenceReviewWorkflow.updateMany({
      where: { id: row.id, status: row.status, slaPausedAtUtc: pausedAt },
      data: { ...next, slaPausedAtUtc: null, pausedReason: null, slaStatus },
    });
    if (claimed.count !== 1) {
      bump("reviewer_invalid_transition_blocked_total");
      throw new ReviewerOpsError("REVIEW_INVALID_TRANSITION", { reason: "concurrent_change" });
    }
    const resumed = await tx.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: row.id } });
    await tx.evidenceReviewWorkflowEvent.create({
      data: {
        workflowId: row.id,
        evidenceId: row.evidenceId,
        actorUserId: ctx.actorUserId,
        eventType: "SLA_UPDATED",
        previousValue: {
          slaPausedAtUtc: pausedAt.toISOString(),
          pausedReason: row.pausedReason,
          dueAt: row.dueAt?.toISOString() ?? null,
        },
        nextValue: {
          slaPausedAtUtc: null,
          heldSeconds: Math.round(heldMs / 1000),
          dueAt: resumed.dueAt?.toISOString() ?? null,
        },
        note: input.note?.trim().slice(0, 1000) || null,
      },
    });
    await recordReviewActivityTx(tx, {
      evidenceId: row.evidenceId,
      workflowId: row.id,
      teamId: ctx.teamId,
      actorUserId: ctx.actorUserId,
      code: "REVIEW_SLA_CHANGED",
      previousState: String(row.status),
      resultingState: String(resumed.status),
    });
    return resumed;
  });
  bump("reviewer_review_resumed_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "reviewer_review_resumed",
    severity: "INFO",
    details: { workflowId: row.id, actorUserId: ctx.actorUserId },
  });
  return projectWorkflow(updated, client);
}

// ----- Decision outcome (TEAM-SPEC §2.3) --------------------------------------

export type ReviewerOpsDecisionOutcome = {
  stageRecorded: "FIRST" | "SECOND" | "ADJUDICATION" | "NONE";
  statusChanged: boolean;
  reviewState: string;
  nextRequirement: "second_review" | "adjudication" | "information" | null;
  idempotent: boolean;
  /** T-015 — the second-review cause and staffing, when the round waits for one. */
  secondReview?: ReviewDecisionOutcome["secondReview"];
};

export type ReviewerOpsDecisionResult = {
  projection: ReviewerOpsWorkflowProjection;
  outcome: ReviewerOpsDecisionOutcome;
};

/**
 * The authority's outcome, or — for a narrow client that returned none — the
 * same facts derived from what it did return.
 */
function outcomeOf(
  result: {
    workflow: DbWorkflow;
    decision: { stage?: string } | null;
    state: string;
    idempotent: boolean;
    previousStatus?: string;
    outcome?: ReviewerOpsDecisionOutcome;
  },
  statusBefore: string,
): ReviewerOpsDecisionOutcome {
  if (result.outcome) return result.outcome;
  const state = result.state;
  return {
    stageRecorded: (result.decision?.stage as ReviewerOpsDecisionOutcome["stageRecorded"]) ?? "FIRST",
    statusChanged: !result.idempotent && String(result.workflow.status) !== (result.previousStatus ?? statusBefore),
    reviewState: state,
    nextRequirement:
      state === "second_required"
        ? "second_review"
        : state === "conflict_detected" || state === "adjudication_required"
          ? "adjudication"
          : null,
    idempotent: result.idempotent,
  };
}

/**
 * The outcome signals now live in ./decision-outcome-signals.ts and are
 * emitted ONCE by the decision authority for every door (T-171). Re-exported
 * for existing importers.
 */
export { emitDecisionOutcomeSignals } from "./decision-outcome-signals.js";

// ----- requestInformation -----------------------------------------------------

export async function requestInformation(
  ctx: LifecycleActorContext,
  input: { workflowId: string; note: string },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewerOpsDecisionResult> {
  requireHuman(ctx);
  assertDecisionInput(input.note);
  const row = await loadWorkflowOrThrow(ctx, input.workflowId, client);
  const fromLc = await currentLifecycle(ctx, row, client);
  assertLifecycleTransition(fromLc, "NEEDS_INFORMATION", "decision_not_from_stage");
  const result = await recordDecisionViaAuthority(
    {
      workflowId: row.id,
      teamId: ctx.teamId,
      actorUserId: ctx.actorUserId,
      decision: "REQUEST_INFO",
      rationale: input.note,
    },
    client,
  );
  const updated = result.workflow;
  const outcome = outcomeOf(result, String(row.status));
  // The authority emitted the outcome signals (T-171).
  return { projection: await projectWorkflow(updated, client), outcome };
}

// ----- recordResponseReceived (TEAM-SPEC §2.4) --------------------------------

/**
 * The way out of NEEDS_INFORMATION: the assignee records that the requested
 * information arrived. NEEDS_MORE_INFO → RESPONSE_RECEIVED (the stage matrix in
 * @proovra/shared review-operations), conditional on the state and the
 * assignment read, with its workflow event and audit in one transaction.
 */
export async function recordResponseReceived(
  ctx: LifecycleActorContext,
  input: { workflowId: string; note?: string | null },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewerOpsWorkflowProjection> {
  requireHuman(ctx);
  if (input.note && stringContainsForbiddenOverclaim(input.note)) {
    throw new ReviewerOpsError("REVIEW_PERMISSION_DENIED", { reason: "forbidden_wording" });
  }
  const row = await loadWorkflowOrThrow(ctx, input.workflowId, client);
  if (row.assignedToUserId !== ctx.actorUserId) {
    throw new ReviewerOpsError("REVIEW_PERMISSION_DENIED", { reason: "not_assignee" });
  }
  const stage = mapDbStatusToReviewStage(String(row.status));
  if (stage !== "NEEDS_MORE_INFO") {
    bump("reviewer_invalid_transition_blocked_total");
    throw new ReviewerOpsError("REVIEW_INVALID_TRANSITION", {
      reason: "not_awaiting_information",
      currentStage: stage,
    });
  }
  const note = input.note?.trim().slice(0, 1000) || null;
  const updated = await client.$transaction(async (tx) => {
    const claimed = await tx.evidenceReviewWorkflow.updateMany({
      where: { id: row.id, status: row.status, assignedToUserId: ctx.actorUserId },
      data: { status: "RESPONSE_RECEIVED", lastReviewedAt: new Date() },
    });
    if (claimed.count !== 1) {
      bump("reviewer_invalid_transition_blocked_total");
      throw new ReviewerOpsError("REVIEW_INVALID_TRANSITION", { reason: "stale_decision", detail: "concurrent_change" });
    }
    const moved = await tx.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: row.id } });
    await tx.evidenceReviewWorkflowEvent.create({
      data: {
        workflowId: row.id,
        evidenceId: row.evidenceId,
        actorUserId: ctx.actorUserId,
        eventType: "RESPONSE_RECEIVED",
        previousValue: { stage: "NEEDS_MORE_INFO", status: String(row.status) },
        nextValue: { stage: "RESPONSE_RECEIVED", status: "RESPONSE_RECEIVED" },
        note,
      },
    });
    await recordReviewActivityTx(tx, {
      evidenceId: row.evidenceId,
      workflowId: row.id,
      teamId: ctx.teamId,
      actorUserId: ctx.actorUserId,
      code: "REVIEW_WORKFLOW_STATE_CHANGED",
      previousState: String(row.status),
      resultingState: "RESPONSE_RECEIVED",
    });
    return moved;
  });
  // Best effort, never undoes the move.
  await notifyReviewResponseReceived({ workflow: updated, actorUserId: ctx.actorUserId }, client).catch(() => null);
  const open = await findOpenEscalationForWorkflow({ teamId: ctx.teamId, workflowId: row.id }, client);
  return projectWorkflow(updated, client, { hasOpenEscalation: !!open });
}

// ----- authorization before step-up (round 2, 2026-11-25) --------------------

/**
 * Every check approve / reject run before they record — the engine's own (human
 * actor, note, reach, lifecycle) and then the canonical authority as a dry run —
 * WITHOUT recording. The doors call it before the step-up gate so a verdict that
 * would be refused is refused first and spends no challenge. Throws the same
 * ReviewerOpsError the real call would; resolves when it would be accepted.
 */
export async function precheckReviewVerdict(
  ctx: LifecycleActorContext,
  input: { workflowId: string; verdict: "APPROVE" | "REJECT"; note?: string | null },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  requireHuman(ctx);
  const note = input.verdict === "REJECT" ? (input.note ?? "") : (input.note ?? null);
  assertDecisionInput(note);
  const row = await loadWorkflowOrThrow(ctx, input.workflowId, client);
  const fromLc = await currentLifecycle(ctx, row, client);
  assertLifecycleTransition(fromLc, input.verdict === "APPROVE" ? "APPROVED" : "REJECTED", "decision_not_from_stage");
  try {
    await recordDecisionViaAuthority(
      {
        workflowId: row.id,
        teamId: ctx.teamId,
        actorUserId: ctx.actorUserId,
        decision: input.verdict,
        rationale: note,
        dryRun: true,
      },
      client,
    );
  } catch (err) {
    if (err instanceof ReviewDecisionDryRunPassed) return;
    throw err;
  }
}

// ----- approveReview ----------------------------------------------------------

export async function approveReview(
  ctx: LifecycleActorContext,
  input: { workflowId: string; note?: string | null },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewerOpsDecisionResult> {
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.REVIEWER_ASSIGNMENT_COMPLETE,
    {
      "proovra.team_id": ctx.teamId,
      "proovra.operation": "reviewer_assignment_complete",
      "proovra.outcome": "approved",
    },
    () => approveReviewInner(ctx, input, client),
  );
}

async function approveReviewInner(
  ctx: LifecycleActorContext,
  input: { workflowId: string; note?: string | null },
  client: PrismaClient,
): Promise<ReviewerOpsDecisionResult> {
  requireHuman(ctx);
  assertDecisionInput(input.note);
  const row = await loadWorkflowOrThrow(ctx, input.workflowId, client);
  const fromLc = await currentLifecycle(ctx, row, client);
  // NEEDS_INFORMATION → APPROVED is not a move the matrix allows: record the
  // response first (TEAM-SPEC §2.4).
  assertLifecycleTransition(fromLc, "APPROVED", "decision_not_from_stage");
  const result = await recordDecisionViaAuthority(
    {
      workflowId: row.id,
      teamId: ctx.teamId,
      actorUserId: ctx.actorUserId,
      decision: "APPROVE",
      rationale: input.note ?? null,
    },
    client,
  );
  const updated = result.workflow;
  const outcome = outcomeOf(result, String(row.status));
  // The authority emitted the outcome signals (T-171).
  // Phase 3 — opportunistic QC sampling at workflow close. Idempotent
  // per (workflowId, teamId). MUST NOT roll back the close transaction:
  // any failure here is logged and swallowed so the operator's approve
  // stands regardless of QC sampling availability.
  //
  // Track 1C — the decision authority may project a NON-terminal status
  // (e.g. the approval was recorded as a FIRST-stage verdict and a
  // second review is required). QC sampling only fires when the
  // projection actually closed the workflow as approved.
  if (
    mapDbStatusToReviewStage(updated.status as string) === "APPROVED_INTERNAL"
  ) {
    try {
      await sampleClosedWorkflow({
        prisma: client,
        teamId: ctx.teamId,
        workflowId: row.id,
        decision: "APPROVE_INTERNAL",
      });
    } catch (err) {
      logWarn("qc.sample_on_close.failed", {
        err: err instanceof Error ? err.message : String(err),
        workflowId: row.id,
        teamId: ctx.teamId,
        decision: "APPROVE_INTERNAL",
      });
    }
  }
  return { projection: await projectWorkflow(updated, client), outcome };
}

// ----- rejectReview -----------------------------------------------------------

export async function rejectReview(
  ctx: LifecycleActorContext,
  input: { workflowId: string; note: string },
  client: PrismaClient = defaultPrisma,
): Promise<ReviewerOpsDecisionResult> {
  requireHuman(ctx);
  assertDecisionInput(input.note);
  const row = await loadWorkflowOrThrow(ctx, input.workflowId, client);
  const fromLc = await currentLifecycle(ctx, row, client);
  assertLifecycleTransition(fromLc, "REJECTED", "decision_not_from_stage");
  const result = await recordDecisionViaAuthority(
    {
      workflowId: row.id,
      teamId: ctx.teamId,
      actorUserId: ctx.actorUserId,
      decision: "REJECT",
      rationale: input.note,
    },
    client,
  );
  const updated = result.workflow;
  const outcome = outcomeOf(result, String(row.status));
  // The authority emitted the outcome signals (T-171).
  // Phase 3 — opportunistic QC sampling at workflow close. Idempotent
  // per (workflowId, teamId). MUST NOT roll back the close transaction:
  // any failure here is logged and swallowed so the operator's reject
  // stands regardless of QC sampling availability.
  //
  // Track 1C — QC only fires when the projection actually closed the
  // workflow as rejected (see approveReviewInner note).
  if (
    mapDbStatusToReviewStage(updated.status as string) ===
    "REJECTED_INSUFFICIENT"
  ) {
    try {
      await sampleClosedWorkflow({
        prisma: client,
        teamId: ctx.teamId,
        workflowId: row.id,
        decision: "REJECT_INSUFFICIENT",
      });
    } catch (err) {
      logWarn("qc.sample_on_close.failed", {
        err: err instanceof Error ? err.message : String(err),
        workflowId: row.id,
        teamId: ctx.teamId,
        decision: "REJECT_INSUFFICIENT",
      });
    }
  }
  return { projection: await projectWorkflow(updated, client), outcome };
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
  /**
   * PHASE 13 §4 — workflow stage projections examined for drift against their
   * immutable decision log, and how many had to be repaired. A non-zero
   * `workflowProjectionsRepaired` is a real signal, not noise: it means the
   * projected stage disagreed with the decisions that produced it.
   */
  workflowProjectionsScanned: number;
  workflowProjectionsRepaired: number;
  /**
   * TEAM-SPEC R1 default — set when the workspace is no longer entitled to
   * reviewer operations: the pass did nothing (and deleted nothing).
   */
  skippedReason?: "reviewer_operations_not_included";
};

const EMPTY_RECONCILE: Omit<ReconcileResult, "skippedReason"> = {
  scanned: 0,
  flippedBreached: 0,
  flippedDueSoon: 0,
  escalationsCreated: 0,
  workloadReviewersComputed: 0,
  dueSoonRemindersScheduled: 0,
  inactivityRemindersScheduled: 0,
  workflowProjectionsScanned: 0,
  workflowProjectionsRepaired: 0,
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
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.REVIEWER_RECONCILE,
    { "proovra.team_id": input.teamId, "proovra.operation": "reviewer_reconcile" },
    () => runReconcileInner(input, client),
  );
}

async function runReconcileInner(
  input: { teamId: string; batchSize?: number },
  client: PrismaClient,
): Promise<ReconcileResult> {
  // The automation runs only where request-time gating would let a person do
  // the same (TEAM-SPEC R1 default): a workspace that lost reviewer operations
  // keeps every row, and gets no automatic escalations, reminders or SLA flips.
  if (!(await workspaceIncludesReviewCapability(input.teamId, "REVIEW_ESCALATION"))) {
    logWarn("reviewer_ops.reconcile.skipped_not_entitled", { teamId: input.teamId });
    return { ...EMPTY_RECONCILE, skippedReason: "reviewer_operations_not_included" };
  }
  bump("reviewer_reconcile_run_total");
  let escalationsCreated = 0;
  try {
    // Deadlines first, so a row stamped in this pass is read by the sweep below.
    await stampOpenReviewDeadlines(
      { teamId: input.teamId, batchSize: input.batchSize ?? 200 },
      client,
    );
    const sla = await legacyReconcileReviewSlas(
      { teamId: input.teamId, batchSize: input.batchSize ?? 200, maxPages: 10 },
      client,
    );

    // A workflow that just moved to BREACHED, and one whose escalation deadline
    // has passed, each get an automatic escalation. The stated Escalation hours
    // govern the second (WORKFLOW-006). A row that was already escalated is not in
    // either set, and the engine's fingerprint dedup holds within a day.
    const escalationDue = await client.evidenceReviewWorkflow.findMany({
      where: {
        teamId: input.teamId,
        OR: [
          { id: { in: sla.breachedWorkflowIds } },
          {
            escalationDueAtUtc: { lte: new Date() },
            escalatedAtUtc: null,
            slaPausedAtUtc: null,
            completedAtUtc: null,
            closedAt: null,
          },
        ],
        // Stage C follow-up — "already escalated" by query, never the pointer
        // (a drifted pointer either re-escalated or never escalated again).
        escalations: { none: activeEscalationWhere() },
        status: { notIn: [...REVIEW_FINISHED_DB_STATUSES] },
      },
      orderBy: { escalationDueAtUtc: "asc" },
      take: Math.max(100, sla.breachedWorkflowIds.length),
    });
    for (const wf of escalationDue) {
      const res = await createEscalation(
        {
          teamId: input.teamId,
          workflowId: wf.id,
          reason: "REVIEW_OVERDUE",
          // T-083 (stage D) — catalog copy, never engine wording.
          safeSummary: REVIEW_AUTO_ESCALATION_SUMMARY.overdue,
          conditionMessage: { code: "ops.review.escalation.overdue_auto" },
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

    // WORKFLOW-010 — what the two sweeps above scheduled now reaches the person.
    await deliverScheduledReminders(
      { teamId: input.teamId, batchSize: input.batchSize },
      client,
    );

    // PHASE 13 §4 (2026-08-17) — repair drifted workflow stage projections.
    //
    // `WorkflowReviewDecision` rows are the immutable record of what reviewers
    // decided; `EvidenceReviewWorkflow.status` is a PROJECTION of them. A
    // projection can drift — a crash between the decision write and the status
    // write, a lifecycle event applied out of order — and when it does the
    // console shows a stage the decision log does not support, which is the one
    // discrepancy this domain cannot shrug off.
    //
    // `scanReviewDecisionProjections` recomputes the stage deterministically
    // from the decision log plus the lifecycle rules and repairs divergence,
    // emitting an `EvidenceReviewWorkflowEvent` with
    // `source: "decision_projection_reconcile"` for every repair, so a silent
    // correction is impossible. It was exported and armed by nothing.
    //
    // This reconcile pass is its correct home: it is already the bounded,
    // team-scoped, idempotent sweep for this domain, already driven by the
    // cron-secret `POST /v1/reviewer-ops/reconcile` route from the reviewer-ops
    // scheduler in the worker, and already isolates its own per-row failures.
    // A second scheduler sweeping the same team would be a parallel authority
    // for no gain.
    const projectionScan = await scanReviewDecisionProjections(
      { teamId: input.teamId, batchSize: input.batchSize },
      client,
    );

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
            sourceId: "review.escalation_storm",
            teamId: input.teamId,
            category: "GOVERNANCE",
            severity: "HIGH",
            fingerprint: `reviewer:escalation_storm:${input.teamId}:${today}`,
            message: {
              code: "ops.review.escalation_storm",
              params: { count: escalationsCreated },
            },
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
          status: { notIn: [...REVIEW_FINISHED_DB_STATUSES] },
        },
      });
      const dueSoon = await client.evidenceReviewWorkflow.count({
        where: {
          teamId: input.teamId,
          slaStatus: "DUE_SOON",
          status: { notIn: [...REVIEW_FINISHED_DB_STATUSES] },
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
    // escalated_unacknowledged, etc.) and
    // raises a fresh escalation for any CRITICAL-severity stuck row.
    // Bounded scan + the escalation engine's fingerprint dedup keeps
    // re-runs idempotent.
    let stuckDetected = 0;
    let stuckEscalated = 0;
    try {
      const stuckCursorKey = `reviewer_stuck:${input.teamId}`;
      const stuckCursor = await readSweepCursor(client, stuckCursorKey);
      const stuckLimit = 200;
      const nonTerminal = await client.evidenceReviewWorkflow.findMany({
        where: {
          teamId: input.teamId,
          ...afterCursor(stuckCursor),
          status: { notIn: [...REVIEW_FINISHED_DB_STATUSES] },
        },
        orderBy: { id: "asc" },
        take: stuckLimit,
        select: {
          id: true,
          evidenceId: true,
          status: true,
          createdAt: true,
          assignedAtUtc: true,
          lastReviewedAt: true,
          slaStatus: true,
          // Stage C follow-up — the governing active escalation by query.
          escalations: {
            where: activeEscalationWhere(),
            select: { id: true, status: true, severity: true, createdAt: true },
          },
          dueAt: true,
        },
      });
      await advanceSweepCursor(client, stuckCursorKey, stuckCursor, {
        lastId: nonTerminal.at(-1)?.id ?? null,
        pageSize: nonTerminal.length,
        limit: stuckLimit,
      });
      const nowMs = Date.now();
      for (const wf of nonTerminal) {
        const governing = selectGoverningEscalation(wf.escalations).top;
        // A row still stored OVERDUE predates "a missed deadline is a breach".
        const slaStatus: WorkflowSlaStatus =
          wf.slaStatus === "OVERDUE"
            ? "BREACHED"
            : wf.slaStatus === "ON_TRACK" ||
                wf.slaStatus === "DUE_SOON" ||
                wf.slaStatus === "BREACHED"
              ? wf.slaStatus
              : null;
        const classification: StuckClassification = detectStuckWorkflow({
          nowEpochMs: nowMs,
          status: stuckStatusFromDbStatus(String(wf.status)),
          submittedAtEpochMs: wf.createdAt.getTime(),
          assignedAtEpochMs: wf.assignedAtUtc?.getTime() ?? null,
          firstOpenedAtEpochMs: wf.lastReviewedAt?.getTime() ?? null,
          lastReviewerTouchAtEpochMs: wf.lastReviewedAt?.getTime() ?? null,
          // A contributor's answer moves the row out of NEEDS_INFO to
          // RESPONSE_RECEIVED, so a row still waiting has none on record.
          lastContributorResponseAtEpochMs: null,
          slaStatus,
          hasOpenEscalation: !!governing,
          escalationAcknowledged: governing?.status === "ACKNOWLEDGED",
          escalationRaisedAtEpochMs: governing ? governing.createdAt.getTime() : null,
          // This sweep reads open reviews, and an approved review is finished,
          // so the export-blocked rule does not apply here.
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
          !governing
        ) {
          const top = classification.reasons[0]!;
          // A person already dealt with this breach (WORKFLOW-005). Resolve
          // and suppress clear the active pointer while slaStatus stays
          // BREACHED, so this sweep read "breached, nothing raised" and opened
          // a new HIGH escalation and incident, then again every UTC day.
          // A later deadline that breaches again is a new breach and is raised.
          if (top.code === "sla_overdue_no_escalation") {
            const latest = await client.reviewEscalation.findFirst({
              where: { teamId: input.teamId, workflowId: wf.id },
              orderBy: { createdAt: "desc" },
              select: { status: true, resolvedAtUtc: true, suppressedAtUtc: true },
            });
            const closedAt = latest?.resolvedAtUtc ?? latest?.suppressedAtUtc ?? null;
            if (
              latest &&
              (latest.status === "RESOLVED" || latest.status === "SUPPRESSED") &&
              closedAt &&
              (!wf.dueAt || closedAt >= wf.dueAt)
            ) {
              continue;
            }
          }
          const res = await createEscalation(
            {
              teamId: input.teamId,
              workflowId: wf.id,
              // Map to the canonical escalation reason catalog. Stuck-
              // workflow CRITICAL is most often a stalled lifecycle —
              // route it through WORKFLOW_STALLED so the existing
              // fingerprint dedup keeps escalation storms bounded.
              reason: "WORKFLOW_STALLED",
              safeSummary: REVIEW_AUTO_ESCALATION_SUMMARY.stuck(top.label),
              conditionMessage: { code: "ops.review.escalation.stuck_auto", stuck: top.code },
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

    // Phase 32.7 — canonical operational event contract.
    // The wire string is resolved from the canonical
    // WORKER_HEARTBEAT constant defined in
    // packages/shared-runtime/src/ops/canonical-events.ts. The
    // readiness check (runtime-readiness.ts::checkWorkers) reads
    // through the SAME constant. The pair cannot drift without a
    // single coordinated change to the contract module.
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: canonicalOperationalWireStringFor(
        "WORKER_HEARTBEAT",
      ) as "reviewer_reconcile_run",
      severity: "INFO",
      details: {
        scanned: sla.scanned,
        flippedBreached: sla.flippedBreached,
        flippedDueSoon: sla.flippedDueSoon,
        escalationsCreated,
        workloadReviewersComputed: workload.reviewersComputed,
        dueSoonRemindersScheduled: dueSoonReminders.scheduled,
        inactivityRemindersScheduled: inactivityResult.scheduled,
        workflowProjectionsScanned: projectionScan.scanned,
        workflowProjectionsRepaired: projectionScan.repaired,
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
      workflowProjectionsScanned: projectionScan.scanned,
      workflowProjectionsRepaired: projectionScan.repaired,
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
