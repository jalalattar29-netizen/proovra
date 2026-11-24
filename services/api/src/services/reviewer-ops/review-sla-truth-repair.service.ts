/**
 * Stage C (team remediation) — ONE idempotent, audited repair of stored review
 * SLA / escalation facts written by the defects stage C fixed. DRY RUN unless
 * `apply` is set. It never touches a review decision, a decision row, a status
 * or an escalation's own status; it only:
 *
 *   T-047  nulls a deadline the open-review sweep stamped AFTER the fact it
 *          measures (assignment deadline on a row assigned before the stamp;
 *          first-review deadline on a row first decided before the stamp). The
 *          stamp is identified by its own SLA_UPDATED event
 *          (`nextValue.source = "open_review_sweep"`), and only a deadline at
 *          or after that stamp's time is cleared (so a deadline an earlier,
 *          honest stamp set is kept).
 *   T-050  re-derives `activeEscalationId` to the governing ACTIVE escalation
 *          (highest severity, then newest), or null when none is active.
 *   T-044  fills `firstDecidedAtUtc` from the immutable decision log where it is
 *          still null (rows decided while the rollback image ran).
 *
 * Every change is written conditionally on the value it read (a concurrent
 * writer wins) and leaves a tenant audit row `reviewer.review.sla_truth_repair`
 * with before/after. A second run finds nothing to change.
 */

import type { PrismaClient } from "@prisma/client";
import { selectGoverningEscalation, REVIEW_ESCALATION_ACTIVE_STATUSES } from "@proovra/shared";

import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { deadlineStampedAfterFact } from "./review-sla-read-facts.js";

export type ReviewSlaTruthRepairChange = {
  workflowId: string;
  teamId: string | null;
  kind: "sweep_stamped_assignment_deadline" | "sweep_stamped_first_review_deadline" | "escalation_pointer" | "first_decided_at";
  before: string | null;
  after: string | null;
};

export type ReviewSlaTruthRepairResult = {
  mode: "DRY_RUN" | "APPLY";
  examined: number;
  changes: ReviewSlaTruthRepairChange[];
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function repairReviewSlaTruth(
  input: {
    apply: boolean;
    /** Limit to one workspace (tests, a staged rollout). */
    teamId?: string;
    /** Limit to these workflows (tests). */
    workflowIds?: ReadonlyArray<string>;
    batchSize?: number;
  },
  client: PrismaClient,
): Promise<ReviewSlaTruthRepairResult> {
  const scope = {
    ...(input.teamId ? { teamId: input.teamId } : {}),
    ...(input.workflowIds ? { id: { in: [...input.workflowIds] } } : {}),
  };
  const take = Math.min(Math.max(input.batchSize ?? 5000, 1), 50_000);
  const changes: ReviewSlaTruthRepairChange[] = [];
  const seen = new Set<string>();

  // --- T-047: sweep-stamped deadlines after the fact ------------------------
  const sweepEvents = await client.evidenceReviewWorkflowEvent.findMany({
    where: {
      eventType: "SLA_UPDATED",
      nextValue: { path: ["source"], equals: "open_review_sweep" },
      ...(input.workflowIds ? { workflowId: { in: [...input.workflowIds] } } : {}),
      ...(input.teamId ? { workflow: { teamId: input.teamId } } : {}),
    },
    select: { workflowId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take,
  });
  const firstSweepAt = new Map<string, Date>();
  for (const e of sweepEvents) if (!firstSweepAt.has(e.workflowId)) firstSweepAt.set(e.workflowId, e.createdAt);
  if (firstSweepAt.size > 0) {
    const rows = await client.evidenceReviewWorkflow.findMany({
      where: { id: { in: [...firstSweepAt.keys()] }, ...scope },
      select: {
        id: true,
        teamId: true,
        assignedAtUtc: true,
        assignmentDueAtUtc: true,
        firstDecidedAtUtc: true,
        firstResponseDueAtUtc: true,
      },
    });
    for (const row of rows) {
      seen.add(row.id);
      const stampedAt = firstSweepAt.get(row.id)!;
      // The read-time rule (review-sla-read-facts.ts): repaired and
      // un-repaired rows read the same.
      if (deadlineStampedAfterFact(row.assignmentDueAtUtc, row.assignedAtUtc, stampedAt)) {
        changes.push({
          workflowId: row.id,
          teamId: row.teamId,
          kind: "sweep_stamped_assignment_deadline",
          before: iso(row.assignmentDueAtUtc),
          after: null,
        });
      }
      if (deadlineStampedAfterFact(row.firstResponseDueAtUtc, row.firstDecidedAtUtc, stampedAt)) {
        changes.push({
          workflowId: row.id,
          teamId: row.teamId,
          kind: "sweep_stamped_first_review_deadline",
          before: iso(row.firstResponseDueAtUtc),
          after: null,
        });
      }
    }
  }

  // --- T-050: drifted escalation pointers ----------------------------------
  const withEscalations = await client.evidenceReviewWorkflow.findMany({
    where: {
      ...scope,
      OR: [
        { activeEscalationId: { not: null } },
        { escalations: { some: { status: { in: [...REVIEW_ESCALATION_ACTIVE_STATUSES] } } } },
      ],
    },
    select: {
      id: true,
      teamId: true,
      activeEscalationId: true,
      escalations: {
        where: { status: { in: [...REVIEW_ESCALATION_ACTIVE_STATUSES] } },
        select: { id: true, severity: true, status: true, createdAt: true },
      },
    },
    take,
  });
  for (const row of withEscalations) {
    seen.add(row.id);
    const want = selectGoverningEscalation(row.escalations).top?.id ?? null;
    if (want !== row.activeEscalationId) {
      changes.push({ workflowId: row.id, teamId: row.teamId, kind: "escalation_pointer", before: row.activeEscalationId, after: want });
    }
  }

  // --- T-044: first decision time ------------------------------------------
  const undated = await client.evidenceReviewWorkflow.findMany({
    where: { ...scope, firstDecidedAtUtc: null, reviewDecisions: { some: {} } },
    select: { id: true, teamId: true },
    take,
  });
  if (undated.length > 0) {
    const firsts = await client.workflowReviewDecision.groupBy({
      by: ["workflowId"],
      where: { workflowId: { in: undated.map((w) => w.id) } },
      _min: { decidedAt: true },
    });
    const teamOf = new Map(undated.map((w) => [w.id, w.teamId]));
    for (const f of firsts) {
      seen.add(f.workflowId);
      if (!f._min.decidedAt) continue;
      changes.push({
        workflowId: f.workflowId,
        teamId: teamOf.get(f.workflowId) ?? null,
        kind: "first_decided_at",
        before: null,
        after: iso(f._min.decidedAt),
      });
    }
  }

  const applied: ReviewSlaTruthRepairChange[] = [];
  if (input.apply) {
    for (const c of changes) {
      const wrote = await applyChange(c, client);
      if (!wrote) continue;
      applied.push(c);
      await emitTenantAudit(
        {
          action: "reviewer.review.sla_truth_repair",
          outcome: "success",
          sourceApp: "API",
          actorUserId: null,
          workspaceId: c.teamId,
          resourceType: "review_workflow",
          resourceId: c.workflowId,
          metadata: { kind: c.kind, before: c.before, after: c.after, job: "repair-review-sla-truth" },
        },
        client,
      );
    }
  }
  return { mode: input.apply ? "APPLY" : "DRY_RUN", examined: seen.size, changes: input.apply ? applied : changes };
}

/** Conditional on the value read: a concurrent writer's value is never overwritten. */
async function applyChange(c: ReviewSlaTruthRepairChange, client: PrismaClient): Promise<boolean> {
  const at = (v: string | null) => (v ? new Date(v) : null);
  switch (c.kind) {
    case "sweep_stamped_assignment_deadline":
      return (
        (
          await client.evidenceReviewWorkflow.updateMany({
            where: { id: c.workflowId, assignmentDueAtUtc: at(c.before) },
            data: { assignmentDueAtUtc: null },
          })
        ).count === 1
      );
    case "sweep_stamped_first_review_deadline":
      return (
        (
          await client.evidenceReviewWorkflow.updateMany({
            where: { id: c.workflowId, firstResponseDueAtUtc: at(c.before) },
            data: { firstResponseDueAtUtc: null },
          })
        ).count === 1
      );
    case "escalation_pointer":
      return (
        (
          await client.evidenceReviewWorkflow.updateMany({
            where: { id: c.workflowId, activeEscalationId: c.before },
            data: { activeEscalationId: c.after },
          })
        ).count === 1
      );
    case "first_decided_at":
      return (
        (
          await client.evidenceReviewWorkflow.updateMany({
            where: { id: c.workflowId, firstDecidedAtUtc: null },
            data: { firstDecidedAtUtc: at(c.after) },
          })
        ).count === 1
      );
  }
}
