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
import {
  isTerminalReviewStage,
  mapDbStatusToReviewStage,
  type ReviewerDenialReason,
  type ReviewerVerdict,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { evidenceVisibleThroughCasesWhere } from "../cases/case-visibility.js";
// PHASE 12 POINT 4 PASS C1 — the ONE assignment authority (transition rule +
// lifecycle event + SLA stamps + assignee notification).
import { assignReviewer, ReviewOperationError } from "../review-operations/review-operations.service.js";
import { writeCodingValue } from "./coding-value.service.js";

export type BulkItemOutcome = {
  workflowId: string;
  ok: boolean;
  denial?: ReviewerDenialReason | "WORKFLOW_NOT_FOUND";
  /**
   * TEAM-SPEC §2.1 (2026-11-23) — the finer typed reason beside `denial`, so a
   * mixed selection explains each refused row instead of reading
   * POLICY_REJECTED for all of them. Additive: `denial` keeps the bounded
   * vocabulary every reader already maps; `code` is a fixed snake_case word,
   * never exception text. Bulk assign sends:
   *   workflow_closed           — the review is CLOSED (denial WORKFLOW_CLOSED)
   *   assignee_not_eligible     — the assignee is not an active reviewer here (NOT_PERMITTED)
   *   assignee_not_placed       — the assignee cannot reach the record (NOT_PERMITTED)
   *   invalid_stage_transition  — the stage refused the move (POLICY_REJECTED)
   *   concurrent_change         — another change won the race (POLICY_REJECTED)
   *   item_failed               — unexpected; the detail stays in the server log
   * A workflow outside the actor's reach stays the one non-enumerating
   * WORKFLOW_NOT_FOUND with no code.
   */
  code?: string;
};

/** Bulk assign's per-item refusal for an error from the assignment authority. */
function assignRefusal(workflowId: string, err: unknown): BulkItemOutcome {
  if (err instanceof ReviewOperationError) {
    switch (err.code) {
      case "assignee_not_eligible":
      case "assignee_not_placed":
      case "permission_denied":
        return { workflowId, ok: false, denial: "NOT_PERMITTED", code: err.code };
      case "workflow_not_found":
      case "evidence_not_in_workspace":
        return { workflowId, ok: false, denial: "WORKFLOW_NOT_FOUND" };
      case "invalid_stage_transition":
        return {
          workflowId,
          ok: false,
          denial: "POLICY_REJECTED",
          code: err.details?.reason === "concurrent_change" ? "concurrent_change" : "invalid_stage_transition",
        };
      default:
        return { workflowId, ok: false, denial: "POLICY_REJECTED", code: err.code };
    }
  }
  return { workflowId, ok: false, denial: "POLICY_REJECTED", code: "item_failed" };
}

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
      where: {
        id,
        teamId: input.teamId,
        // A record closed to the actor answers as a missing workflow (WORKFLOW-003).
        evidence: evidenceVisibleThroughCasesWhere(input.actorUserId),
      },
      select: { id: true, evidenceId: true, status: true },
    });
    if (!row) {
      outcomes.push({ workflowId: id, ok: false, denial: "WORKFLOW_NOT_FOUND" });
      continue;
    }
    // TEAM-SPEC §2.1 — a CLOSED review is not re-staffed by an assignment.
    // The stage matrix allows self-transitions (CLOSED→CLOSED), so without
    // this a bulk assign silently re-assigned finished reviews.
    if (isTerminalReviewStage(mapDbStatusToReviewStage(row.status as string))) {
      outcomes.push({ workflowId: id, ok: false, denial: "WORKFLOW_CLOSED", code: "workflow_closed" });
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
    } catch (err) {
      outcomes.push(assignRefusal(id, err));
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
      where: {
        id,
        teamId: input.teamId,
        // A record closed to the actor answers as a missing workflow (WORKFLOW-003).
        evidence: evidenceVisibleThroughCasesWhere(input.actorUserId),
      },
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
      where: {
        id,
        teamId: input.teamId,
        // A record closed to the actor answers as a missing workflow (WORKFLOW-003).
        evidence: evidenceVisibleThroughCasesWhere(input.actorUserId),
      },
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
