/**
 * Phase 27 — Compliance Export Governance.
 *
 * One function: given (teamId, evidenceId), decide whether the
 * evidence is eligible for compliance export RIGHT NOW. Used by the
 * compliance package builder + audit export + outbound transfer paths.
 *
 * Hard rules:
 *   - Active legal hold → BLOCKED_BY_HOLD. The hold's existence is
 *     enough; the reason text is never returned. (2026-09-29) "Active" is
 *     THE effective-hold union — evidence, case AND workspace scope — from
 *     `evaluateEffectiveLegalHold`, fail-closed: a hold state that cannot
 *     be read blocks. A workspace-scoped hold used to be invisible here.
 *   - Lifecycle state TRASHED (or a legacy deleted row) → BLOCKED_BY_LIFECYCLE.
 *
 * ONE RULE FOR EVERY BYTE BOUNDARY (2026-09-29). This verdict governs the
 * original, its parts, the report, the package, the case export and the SIU
 * bundle alike. A hold PRESERVES: it blocks release of bytes out of custody
 * and every destructive or replacing action, never the in-app record view,
 * and never the creation of a first missing output (which replaces nothing).
 * Personal records (no workspace row) are checked too: `teamId` is the
 * PERSISTED value, null included.
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
import {
  type EvidenceLifecycleState,
  type ExportEligibilityResult,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { resolveEvidenceWorkspaceId } from "@proovra/shared-runtime";
import { evaluateEffectiveLegalHold } from "@proovra/shared-runtime";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

const REVIEW_GATING_STATUSES = ["PENDING", "UNDER_REVIEW", "DEFERRED", "APPROVED"];

export type CheckExportEligibilityInput = {
  /** The record's PERSISTED workspace — null for a Personal record. */
  teamId: string | null;
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
      deletedAt: true,
      ownerUserId: true,
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

  // Hold check FIRST — the most-restrictive signal wins. THE union evaluator
  // (evidence, case and workspace scope); it throws on a transient failure,
  // and an unreadable hold state blocks rather than releasing bytes.
  const linkedCaseIds = ev.caseLinks.map((l) => l.caseId);
  let held: { held: boolean; reasonCode: string | null };
  try {
    held = await evaluateEffectiveLegalHold(client, {
      // A Personal record (team_id NULL) is held through its owner's personal
      // workspace: that is where its holds are recorded (teamId is required).
      teamId:
        input.teamId ??
        (await resolveEvidenceWorkspaceId({ teamId: null, ownerUserId: ev.ownerUserId }, client)),
      evidenceId: ev.id,
      caseIds: linkedCaseIds,
    });
  } catch {
    held = { held: true, reasonCode: "UNRESOLVED_HOLD" };
  }
  if (held.held) {
    emitBlocked(input, "BLOCKED_BY_HOLD", {
      lifecycleState,
      holdSource: held.reasonCode,
    });
    return {
      outcome: "BLOCKED_BY_HOLD",
      reason: "active_legal_hold",
      lifecycleState,
    };
  }

  // A trashed record is not exported (legacy rows carry only deletedAt).
  if (String(ev.lifecycleState) === "TRASHED" || ev.deletedAt != null) {
    emitBlocked(input, "BLOCKED_BY_LIFECYCLE", { lifecycleState });
    return {
      outcome: "BLOCKED_BY_LIFECYCLE",
      reason: "evidence_trashed",
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
      // A Personal record (no workspace row) is matched by the record alone.
      ...(input.teamId ? { teamId: input.teamId } : {}),
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
