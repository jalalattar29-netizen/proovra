/**
 * PROOVRA Phase 2A Closure — Bulk reviewer operations.
 *
 *   - bulkAssign       — move a selection set to a reviewer
 *   - bulkDecide       — record APPROVE / REJECT / ESCALATE for many
 *                        workflows (gated on coding coverage)
 *   - bulkCode         — set a single coding field across many
 *                        workflows (bounded by schema binding)
 *
 * Hard rules:
 *   * Bounded selection set: ≤ 100 workflows per call.
 *   * Each workflow processed individually so a single failure does
 *     not abort the batch — the result returns per-item outcomes
 *     using bounded codes.
 *   * Workspace-anchored; capability-gated upstream by the route.
 *   * NEVER bypasses the existing single-item write services. Every
 *     row goes through the existing transition rules so the audit
 *     chain remains consistent.
 *   * Bounded denial reasons.
 */

import type { PrismaClient } from "@prisma/client";
import type {
  ReviewerDenialReason,
  ReviewerVerdict,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
// PHASE 12 POINT 4 PASS C1 — the ONE assignment authority (transition rule +
// lifecycle event + SLA stamps + assignee notification).
import { assignReviewer } from "../review-operations/review-operations.service.js";
import { writeCodingValue } from "./coding-value.service.js";

export type BulkItemOutcome = {
  workflowId: string;
  ok: boolean;
  denial?: ReviewerDenialReason | "WORKFLOW_NOT_FOUND";
};

const MAX_BULK = 100;

// ---------------------------------------------------------------------------
// bulkAssign
// ---------------------------------------------------------------------------

export async function bulkAssign(input: {
  prisma?: PrismaClient;
  teamId: string;
  actorUserId: string;
  assigneeUserId: string;
  workflowIds: ReadonlyArray<string>;
}): Promise<
  | { ok: true; total: number; succeeded: number; outcomes: BulkItemOutcome[] }
  | { ok: false; denial: ReviewerDenialReason }
> {
  if (input.workflowIds.length === 0) {
    return { ok: true, total: 0, succeeded: 0, outcomes: [] };
  }
  if (input.workflowIds.length > MAX_BULK) {
    return { ok: false, denial: "RATE_LIMITED" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const outcomes: BulkItemOutcome[] = [];
  for (const id of input.workflowIds) {
    const row = await prisma.evidenceReviewWorkflow.findFirst({
      where: { id, teamId: input.teamId },
      select: { id: true, evidenceId: true },
    });
    if (!row) {
      outcomes.push({ workflowId: id, ok: false, denial: "WORKFLOW_NOT_FOUND" });
      continue;
    }
    try {
      // PHASE 12 POINT 4 PASS C1 — go through the canonical assignment
      // authority, as this file's own contract requires.
      //
      // This loop used to write `status: "ASSIGNED"` (plus the assignment
      // columns) straight onto the row. That skipped the stage-transition
      // rule, the ASSIGNED/REASSIGNED lifecycle event, the SLA stamps and the
      // assignee notification — so a bulk assignment and a single assignment
      // produced materially different records, and a workflow could be forced
      // from a terminal stage back to ASSIGNED with no history of it.
      await assignReviewer(
        {
          evidenceId: row.evidenceId,
          assignedToUserId: input.assigneeUserId,
          actorUserId: input.actorUserId,
        },
        prisma,
      );
      outcomes.push({ workflowId: id, ok: true });
    } catch {
      outcomes.push({ workflowId: id, ok: false, denial: "POLICY_REJECTED" });
    }
  }
  return {
    ok: true,
    total: outcomes.length,
    succeeded: outcomes.filter((o) => o.ok).length,
    outcomes,
  };
}

// ---------------------------------------------------------------------------
// bulkDecide
// ---------------------------------------------------------------------------

/**
 * Records a REVIEWER_VERDICT field write on each workflow whose
 * bound schema has a verdict field. Workflows without a verdict
 * field fall through with `VERDICT_REQUIRED`. The actual workflow
 * status transition continues to run through the existing
 * review-operations service.
 */
export async function bulkDecide(input: {
  prisma?: PrismaClient;
  teamId: string;
  actorUserId: string;
  verdict: ReviewerVerdict;
  workflowIds: ReadonlyArray<string>;
  rationale?: string;
}): Promise<
  | { ok: true; total: number; succeeded: number; outcomes: BulkItemOutcome[] }
  | { ok: false; denial: ReviewerDenialReason }
> {
  if (input.workflowIds.length === 0) {
    return { ok: true, total: 0, succeeded: 0, outcomes: [] };
  }
  if (input.workflowIds.length > MAX_BULK) {
    return { ok: false, denial: "RATE_LIMITED" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const outcomes: BulkItemOutcome[] = [];
  for (const id of input.workflowIds) {
    const workflow = await prisma.evidenceReviewWorkflow.findFirst({
      where: { id, teamId: input.teamId },
      select: { id: true, codingSchemaId: true },
    });
    if (!workflow) {
      outcomes.push({ workflowId: id, ok: false, denial: "WORKFLOW_NOT_FOUND" });
      continue;
    }
    if (!workflow.codingSchemaId) {
      outcomes.push({ workflowId: id, ok: false, denial: "SCHEMA_NOT_FOUND" });
      continue;
    }
    const verdictField = await prisma.codingField.findFirst({
      where: {
        schemaId: workflow.codingSchemaId,
        fieldType: "REVIEWER_VERDICT",
      },
      select: { id: true },
    });
    if (!verdictField) {
      outcomes.push({ workflowId: id, ok: false, denial: "VERDICT_REQUIRED" });
      continue;
    }
    const wrote = await writeCodingValue({
      teamId: input.teamId,
      workflowId: id,
      fieldId: verdictField.id,
      value: { verdict: input.verdict },
      authorUserId: input.actorUserId,
      rationale: input.rationale,
    });
    if (wrote.ok) {
      outcomes.push({ workflowId: id, ok: true });
    } else {
      outcomes.push({ workflowId: id, ok: false, denial: wrote.denial });
    }
  }
  return {
    ok: true,
    total: outcomes.length,
    succeeded: outcomes.filter((o) => o.ok).length,
    outcomes,
  };
}

// ---------------------------------------------------------------------------
// bulkCode — set the same single field value on many workflows
// ---------------------------------------------------------------------------

export async function bulkCode(input: {
  prisma?: PrismaClient;
  teamId: string;
  actorUserId: string;
  fieldSlug: string;
  value: Record<string, unknown>;
  workflowIds: ReadonlyArray<string>;
}): Promise<
  | { ok: true; total: number; succeeded: number; outcomes: BulkItemOutcome[] }
  | { ok: false; denial: ReviewerDenialReason }
> {
  if (input.workflowIds.length === 0) {
    return { ok: true, total: 0, succeeded: 0, outcomes: [] };
  }
  if (input.workflowIds.length > MAX_BULK) {
    return { ok: false, denial: "RATE_LIMITED" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const outcomes: BulkItemOutcome[] = [];
  for (const id of input.workflowIds) {
    const workflow = await prisma.evidenceReviewWorkflow.findFirst({
      where: { id, teamId: input.teamId },
      select: { id: true, codingSchemaId: true },
    });
    if (!workflow?.codingSchemaId) {
      outcomes.push({ workflowId: id, ok: false, denial: "SCHEMA_NOT_FOUND" });
      continue;
    }
    const field = await prisma.codingField.findFirst({
      where: { schemaId: workflow.codingSchemaId, slug: input.fieldSlug },
      select: { id: true },
    });
    if (!field) {
      outcomes.push({ workflowId: id, ok: false, denial: "FIELD_NOT_FOUND" });
      continue;
    }
    const res = await writeCodingValue({
      teamId: input.teamId,
      workflowId: id,
      fieldId: field.id,
      value: input.value,
      authorUserId: input.actorUserId,
    });
    outcomes.push(
      res.ok
        ? { workflowId: id, ok: true }
        : { workflowId: id, ok: false, denial: res.denial },
    );
  }
  return {
    ok: true,
    total: outcomes.length,
    succeeded: outcomes.filter((o) => o.ok).length,
    outcomes,
  };
}
