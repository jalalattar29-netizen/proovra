/**
 * Phase 27 — Compliance Export Governance.
 *
 * One function: given (teamId, evidenceId), decide whether the
 * evidence is eligible for compliance export RIGHT NOW. Used by the
 * compliance package builder + audit export + outbound transfer paths.
 *
 * Hard rules:
 *   - Active legal hold → BLOCKED_BY_HOLD. The hold's existence is
 *     enough; the reason text is never returned.
 *   - Lifecycle state ∈ {PENDING_DESTRUCTION, DESTROYED} → BLOCKED_BY_LIFECYCLE.
 *   - Lifecycle state ∈ {ON_HOLD, RETENTION_LOCKED} → BLOCKED_BY_LIFECYCLE
 *     (same outcome class — operator-readable reason carries the detail).
 *   - Active destruction review (non-terminal) → BLOCKED_BY_REVIEW_GATE.
 *   - Immutable retention (policy version says immutable=true) does NOT
 *     block export — it only blocks destruction.
 *   - Everything else → ALLOWED.
 *
 * The check NEVER mutates state. It is safe to call repeatedly from
 * the UI; the operator dashboard polls this for the "ready to export"
 * column.
 *
 * The check emits one SecurityEvent + one metric bump on BLOCKED
 * outcomes (so operators see attempt rates). ALLOWED is silent —
 * routine export traffic should not pollute the security feed.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  type EvidenceLifecycleState,
  type ExportEligibilityResult,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

const REVIEW_GATING_STATUSES = ["PENDING", "UNDER_REVIEW", "DEFERRED", "APPROVED"];

export type CheckExportEligibilityInput = {
  teamId: string;
  evidenceId: string;
  actorUserId?: string | null;
};

export async function checkExportEligibility(
  input: CheckExportEligibilityInput,
  client: PrismaClient = defaultPrisma,
): Promise<ExportEligibilityResult> {
  const ev = await client.evidence.findFirst({
    where: { id: input.evidenceId, teamId: input.teamId },
    select: {
      id: true,
      lifecycleState: true,
      caseLinks: { select: { caseId: true }, take: 100 },
    },
  });
  if (!ev) {
    return {
      outcome: "BLOCKED_BY_POLICY",
      reason: "evidence_not_found",
      lifecycleState: null,
    };
  }
  const lifecycleState = ev.lifecycleState as EvidenceLifecycleState;

  // Hold check FIRST — the most-restrictive signal wins.
  const directHold = await client.evidenceLegalHold.findFirst({
    where: {
      evidenceId: ev.id,
      status: prismaPkg.LegalHoldStatus.ACTIVE,
    },
    select: { id: true },
  });
  // Track 1B closure — a hold on ANY linked case blocks the export.
  let caseHold: { id: string } | null = null;
  const linkedCaseIds = ev.caseLinks.map((l) => l.caseId);
  if (!directHold && linkedCaseIds.length > 0) {
    // PHASE 12 POINT 3 — canonical-only (scope=CASE).
    caseHold = await client.evidenceLegalHold.findFirst({
      where: {
        scope: prismaPkg.LegalHoldScope.CASE,
        caseId: { in: linkedCaseIds },
        status: prismaPkg.LegalHoldStatus.ACTIVE,
      },
      select: { id: true },
    });
  }
  if (directHold || caseHold) {
    emitBlocked(input, "BLOCKED_BY_HOLD", {
      lifecycleState,
      directHold: Boolean(directHold),
      caseHold: Boolean(caseHold),
    });
    return {
      outcome: "BLOCKED_BY_HOLD",
      reason: "active_legal_hold",
      lifecycleState,
    };
  }

  // Lifecycle gating.
  if (lifecycleState === "DESTROYED") {
    emitBlocked(input, "BLOCKED_BY_LIFECYCLE", { lifecycleState });
    return {
      outcome: "BLOCKED_BY_LIFECYCLE",
      reason: "evidence_destroyed",
      lifecycleState,
    };
  }
  if (lifecycleState === "PENDING_DESTRUCTION") {
    emitBlocked(input, "BLOCKED_BY_LIFECYCLE", { lifecycleState });
    return {
      outcome: "BLOCKED_BY_LIFECYCLE",
      reason: "pending_destruction",
      lifecycleState,
    };
  }
  if (lifecycleState === "ON_HOLD") {
    emitBlocked(input, "BLOCKED_BY_LIFECYCLE", { lifecycleState });
    return {
      outcome: "BLOCKED_BY_LIFECYCLE",
      reason: "lifecycle_on_hold",
      lifecycleState,
    };
  }
  if (lifecycleState === "RETENTION_LOCKED") {
    emitBlocked(input, "BLOCKED_BY_LIFECYCLE", { lifecycleState });
    return {
      outcome: "BLOCKED_BY_LIFECYCLE",
      reason: "retention_locked",
      lifecycleState,
    };
  }

  // Active review gate — a non-terminal destruction review pauses
  // export until the review resolves. APPROVED counts because the
  // evidence is queued for execution.
  const activeReview = await client.destructionReview.findFirst({
    where: {
      evidenceId: ev.id,
      teamId: input.teamId,
      status: { in: REVIEW_GATING_STATUSES },
    },
    select: { id: true, status: true },
  });
  if (activeReview) {
    emitBlocked(input, "BLOCKED_BY_REVIEW_GATE", {
      lifecycleState,
      destructionReviewId: activeReview.id,
      destructionReviewStatus: activeReview.status,
    });
    return {
      outcome: "BLOCKED_BY_REVIEW_GATE",
      reason: "active_destruction_review",
      lifecycleState,
    };
  }

  return {
    outcome: "ALLOWED",
    reason: "ok",
    lifecycleState,
  };
}

function emitBlocked(
  input: CheckExportEligibilityInput,
  outcome:
    | "BLOCKED_BY_HOLD"
    | "BLOCKED_BY_LIFECYCLE"
    | "BLOCKED_BY_REVIEW_GATE",
  details: Record<string, unknown>,
): void {
  bump("export_blocked_by_lifecycle_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "export_blocked_by_lifecycle",
    severity: "WARNING",
    evidenceId: input.evidenceId,
    details: {
      outcome,
      actorUserId: input.actorUserId ?? null,
      ...details,
    },
  });
}
