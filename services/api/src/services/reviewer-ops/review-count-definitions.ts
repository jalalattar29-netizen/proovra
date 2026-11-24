/**
 * Stage C (team remediation, T-052) — THE count definitions for review work.
 *
 * Every review figure a surface shows (Inbox tabs, focus-mode rail, Monitoring
 * tiles, workload, analytics, the Home Team card, the Evidence Library's review
 * figures) is computed from the predicates here, so the same words mean the
 * same rows everywhere and each figure names its unit:
 *
 *   - "reviews"     — EvidenceReviewWorkflow rows.
 *   - "escalations" — ReviewEscalation rows. One review can carry several
 *                     active escalations (COR-A): 1 escalated review is not
 *                     2 active escalations, and neither is shown as the other.
 *
 * Definitions (labels and units live in the shared REVIEW_COUNT_DEFINITIONS):
 *   - open review:      status not finished (REVIEW_FINISHED_DB_STATUSES).
 *   - escalated review: an OPEN review with status ESCALATED, or with at least
 *                       one ACTIVE escalation — decided by query (EXISTS), never
 *                       by the denormalised `activeEscalationId` pointer (T-050).
 *   - active escalation: status OPEN, ACKNOWLEDGED or REASSIGNED.
 *   - completed (7 d):  `completedAtUtc` within the last 7 days (the
 *                       COMPLETED_RECENTLY slice).
 *   - QC awaiting verdict: QC_SAMPLE_PENDING_STATES (T-054).
 *
 * Reach: every review count is narrowed by the canonical case-visibility rule
 * for the reader, exactly like the queue slices it links to.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  QC_SAMPLE_PENDING_STATES,
  REVIEW_ESCALATION_ACTIVE_STATUSES,
  REVIEW_FINISHED_DB_STATUSES,
} from "@proovra/shared";

import { evidenceVisibleThroughCasesWhere } from "../cases/case-visibility.js";
import { hiddenWorkflowIdsInWorkspace } from "../access/record-reach.js";

type WorkflowWhere = Prisma.EvidenceReviewWorkflowWhereInput;

export const COMPLETED_RECENTLY_WINDOW_MS = 7 * 86400_000;

/** An escalation that still needs attention. */
export function activeEscalationWhere(): Prisma.ReviewEscalationWhereInput {
  return { status: { in: [...REVIEW_ESCALATION_ACTIVE_STATUSES] } };
}

/** A review that is not approved, rejected or archived. */
export function openReviewWhere(): WorkflowWhere {
  return { status: { notIn: [...REVIEW_FINISHED_DB_STATUSES] } };
}

/** A review carrying at least one active escalation (EXISTS, pointer-free). */
export function hasActiveEscalationWhere(
  extra: Prisma.ReviewEscalationWhereInput = {},
): WorkflowWhere {
  return { escalations: { some: { ...activeEscalationWhere(), ...extra } } };
}

/** An OPEN review with status ESCALATED or at least one active escalation. */
export function escalatedReviewWhere(): WorkflowWhere {
  return {
    AND: [openReviewWhere(), { OR: [{ status: "ESCALATED" }, hasActiveEscalationWhere()] }],
  };
}

/** The reader's reach in one workspace (the queue slices' scope). */
export function reviewScopeWhere(teamId: string, viewerUserId: string | null): WorkflowWhere {
  return { teamId, evidence: evidenceVisibleThroughCasesWhere(viewerUserId) };
}

export function completedRecentlyWhere(now: Date = new Date()): WorkflowWhere {
  return { completedAtUtc: { gte: new Date(now.getTime() - COMPLETED_RECENTLY_WINDOW_MS) } };
}

export type ReviewFigureCounts = {
  /** unit: reviews */
  openReviews: number;
  /** unit: reviews */
  unassignedReviews: number;
  /** unit: reviews — open reviews assigned to the reader. */
  myReviews: number;
  /** unit: reviews — open reviews with status IN_REVIEW. */
  inProgressReviews: number;
  /** unit: reviews */
  escalatedReviews: number;
  /** unit: escalations */
  activeEscalations: number;
  /** unit: reviews */
  completedReviews7d: number;
};

/** All review-unit and escalation-unit figures for one reader, one workspace. */
export async function countReviewFigures(
  input: { teamId: string; viewerUserId: string | null; now?: Date },
  client: PrismaClient,
): Promise<ReviewFigureCounts> {
  const scope = reviewScopeWhere(input.teamId, input.viewerUserId);
  const open: WorkflowWhere = { AND: [scope, openReviewWhere()] };
  const count = (where: WorkflowWhere) => client.evidenceReviewWorkflow.count({ where });
  const [
    openReviews,
    unassignedReviews,
    myReviews,
    inProgressReviews,
    escalatedReviews,
    activeEscalations,
    completedReviews7d,
  ] = await Promise.all([
    count(open),
    count({ AND: [open, { assignedToUserId: null }] }),
    input.viewerUserId
      ? count({ AND: [open, { assignedToUserId: input.viewerUserId }] })
      : Promise.resolve(0),
    count({ AND: [open, { status: "IN_REVIEW" }] }),
    count({ AND: [scope, escalatedReviewWhere()] }),
    countActiveEscalations(input, client),
    count({ AND: [scope, completedRecentlyWhere(input.now)] }),
  ]);
  return {
    openReviews,
    unassignedReviews,
    myReviews,
    inProgressReviews,
    escalatedReviews,
    activeEscalations,
    completedReviews7d,
  };
}

/** unit: escalations — active escalations on reviews the reader can reach. */
export async function countActiveEscalations(
  input: { teamId: string; viewerUserId: string | null },
  client: PrismaClient,
): Promise<number> {
  return client.reviewEscalation.count({
    where: {
      teamId: input.teamId,
      ...activeEscalationWhere(),
      workflow: { evidence: evidenceVisibleThroughCasesWhere(input.viewerUserId) },
    },
  });
}

/**
 * T-054 — the ONE "QC awaiting verdict" count (rail, Queues card, probe).
 * A null viewer is the machine count (runtime probe): nothing is hidden.
 */
export async function countQcSamplesAwaitingVerdict(
  input: { teamId: string; viewerUserId: string | null },
  client: PrismaClient,
): Promise<number> {
  const hidden = input.viewerUserId
    ? await hiddenWorkflowIdsInWorkspace(input.teamId, input.viewerUserId, client)
    : [];
  return client.qcSample.count({
    where: {
      teamId: input.teamId,
      ...(hidden.length > 0 ? { workflowId: { notIn: hidden } } : {}),
      state: { in: [...QC_SAMPLE_PENDING_STATES] },
    },
  });
}
