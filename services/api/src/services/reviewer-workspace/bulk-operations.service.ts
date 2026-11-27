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

/**
 * Review remediation 2026-11-27 (F-37, BEHAVIOUR-SPEC §8) — the coded-value
 * bulk envelope. Bulk decide and bulk code write CODING ONLY (a
 * `CodingValue` + its `CodingValueHistory` row through `writeCodingValue`);
 * neither writes a `WorkflowReviewDecision`, so the envelope says
 * `recordsDecision: false`.
 *
 *   - `ok` is false when nothing was written (`succeeded === 0` on a
 *     non-empty selection): an all-failed batch is never a success.
 *   - `failed` and `items` (`{workflowId, ok, errorCode, message}`) are the
 *     common bulk shape the Inbox reads; `outcomes` stays for the audit
 *     writer and older readers.
 *   - `httpStatus` is the route's status hint: 200 when every item was
 *     written, otherwise 207 (partial or all-failed).
 */
export type BulkEnvelopeItem = {
  workflowId: string;
  ok: boolean;
  errorCode?: string;
  message?: string;
};

export type BulkCodingEnvelope = {
  ok: boolean;
  total: number;
  succeeded: number;
  failed: number;
  outcomes: BulkItemOutcome[];
  items: BulkEnvelopeItem[];
  recordsDecision: false;
  httpStatus: 200 | 207;
};

/** A whole-call refusal (nothing was attempted). */
export type BulkRefusal = { ok: false; denial: ReviewerDenialReason };

/** True for a whole-call refusal, false for a per-item envelope. */
export function isBulkRefusal(res: BulkCodingEnvelope | BulkRefusal): res is BulkRefusal {
  return "denial" in res;
}

/** A refused row as a person reads it (never exception text). */
function bulkItemMessage(o: BulkItemOutcome): string {
  switch (o.denial) {
    case "WORKFLOW_NOT_FOUND":
      return "Review not found in this workspace.";
    case "SCHEMA_NOT_FOUND":
      return "No coding schema is bound to this review.";
    case "VERDICT_REQUIRED":
      return "The bound coding schema has no assessment field.";
    case "FIELD_NOT_FOUND":
      return "The bound coding schema has no such field.";
    case "WORKFLOW_CLOSED":
      return "The review is closed.";
    case "NOT_PERMITTED":
      return "Your role cannot change this review.";
    default:
      return "Not changed.";
  }
}

export function codingEnvelope(outcomes: BulkItemOutcome[]): BulkCodingEnvelope {
  const succeeded = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.length - succeeded;
  return {
    ok: outcomes.length === 0 || succeeded > 0,
    total: outcomes.length,
    succeeded,
    failed,
    outcomes,
    items: outcomes.map((o) =>
      o.ok
        ? { workflowId: o.workflowId, ok: true }
        : { workflowId: o.workflowId, ok: false, errorCode: o.code ?? o.denial, message: bulkItemMessage(o) },
    ),
    recordsDecision: false,
    httpStatus: failed === 0 ? 200 : 207,
  };
}

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
 *
 * F-37 — this is "Set assessment tag" in the UI. It writes a coded value
 * only (CodingValue + CodingValueHistory via `writeCodingValue`) and NEVER a
 * WorkflowReviewDecision: the envelope says `recordsDecision: false`, `ok`
 * is false when nothing was written, and `httpStatus` is 207 unless every
 * item was written.
 */
export async function bulkDecide(input: {
  prisma?: PrismaClient;
  teamId: string;
  actorUserId: string;
  verdict: ReviewerVerdict;
  workflowIds: ReadonlyArray<string>;
  rationale?: string;
}): Promise<BulkCodingEnvelope | BulkRefusal> {
  if (input.workflowIds.length === 0) {
    return codingEnvelope([]);
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
    outcomes.push(codingWriteOutcome(id, wrote));
  }
  return codingEnvelope(outcomes);
}

/**
 * Review remediation A/C (2026-11-27) — one bulk item's outcome. Bulk coding
 * sends no expected revision (last writer wins), but every item still goes
 * through writeCodingValue's locked transaction: a workflow that closed or
 * was rebound to another schema before the item obtained the workflow lock
 * is refused (WORKFLOW_CLOSED / SCHEMA_VERSION_MISMATCH), never written. The
 * conflict branch is unreachable without a revision; it is mapped to the
 * existing "another change won the race" outcome for type completeness.
 */
function codingWriteOutcome(
  workflowId: string,
  res: Awaited<ReturnType<typeof writeCodingValue>>,
): BulkItemOutcome {
  if (res.ok) return { workflowId, ok: true };
  if (res.denial === "CODING_VALUE_CONFLICT") {
    return { workflowId, ok: false, denial: "POLICY_REJECTED", code: "concurrent_change" };
  }
  return { workflowId, ok: false, denial: res.denial };
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
}): Promise<BulkCodingEnvelope | BulkRefusal> {
  if (input.workflowIds.length === 0) {
    return codingEnvelope([]);
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
    outcomes.push(codingWriteOutcome(id, res));
  }
  return codingEnvelope(outcomes);
}
