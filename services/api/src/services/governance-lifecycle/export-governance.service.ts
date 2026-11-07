/**
 * Phase 27 — Compliance Export Governance.
 *
 * One function: given (teamId, evidenceId), decide whether the
 * evidence is eligible for compliance export RIGHT NOW. Used by the
 * compliance package builder + audit export + outbound transfer paths.
 *
 * Hard rules:
 *   - GOV-012 (2026-11-06): an active hold blocks every byte release BY DEFAULT.
 *     Only when the workspace owner set legalHoldDisclosure =
 *     ALLOW_AUTHENTICATED_RECORDED is an authenticated release to the workspace's
 *     own people allowed and flagged `underLegalHold` (an anonymous public
 *     release stays refused); the custody writers in
 *     artifact-download-gate.service.ts record it. Destruction and replacement
 *     stay refused under hold (lifecycle-orchestrator, executor, package gate).
 *     The paragraph below is the previous rule, kept for its scope notes.
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
 *   - An APPROVED destruction review → BLOCKED_BY_REVIEW_GATE: a person has
 *     decided this record goes. A review that is merely open is a question, not a
 *     decision, and never takes a record's downloads away (GOV-006).
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

const REVIEW_GATING_STATUSES = ["APPROVED"];

export type CheckExportEligibilityInput = {
  /** The record's PERSISTED workspace — null for a Personal record. */
  teamId: string | null;
  evidenceId: string;
  actorUserId?: string | null;
  /**
   * OPS-13 — the caller is the READ-ONLY eligibility preflight
   * (GET /v1/governance/export-eligibility), which asks whether an export
   * WOULD be allowed. Nothing was attempted, so a "blocked" answer is recorded
   * at INFO; only a real export refused by the lifecycle is WARNING.
   */
  preflight?: boolean;
  /**
   * GOV-012 — who the bytes are released to. By default a hold refuses every
   * byte release. When the workspace owner opted in (legalHoldDisclosure =
   * ALLOW_AUTHENTICATED_RECORDED), `workspace` (the default audience) is an
   * authenticated release the caller records on the custody chain; `public`, an
   * anonymous Public Verify release, stays refused under hold either way.
   */
  audience?: "workspace" | "public";
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
  // A Personal record (team_id NULL) is held through its owner's personal
  // workspace: that is where its holds (and its disclosure setting) live.
  let holdWorkspaceId: string | null = input.teamId;
  try {
    holdWorkspaceId =
      input.teamId ??
      (await resolveEvidenceWorkspaceId({ teamId: null, ownerUserId: ev.ownerUserId }, client));
    held = await evaluateEffectiveLegalHold(client, {
      teamId: holdWorkspaceId as string,
      evidenceId: ev.id,
      caseIds: linkedCaseIds,
    });
  } catch {
    held = { held: true, reasonCode: "UNRESOLVED_HOLD" };
  }
  // GOV-012 — OPT-IN. By default (BLOCK) a hold refuses every byte release, as
  // it always has. Only a workspace whose OWNER chose ALLOW_AUTHENTICATED_RECORDED
  // releases a held record, and only to an authenticated caller.
  const disclosure = held.held && (input.audience ?? "workspace") === "workspace" && holdWorkspaceId
    ? await client.workspaceGovernancePolicy
        .findUnique({ where: { teamId: holdWorkspaceId }, select: { legalHoldDisclosure: true } })
        .then((r) => r?.legalHoldDisclosure ?? "BLOCK")
        .catch(() => "BLOCK")
    : "BLOCK";
  if (held.held && ((input.audience ?? "workspace") === "public" || disclosure !== "ALLOW_AUTHENTICATED_RECORDED")) {
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
  // GOV-012 — an authenticated release under hold continues to the lifecycle
  // and review gates below and, if allowed, says so: the caller's custody
  // event records that the bytes left while the record was held.
  const underLegalHold = held.held;

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

  // Review gate — APPROVED means the evidence is queued for execution. Expiry
  // opens reviews by itself, so gating on an open review removed downloads on a
  // date nobody chose, and a workspace off the plan could not clear it.
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

  if (underLegalHold) {
    return { outcome: "ALLOWED", reason: "ok_under_legal_hold", lifecycleState, underLegalHold: true };
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
    severity: input.preflight ? "INFO" : "WARNING",
    evidenceId: input.evidenceId,
    details: {
      outcome,
      actorUserId: input.actorUserId ?? null,
      ...details,
    },
  });
}
