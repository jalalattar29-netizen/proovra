/**
 * The signals a recorded review decision emits (TEAM-SPEC §2.3), emitted ONCE
 * by the decision authority itself (Team remediation T-171, 2026-11-24).
 *
 * Before, only the inspector route and the engine's approve / reject /
 * request-info wrappers called this, so a verdict recorded through the
 * Evidence-page door, the mobile app or bulk request-info was missing from the
 * metrics, the security events and the first-decision audit row. The
 * authority (`recordReviewDecision`) now calls it after commit, so every door
 * emits it exactly once.
 *
 *   - approved / rejected / completed only when the status reached that
 *     terminal stage in this submission (plus a `reviewer.review_completed`
 *     tenant audit row — a completion is never the same event as a first
 *     decision);
 *   - information_requested only when the status moved to NEEDS_MORE_INFO;
 *   - a decision that recorded a stage and moved nothing is
 *     `reviewer.first_decision_recorded` (FIRST) — never "completed";
 *   - an idempotent replay emits nothing.
 */
import type { PrismaClient } from "@prisma/client";
import { mapDbStatusToReviewStage } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { warn as logWarn } from "../../utils/logger.js";

export type DecisionOutcomeForSignals = {
  stageRecorded: "FIRST" | "SECOND" | "ADJUDICATION" | "NONE";
  statusChanged: boolean;
  reviewState: string;
  nextRequirement: "second_review" | "adjudication" | "information" | null;
  idempotent: boolean;
};

async function audit(
  client: PrismaClient,
  action: string,
  input: { teamId: string; actorUserId: string; workflowId: string },
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await emitTenantAudit(
      {
        action,
        outcome: "success",
        sourceApp: "API",
        actorUserId: input.actorUserId,
        workspaceId: input.teamId,
        resourceType: "review_workflow",
        resourceId: input.workflowId,
        metadata,
      },
      client,
    );
  } catch (err) {
    logWarn("reviewer_ops.decision_audit_failed", {
      action,
      workflowId: input.workflowId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function emitDecisionOutcomeSignals(
  input: {
    teamId: string;
    actorUserId: string;
    workflowId: string;
    decision: string;
    workflowStatusAfter: string;
    outcome: DecisionOutcomeForSignals;
    /** Which door recorded it (inspector, legacy, evidence_page, mobile, bulk). Audit metadata only. */
    source?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const { outcome } = input;
  if (outcome.idempotent) return;
  const stageAfter = mapDbStatusToReviewStage(input.workflowStatusAfter);
  const details = {
    workflowId: input.workflowId,
    actorUserId: input.actorUserId,
    stageRecorded: outcome.stageRecorded,
  };
  const completedAs =
    outcome.statusChanged && stageAfter === "APPROVED_INTERNAL"
      ? "approved"
      : outcome.statusChanged && stageAfter === "REJECTED_INSUFFICIENT"
        ? "rejected"
        : null;
  if (completedAs) {
    bump(completedAs === "approved" ? "reviewer_review_approved_total" : "reviewer_review_rejected_total");
    bump("reviewer_review_completed_total");
    // Two literal calls (not one ternary) so every emitted type is a literal
    // the signal-catalogue scan can read; the audit row below is not a
    // security event.
    if (completedAs === "approved") {
      safeEmitSecurityEvent({ teamId: input.teamId, eventType: "reviewer_review_approved", severity: "INFO", details });
    } else {
      safeEmitSecurityEvent({ teamId: input.teamId, eventType: "reviewer_review_rejected", severity: "INFO", details });
    }
    await audit(client, "reviewer.review_completed", input, {
      eventType: "reviewer_review_completed",
      decision: input.decision,
      result: completedAs,
      stageRecorded: outcome.stageRecorded,
      source: input.source ?? null,
    });
    return;
  }
  if (outcome.statusChanged && stageAfter === "NEEDS_MORE_INFO") {
    bump("reviewer_information_requested_total");
    safeEmitSecurityEvent({ teamId: input.teamId, eventType: "reviewer_information_requested", severity: "INFO", details });
    return;
  }
  if (outcome.stageRecorded === "FIRST" && !outcome.statusChanged) {
    await audit(client, "reviewer.first_decision_recorded", input, {
      eventType: "reviewer_first_decision_recorded",
      decision: input.decision,
      reviewState: outcome.reviewState,
      nextRequirement: outcome.nextRequirement,
      source: input.source ?? null,
    });
  }
}
