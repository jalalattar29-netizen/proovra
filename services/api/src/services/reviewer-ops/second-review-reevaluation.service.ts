/**
 * T-014 (Team remediation, 2026-11-24) — the EXPLICIT re-evaluation of open
 * reviews held for a second review only by the old trigger rule.
 *
 * Before T-013, ANY active escalation forced an independent second review,
 * the automatic overdue / stuck sweeps' own included, so a review in a
 * one-reviewer workspace could stall with its FIRST verdict waiting for a
 * second reviewer nobody could supply. Those rounds were recorded before the
 * decision log wrote its cause, so they stay pinned (decisionEventPinsSecondReview
 * treats an unexplained requirement conservatively) until an operator runs
 * this job:
 *
 *   - EXPLICIT: never run by the reconcile sweep; called by an operator through
 *     `POST /v1/reviewer-ops/maintenance/second-review-reevaluation`
 *     (cron secret) with `dryRun` first.
 *   - IDEMPOTENT: a re-evaluated round carries a marker event
 *     (`source = second_review_policy_reevaluation`); the status write is
 *     conditional on the status read. A second run finds nothing.
 *   - AUDITED: one `reviewer.second_review_policy.reevaluated` tenant audit row,
 *     one reviewer-activity row and one workflow event per review.
 *   - NO HISTORY REWRITE: decision rows are never touched. The status
 *     projection follows the existing log under today's rule, exactly as the
 *     decision write would have projected it.
 *
 * A round qualifies only when ALL hold:
 *   - the review is open and its current round holds only a FIRST decision,
 *     logged as `second_required` with no recorded cause (pre-T-013);
 *   - today's live requirement is false (no ESCALATED status, no forcing
 *     escalation, no active legal hold, no redaction requirement);
 *   - no escalation that forces independent review (a person's, any reason)
 *     was active when the FIRST decision was recorded.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  SECOND_REVIEW_REEVALUATION_SOURCE,
  decisionEventPinsSecondReview,
  deriveDecisionProjection,
  escalationForcesIndependentReview,
  mapDbStatusToReviewStage,
  mapReviewStageToDbStatus,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { requiresSecondReview } from "../evidence-review/second-review.service.js";
import { recordReviewActivityTx } from "../evidence-review/reviewer-audit.service.js";
import { resolveOpenReviewEscalation } from "./escalation-engine.service.js";

const OPEN_STATUSES = ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO", "RESPONSE_RECEIVED", "REOPENED", "NOT_STARTED"];

export type SecondReviewReevaluationRow = {
  workflowId: string;
  teamId: string;
  outcome:
    | "reevaluated"
    | "would_reevaluate"
    | "forcing_cause_at_decision"
    | "still_required"
    | "not_pinned"
    | "moved_during_reevaluation";
  toStage?: string;
};

export type SecondReviewReevaluationResult = {
  dryRun: boolean;
  scanned: number;
  reevaluated: number;
  rows: SecondReviewReevaluationRow[];
};

export async function reevaluateSecondReviewPolicyHolds(
  input: { teamId?: string; dryRun?: boolean; limit?: number } = {},
  client: PrismaClient = defaultPrisma,
): Promise<SecondReviewReevaluationResult> {
  const dryRun = input.dryRun !== false;
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 5000);
  // Candidate rounds: an open review whose FIRST decision was logged as
  // second_required. Bounded; scoped to one workspace when asked.
  const events = await client.evidenceReviewWorkflowEvent.findMany({
    where: {
      eventType: "DECISION_LOGGED",
      nextValue: { path: ["state"], equals: "second_required" },
      workflow: {
        status: { in: OPEN_STATUSES as never },
        ...(input.teamId ? { teamId: input.teamId } : {}),
      },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { workflowId: true, nextValue: true, createdAt: true },
  });
  const rows: SecondReviewReevaluationRow[] = [];
  const seen = new Set<string>();
  let reevaluated = 0;
  for (const ev of events) {
    if (seen.has(ev.workflowId)) continue;
    seen.add(ev.workflowId);
    const wf = await client.evidenceReviewWorkflow.findUnique({ where: { id: ev.workflowId } });
    if (!wf || !wf.teamId) continue;
    const round = (ev.nextValue as { round?: unknown } | null)?.round;
    const v = (ev.nextValue ?? {}) as { secondReviewCause?: unknown };
    // Only the CURRENT round, only an unexplained (pre-T-013) requirement.
    if (round !== wf.decisionRound || v.secondReviewCause !== undefined || !decisionEventPinsSecondReview(ev.nextValue)) {
      continue;
    }
    const roundRows = await client.workflowReviewDecision.findMany({
      where: { workflowId: wf.id, teamId: wf.teamId, round: wf.decisionRound },
      orderBy: { decidedAt: "asc" },
    });
    if (roundRows.length !== 1 || roundRows[0]!.stage !== "FIRST") continue;
    const marker = await client.evidenceReviewWorkflowEvent.findFirst({
      where: {
        workflowId: wf.id,
        eventType: "STAGE_CHANGED",
        nextValue: { path: ["source"], equals: SECOND_REVIEW_REEVALUATION_SOURCE },
        AND: [{ nextValue: { path: ["round"], equals: wf.decisionRound } }],
      },
      select: { id: true },
    });
    if (marker) {
      rows.push({ workflowId: wf.id, teamId: wf.teamId, outcome: "not_pinned" });
      continue;
    }
    const live = await requiresSecondReview({ workflowId: wf.id, teamId: wf.teamId, evidenceId: wf.evidenceId }, client);
    if (live.required) {
      rows.push({ workflowId: wf.id, teamId: wf.teamId, outcome: "still_required" });
      continue;
    }
    // Was a FORCING escalation (a person's) active when the decision was made?
    const at = ev.createdAt;
    const escalationsThen = await client.reviewEscalation.findMany({
      where: { workflowId: wf.id, teamId: wf.teamId, createdAt: { lte: at } },
      select: { reason: true, createdByUserId: true, requiresIndependentReview: true, resolvedAtUtc: true, suppressedAtUtc: true, status: true },
    });
    const forcingThen = escalationsThen.some((e) => {
      const endedAt = e.resolvedAtUtc ?? e.suppressedAtUtc;
      const activeThen = !endedAt || endedAt.getTime() > at.getTime();
      return activeThen && escalationForcesIndependentReview(e);
    });
    if (forcingThen) {
      rows.push({ workflowId: wf.id, teamId: wf.teamId, outcome: "forcing_cause_at_decision" });
      continue;
    }
    const projection = deriveDecisionProjection(roundRows, false);
    const toStage = projection.projectedStage;
    if (!toStage) continue;
    if (dryRun) {
      rows.push({ workflowId: wf.id, teamId: wf.teamId, outcome: "would_reevaluate", toStage });
      continue;
    }
    const first = roundRows[0]!;
    const fromStage = mapDbStatusToReviewStage(String(wf.status));
    const applied = await client.$transaction(async (tx) => {
      const now = new Date();
      const data: Prisma.EvidenceReviewWorkflowUncheckedUpdateManyInput = {};
      if (toStage !== fromStage) data.status = mapReviewStageToDbStatus(toStage) as never;
      if (toStage === "APPROVED_INTERNAL" || toStage === "REJECTED_INSUFFICIENT") data.completedAtUtc = now;
      if (toStage === "REJECTED_INSUFFICIENT") data.rejectionReason = first.rationale?.slice(0, 400) || null;
      const moved = await tx.evidenceReviewWorkflow.updateMany({
        where: { id: wf.id, status: wf.status, decisionRound: wf.decisionRound },
        data,
      });
      if (moved.count !== 1) return false;
      await tx.evidenceReviewWorkflowEvent.create({
        data: {
          workflowId: wf.id,
          evidenceId: wf.evidenceId,
          actorUserId: null,
          eventType: "STAGE_CHANGED",
          previousValue: { stage: fromStage } as Prisma.InputJsonValue,
          nextValue: {
            stage: toStage,
            round: wf.decisionRound,
            source: SECOND_REVIEW_REEVALUATION_SOURCE,
            rule: "automatic_escalations_do_not_force_second_review",
            decisionId: first.id,
          } as Prisma.InputJsonValue,
          note: "Second-review requirement re-evaluated: only automatic overdue escalations required it.",
        },
      });
      await recordReviewActivityTx(tx, {
        evidenceId: wf.evidenceId,
        workflowId: wf.id,
        teamId: wf.teamId!,
        actorUserId: null,
        code: "REVIEW_WORKFLOW_STATE_CHANGED",
        previousState: String(wf.status),
        resultingState: mapReviewStageToDbStatus(toStage),
      });
      return true;
    });
    if (!applied) {
      rows.push({ workflowId: wf.id, teamId: wf.teamId, outcome: "moved_during_reevaluation" });
      continue;
    }
    reevaluated += 1;
    rows.push({ workflowId: wf.id, teamId: wf.teamId, outcome: "reevaluated", toStage });
    await emitTenantAudit(
      {
        action: "reviewer.second_review_policy.reevaluated",
        outcome: "success",
        sourceApp: "API",
        actorUserId: null,
        workspaceId: wf.teamId,
        resourceType: "review_workflow",
        resourceId: wf.id,
        metadata: {
          round: wf.decisionRound,
          decisionId: first.id,
          firstDecision: first.decision,
          fromStatus: String(wf.status),
          toStatus: mapReviewStageToDbStatus(toStage),
          rule: "automatic_escalations_do_not_force_second_review",
        },
      },
      client,
    ).catch(() => null);
    if (toStage === "APPROVED_INTERNAL" || toStage === "REJECTED_INSUFFICIENT") {
      await resolveOpenReviewEscalation(
        { workflow: wf, actorUserId: null, note: "Review decided after the second-review policy re-evaluation." },
        client,
      );
    }
  }
  return { dryRun, scanned: seen.size, reevaluated, rows };
}
