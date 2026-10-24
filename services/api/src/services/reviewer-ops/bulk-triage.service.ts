/**
 * Phase 25.5 — Bulk triage service.
 *
 * Operator-driven multi-workflow actions. Each item runs through the
 * Phase 25 reviewer-ops engine (or the Phase 13 legacy service for the
 * actions it already supports), so the audit / metrics / event chain
 * stays consistent with single-item operations.
 *
 * Hard rules:
 *   - Bounded at REVIEWER_OPS_BULK_MAX_ITEMS (100). The route layer
 *     re-bounds via the shared schema.
 *   - Partial-success aware — one row's failure does NOT roll back
 *     other rows; we return a per-item result list.
 *   - Step-up gating is the route's responsibility (the workspace
 *     `requireStepUpForBulk` flag drives the prompt). The service is
 *     the safety net: it never bypasses the engine.
 *   - The audit trail is the union of single-item audits — every
 *     successful row writes its own SecurityEvent / PlatformAuditLog
 *     via the engine.
 */

import { recordLifecycleTransition, ReviewOperationError } from "../review-operations/review-operations.service.js";
import type { PrismaClient } from "@prisma/client";
import {
  REVIEWER_OPS_BULK_ITEM_ERRORS,
  type ReviewerOpsBulkAction,
  type ReviewerOpsBulkInput,
  type ReviewerOpsBulkItemErrorCode,
  type ReviewerOpsBulkItemResult,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { recordReviewActivityTx } from "../evidence-review/reviewer-audit.service.js";
import {
  ReviewerOpsError,
  assignReviewerToWorkflow,
  pauseReview,
  requestInformation,
  type LifecycleActorContext,
} from "./reviewer-operations-engine.service.js";
import {
  EscalationEngineError,
} from "./escalation-engine.service.js";

// -----------------------------------------------------------------------------
// Result shape
// -----------------------------------------------------------------------------

export type BulkTriageResult = {
  total: number;
  succeeded: number;
  failed: number;
  items: ReviewerOpsBulkItemResult[];
  /** The request this run belongs to — the support reference for a failed row. */
  requestId: string | null;
};

/**
 * Where an UNEXPECTED row failure goes: the route hands in its request-scoped
 * logger + Sentry capture, so the full error is kept server-side with the
 * request id and the workflow id beside it, and never reaches the response.
 */
export type BulkTriageObserver = {
  requestId?: string | null;
  reportUnexpected?: (input: { workflowId: string; err: unknown }) => void;
};

// -----------------------------------------------------------------------------
// Row error classification — the bulk item error contract
// -----------------------------------------------------------------------------

/**
 * Engine refusals that mean "someone else changed this review first". The
 * engines report a lost conditional write as an invalid transition carrying
 * one of these reasons; a bulk row names it REVIEW_CONFLICT.
 */
const CONFLICT_REASONS = new Set([
  "concurrent_change",
  "already_assigned_elsewhere",
  "stale_decision",
]);

const ENGINE_CODES_KEPT: ReadonlySet<string> = new Set<ReviewerOpsBulkItemErrorCode>([
  "REVIEW_WORKFLOW_NOT_FOUND",
  "REVIEW_NOTE_REQUIRED",
  "REVIEW_PERMISSION_DENIED",
  "REVIEW_GOVERNANCE_BLOCKED",
  "REVIEW_ESCALATION_EXISTS",
  "REVIEW_ACTOR_BLOCKED",
  "REVIEW_CONFLICT",
]);

/**
 * One thrown error → one bulk item code. Typed refusals map to their code;
 * anything else is REVIEW_ITEM_FAILED, the only outcome reported as an error.
 * Exported for the contract tests.
 */
export function classifyBulkItemError(err: unknown): {
  code: ReviewerOpsBulkItemErrorCode;
  unexpected: boolean;
} {
  if (err instanceof ReviewerOpsError || err instanceof EscalationEngineError) {
    const reason = (err.details as { reason?: unknown } | undefined)?.reason;
    if (typeof reason === "string" && CONFLICT_REASONS.has(reason)) {
      return { code: "REVIEW_CONFLICT", unexpected: false };
    }
    if (ENGINE_CODES_KEPT.has(err.code)) {
      return { code: err.code as ReviewerOpsBulkItemErrorCode, unexpected: false };
    }
    // An escalation that is missing behaves as its workflow: not found.
    if (err.code === "REVIEW_ESCALATION_NOT_FOUND") {
      return { code: "REVIEW_WORKFLOW_NOT_FOUND", unexpected: false };
    }
    // Every other typed engine refusal (an invalid move, an SLA or terminal
    // escalation state) is a stage the action does not apply to.
    return { code: "REVIEW_INVALID_TRANSITION", unexpected: false };
  }
  if (err instanceof ReviewOperationError) {
    const reason = (err.details as { reason?: unknown } | undefined)?.reason;
    switch (err.code) {
      case "workflow_not_found":
      case "evidence_not_in_workspace":
        return { code: "REVIEW_WORKFLOW_NOT_FOUND", unexpected: false };
      case "note_required":
        return { code: "REVIEW_NOTE_REQUIRED", unexpected: false };
      case "permission_denied":
        return { code: "REVIEW_PERMISSION_DENIED", unexpected: false };
      case "already_assigned_elsewhere":
        return { code: "REVIEW_CONFLICT", unexpected: false };
      case "invalid_stage_transition":
        return typeof reason === "string" && CONFLICT_REASONS.has(reason)
          ? { code: "REVIEW_CONFLICT", unexpected: false }
          : { code: "REVIEW_INVALID_TRANSITION", unexpected: false };
      case "already_in_stage":
        return { code: "REVIEW_INVALID_TRANSITION", unexpected: false };
    }
  }
  return { code: "REVIEW_ITEM_FAILED", unexpected: true };
}

function failedItem(
  workflowId: string,
  code: ReviewerOpsBulkItemErrorCode,
): ReviewerOpsBulkItemResult {
  const { message, nextAction } = REVIEWER_OPS_BULK_ITEM_ERRORS[code];
  return {
    workflowId,
    ok: false,
    errorCode: code,
    message,
    ...(nextAction ? { nextAction } : {}),
  };
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

export async function executeBulkTriage(
  ctx: LifecycleActorContext,
  input: ReviewerOpsBulkInput,
  client: PrismaClient = defaultPrisma,
  observer: BulkTriageObserver = {},
): Promise<BulkTriageResult> {
  // The shared zod schema has already bounded array length + action.
  const items: ReviewerOpsBulkItemResult[] = [];

  // Deduplicate workflowIds while preserving order — operators sometimes
  // shift-click duplicates; we don't want to fire the action twice.
  const seen = new Set<string>();
  const uniqueIds = input.workflowIds.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  for (const workflowId of uniqueIds) {
    try {
      await runOne(ctx, input, workflowId, client);
      items.push({ workflowId, ok: true });
    } catch (err) {
      // The row says WHICH refusal, in the contract's fixed words. It never
      // carries the error's own text: an unexpected error is kept for the
      // server log and Sentry only.
      const { code, unexpected } = classifyBulkItemError(err);
      if (unexpected) observer.reportUnexpected?.({ workflowId, err });
      items.push(failedItem(workflowId, code));
    }
  }

  const succeeded = items.filter((i) => i.ok).length;
  const failed = items.length - succeeded;

  // Metric + audit at the BULK level. Per-row events come from the
  // engine's single-item paths.
  bump("reviewer_bulk_action_total");
  if (failed > 0) bump("reviewer_bulk_action_partial_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "reviewer_bulk_triage_executed",
    severity: failed > 0 ? "WARNING" : "INFO",
    details: {
      actorUserId: ctx.actorUserId,
      action: input.action,
      total: items.length,
      succeeded,
      failed,
    },
  });
  await emitTenantAudit(
    {
      action: "reviewer.bulk_triage",
      outcome: failed > 0 ? "error" : "success",
      severity: failed > 0 ? "warning" : "info",
      sourceApp: "API",
      actorUserId: ctx.actorUserId,
      workspaceId: ctx.teamId,
      resourceType: "review_workflow",
      resourceId: null,
      metadata: {
        action: input.action,
        total: items.length,
        succeeded,
        failed,
      },
    },
    client,
  );

  return {
    total: items.length,
    succeeded,
    failed,
    items,
    requestId: observer.requestId ?? null,
  };
}

// -----------------------------------------------------------------------------
// Per-row dispatcher
// -----------------------------------------------------------------------------

async function runOne(
  ctx: LifecycleActorContext,
  input: ReviewerOpsBulkInput,
  workflowId: string,
  client: PrismaClient,
): Promise<void> {
  const action: ReviewerOpsBulkAction = input.action;
  // A note of only whitespace is no note (2026-10-24): Escalate, Pause and
  // Request information refuse it as REVIEW_NOTE_REQUIRED, never as a stage
  // error from further down.
  const note = input.note?.trim() ? input.note.trim() : null;
  switch (action) {
    case "ASSIGN":
    case "REASSIGN": {
      if (!input.assignedToUserId) {
        throw new ReviewerOpsError("REVIEW_PERMISSION_DENIED", {
          reason: "missing_assignee",
        });
      }
      await assignReviewerToWorkflow(
        ctx,
        {
          workflowId,
          assignedToUserId: input.assignedToUserId,
          note: input.note ?? null,
        },
        client,
      );
      return;
    }
    case "ESCALATE": {
      if (!note) {
        throw new ReviewerOpsError("REVIEW_NOTE_REQUIRED");
      }
      // THE ONE ESCALATE (2026-10-24), as Close below: a bulk Escalate used
      // to open an escalation row by itself — no move to Escalated, no
      // Review history, no reviewer audit, separate writes. It now goes
      // through the lifecycle authority, so a bulk and a single Escalate
      // produce the same record: the move, the escalation routed to the
      // admins, its event and its audit in one transaction.
      const wf = await client.evidenceReviewWorkflow.findFirst({
        where: { id: workflowId, teamId: ctx.teamId },
        select: { evidenceId: true },
      });
      if (!wf) throw new ReviewerOpsError("REVIEW_WORKFLOW_NOT_FOUND");
      await recordLifecycleTransition(
        {
          evidenceId: wf.evidenceId,
          decision: "ESCALATE",
          actorUserId: ctx.actorUserId,
          note,
          escalationReason: note,
        },
        client,
      );
      return;
    }
    case "PAUSE": {
      if (!note) {
        throw new ReviewerOpsError("REVIEW_NOTE_REQUIRED");
      }
      await pauseReview(
        ctx,
        { workflowId, pausedReason: note },
        client,
      );
      return;
    }
    case "REQUEST_INFO": {
      if (!note) {
        throw new ReviewerOpsError("REVIEW_NOTE_REQUIRED");
      }
      await requestInformation(
        ctx,
        { workflowId, note },
        client,
      );
      return;
    }
    case "CLOSE": {
      // CLOSE IS NEVER A VERDICT (2026-10-24). This used to record a REJECT
      // decision ("Not accepted") for every review closed in bulk. Close
      // ends the workflow and keeps whatever the current round decided — or
      // no decision — through the one lifecycle authority.
      // Missing and foreign read the same (2026-10-24): this was a
      // findFirstOrThrow, whose Prisma error surfaced as an invalid transition
      // with Prisma's own text as the message.
      const wf = await client.evidenceReviewWorkflow.findFirst({
        where: { id: workflowId, teamId: ctx.teamId },
        select: { evidenceId: true },
      });
      if (!wf) throw new ReviewerOpsError("REVIEW_WORKFLOW_NOT_FOUND");
      await recordLifecycleTransition(
        {
          evidenceId: wf.evidenceId,
          decision: "CLOSE",
          actorUserId: ctx.actorUserId,
          note: note ?? "Closed via bulk triage.",
        },
        client,
      );
      return;
    }
    case "PRIORITY_HIGH":
    case "PRIORITY_NORMAL":
    case "PRIORITY_URGENT": {
      // Priority changes don't go through the lifecycle gate, but each one
      // is a Review action like any other (2026-10-24): the change, its
      // PRIORITY_CHANGED history event and its reviewer + tenant audit
      // commit together. An unchanged priority writes nothing.
      const priorityValue =
        action === "PRIORITY_HIGH"
          ? "HIGH"
          : action === "PRIORITY_URGENT"
            ? "URGENT"
            : "NORMAL";
      const row = await client.evidenceReviewWorkflow.findFirst({
        where: { id: workflowId, teamId: ctx.teamId },
        select: { id: true, priority: true, evidenceId: true, status: true },
      });
      if (!row) {
        throw new ReviewerOpsError("REVIEW_WORKFLOW_NOT_FOUND");
      }
      if (String(row.priority) === priorityValue) return;
      await client.$transaction(async (tx) => {
        await tx.evidenceReviewWorkflow.update({
          where: { id: workflowId },
          data: { priority: priorityValue as never },
        });
        await tx.evidenceReviewWorkflowEvent.create({
          data: {
            workflowId,
            evidenceId: row.evidenceId,
            actorUserId: ctx.actorUserId,
            eventType: "PRIORITY_CHANGED",
            previousValue: { priority: String(row.priority) },
            nextValue: { priority: priorityValue },
            note: input.note?.slice(0, 1000) ?? null,
          },
        });
        await recordReviewActivityTx(tx, {
          evidenceId: row.evidenceId,
          workflowId,
          teamId: ctx.teamId,
          actorUserId: ctx.actorUserId,
          code: "REVIEW_PRIORITY_CHANGED",
          previousState: String(row.status),
          resultingState: String(row.status),
        });
      });
      return;
    }
    default: {
      const exhaustive: never = action;
      throw new ReviewerOpsError("REVIEW_INVALID_TRANSITION", {
        reason: `unsupported_action:${String(exhaustive)}`,
      });
    }
  }
}

// Re-export so the route layer can import everything from one place.
export type { ReviewerOpsBulkInput, ReviewerOpsBulkItemResult };
