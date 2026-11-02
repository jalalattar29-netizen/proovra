/**
 * Phase 27 — Destruction Review Service.
 *
 * Owns the operator-approval queue for evidence destruction. Every
 * destruction proposal lands here as a row; reviewers move it through
 * the state machine; only `EXECUTED` actually destroys the evidence,
 * and that step emits a destruction certificate.
 *
 * Hard rules:
 *   - Only ONE non-terminal review may exist per evidence. The
 *     service refuses a second create with `DESTRUCTION_REVIEW_ACTIVE`.
 *   - Transitions are validated against the shared
 *     `DESTRUCTION_REVIEW_TRANSITIONS` table. Anything outside is
 *     refused with `DESTRUCTION_REVIEW_INVALID_TRANSITION`.
 *   - Two people (GOV-003): whoever proposed destruction cannot approve it.
 *     The proposer is the person who opened the review, or on a review a
 *     sweep opened, the person who took it up.
 *   - Approval is a decision, not the point of no return (GOV-002). It is
 *     refused while a dated barrier stands, with that date (GOV-007), and
 *     reversible until a person asks for EXECUTED. Nothing reaches storage
 *     without that request, including the worker sweep.
 *   - Hold-aware: APPROVED + EXECUTED are refused while a legal hold
 *     is active. The hold check is delegated to the lifecycle
 *     orchestrator (single source of truth).
 *   - Immutable-aware: EXECUTED is refused when the bound retention
 *     policy version is `immutable=true`. Operators must supersede
 *     the policy before destruction.
 *   - Destruction certificate: the EXECUTED transition produces a
 *     canonical JSON certificate, hashes it (SHA-256), stores the hash
 *     on the review row, and writes the full certificate body into
 *     the lifecycle ledger event `metadata`. The Evidence row is then
 *     moved to `DESTROYED` via the orchestrator (single writer).
 *   - DENIED → RESTORED puts the evidence back to ACTIVE via the
 *     orchestrator. This is the explicit "false alarm" path.
 *
 * The service NEVER stores privileged legal text. Decision notes are
 * operator-readable but bounded to 2000 chars and clipped.
 */

import type { PrismaClient, DestructionReview as DbReview } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  DESTRUCTION_REVIEW_REASONS,
  DESTRUCTION_REVIEW_STATUSES,
  isAllowedDestructionReviewTransition,
  isDestructionBoundState,
  isTerminalDestructionReviewStatus,
  type DestructionReviewReason,
  type DestructionReviewStatus,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
// `canonicalJson` / `sha256Hex` used to be imported here so this service could
// mint its own destruction certificate hash. It no longer mints one: the
// canonical executor does, after verifying the deletion, and this service
// mirrors that hash onto the review row.
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { recordIncident } from "../observability/incident.service.js";
import {
  preflightLifecycleTransition,
  recordLifecycleEvent,
  transitionLifecycle,
} from "./lifecycle-orchestrator.service.js";
// EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — this service triggers the ONE
// canonical destruction executor instead of writing DESTROYED itself.
//
// WORKSPACE-SCOPE CONVERGENCE (2026-08-24) — and reads its candidate
// population through the ONE canonical workspace scope, so a personal
// workspace's legacy NULL-team evidence is not silently skipped by a
// destruction sweep that reports success.
//
// Both are additive imports from the same package; neither replaces the other.
import {
  destructionExecutionEnabled,
  executeEvidenceDestruction,
  workspaceEvidenceWhere,
} from "@proovra/shared-runtime";
import { apiEvidenceDestructionStorage } from "../evidence/destruction-storage-port.js";
import { evaluateEffectiveLegalHold } from "@proovra/shared-runtime";
import { readDestructionBarriers } from "./destruction-barriers.service.js";

// -----------------------------------------------------------------------------
// Error
// -----------------------------------------------------------------------------

export type DestructionReviewErrorCode =
  | "DESTRUCTION_REVIEW_NOT_FOUND"
  | "DESTRUCTION_REVIEW_ACTIVE"
  | "DESTRUCTION_REVIEW_INVALID"
  | "DESTRUCTION_REVIEW_INVALID_TRANSITION"
  | "DESTRUCTION_REVIEW_TERMINAL"
  | "DESTRUCTION_REVIEW_BLOCKED_BY_HOLD"
  | "DESTRUCTION_REVIEW_BLOCKED_BY_IMMUTABLE"
  | "DESTRUCTION_REVIEW_BLOCKED_BY_LIFECYCLE"
  | "DESTRUCTION_REVIEW_BLOCKED_BY_RETENTION"
  | "DESTRUCTION_REVIEW_SEPARATION_OF_DUTIES"
  | "DESTRUCTION_EXECUTION_DISABLED"
  | "DESTRUCTION_REVIEW_DECISION_NOTE_REQUIRED";

export class DestructionReviewError extends Error {
  constructor(
    public readonly code: DestructionReviewErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "DestructionReviewError";
  }
}

// -----------------------------------------------------------------------------
// Projection
// -----------------------------------------------------------------------------

export type DestructionReviewProjection = {
  id: string;
  teamId: string;
  evidenceId: string;
  retentionPolicyId: string | null;
  retentionPolicyVersion: number | null;
  status: DestructionReviewStatus;
  reason: DestructionReviewReason;
  decisionNote: string | null;
  deferredUntilUtc: string | null;
  initiatedByUserId: string | null;
  decidedByUserId: string | null;
  decidedAtUtc: string | null;
  reviewStartedByUserId: string | null;
  executionRequestedAtUtc: string | null;
  executionRequestedByUserId: string | null;
  executedAtUtc: string | null;
  certificateHash: string | null;
  createdAt: string;
  updatedAt: string;
};

export function projectReview(row: DbReview): DestructionReviewProjection {
  return {
    id: row.id,
    teamId: row.teamId,
    evidenceId: row.evidenceId,
    retentionPolicyId: row.retentionPolicyId,
    retentionPolicyVersion: row.retentionPolicyVersion,
    status: row.status as DestructionReviewStatus,
    reason: row.reason as DestructionReviewReason,
    decisionNote: row.decisionNote,
    deferredUntilUtc: row.deferredUntilUtc?.toISOString() ?? null,
    initiatedByUserId: row.initiatedByUserId,
    decidedByUserId: row.decidedByUserId,
    decidedAtUtc: row.decidedAtUtc?.toISOString() ?? null,
    reviewStartedByUserId: row.reviewStartedByUserId,
    executionRequestedAtUtc: row.executionRequestedAtUtc?.toISOString() ?? null,
    executionRequestedByUserId: row.executionRequestedByUserId,
    executedAtUtc: row.executedAtUtc?.toISOString() ?? null,
    certificateHash: row.certificateHash,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const VALID_STATUSES = new Set<string>(DESTRUCTION_REVIEW_STATUSES);
const VALID_REASONS = new Set<string>(DESTRUCTION_REVIEW_REASONS);
const NON_TERMINAL_STATUSES: ReadonlyArray<DestructionReviewStatus> = [
  "PENDING",
  "UNDER_REVIEW",
  "DEFERRED",
  "APPROVED",
];

// -----------------------------------------------------------------------------
// Create — open a destruction review on an evidence.
// -----------------------------------------------------------------------------

export type CreateDestructionReviewInput = {
  teamId: string;
  evidenceId: string;
  actorUserId: string;
  reason: DestructionReviewReason;
  retentionPolicyId?: string | null;
  retentionPolicyVersion?: number | null;
  requestId?: string | null;
};

export async function createDestructionReview(
  input: CreateDestructionReviewInput,
  client: PrismaClient = defaultPrisma,
): Promise<DestructionReviewProjection> {
  if (!VALID_REASONS.has(input.reason)) {
    throw new DestructionReviewError("DESTRUCTION_REVIEW_INVALID", {
      reason: input.reason,
    });
  }

  // Ensure the evidence exists in this team.
  const ev = await client.evidence.findFirst({
    where: { id: input.evidenceId, teamId: input.teamId },
    select: { id: true, lifecycleState: true, activeDestructionReviewId: true },
  });
  if (!ev) {
    throw new DestructionReviewError("DESTRUCTION_REVIEW_NOT_FOUND", {
      evidenceId: input.evidenceId,
    });
  }
  if (ev.activeDestructionReviewId) {
    throw new DestructionReviewError("DESTRUCTION_REVIEW_ACTIVE", {
      activeReviewId: ev.activeDestructionReviewId,
    });
  }

  // The orchestrator owns the hold + immutable + transition rules.
  // Pre-flight so we surface the exact reason before touching DB.
  const preflight = await preflightLifecycleTransition(
    {
      teamId: input.teamId,
      evidenceId: input.evidenceId,
      toState: "PENDING_DESTRUCTION",
    },
    client,
  );
  if (!preflight.allowed) {
    if (preflight.code === "LIFECYCLE_BLOCKED_BY_HOLD") {
      bump("destruction_blocked_by_hold_total");
      safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "destruction_blocked_by_hold",
        severity: "WARNING",
        evidenceId: input.evidenceId,
        details: {
          stage: "review_create",
          fromState: preflight.fromState,
          actorUserId: input.actorUserId,
        },
      });
      throw new DestructionReviewError("DESTRUCTION_REVIEW_BLOCKED_BY_HOLD");
    }
    if (preflight.code === "LIFECYCLE_BLOCKED_BY_IMMUTABLE") {
      bump("destruction_blocked_by_immutable_total");
      safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "destruction_blocked_by_immutable",
        severity: "WARNING",
        evidenceId: input.evidenceId,
        details: {
          stage: "review_create",
          fromState: preflight.fromState,
          actorUserId: input.actorUserId,
        },
      });
      throw new DestructionReviewError(
        "DESTRUCTION_REVIEW_BLOCKED_BY_IMMUTABLE",
      );
    }
    throw new DestructionReviewError("DESTRUCTION_REVIEW_BLOCKED_BY_LIFECYCLE", {
      code: preflight.code,
      fromState: preflight.fromState,
    });
  }

  // Atomic: create the review + flip the Evidence pointer + write the
  // ledger event. If anything fails, the whole thing rolls back.
  const created = await client.$transaction(async (tx) => {
    const review = await tx.destructionReview.create({
      data: {
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        retentionPolicyId: input.retentionPolicyId ?? null,
        retentionPolicyVersion: input.retentionPolicyVersion ?? null,
        status: "PENDING",
        reason: input.reason,
        initiatedByUserId: input.actorUserId,
      },
    });
    await tx.evidence.update({
      where: { id: input.evidenceId },
      data: { activeDestructionReviewId: review.id },
    });
    await tx.evidenceLifecycleEvent.create({
      data: {
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        fromState: ev.lifecycleState,
        toState: ev.lifecycleState,
        eventType: "destruction_review_created",
        summary: `Destruction review opened (reason=${input.reason})`,
        metadata: {
          destructionReviewId: review.id,
          reason: input.reason,
          retentionPolicyId: input.retentionPolicyId ?? null,
          retentionPolicyVersion: input.retentionPolicyVersion ?? null,
        } as prismaPkg.Prisma.InputJsonValue,
        actorUserId: input.actorUserId,
        requestId: input.requestId?.slice(0, 64) ?? null,
      },
    });
    return review;
  });

  bump("destruction_review_created_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "destruction_review_created",
    severity: "WARNING",
    evidenceId: input.evidenceId,
    details: {
      destructionReviewId: created.id,
      reason: input.reason,
      actorUserId: input.actorUserId,
    },
  });
  await emitTenantAudit({
    action: "destruction.review.create",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "destruction_review",
    resourceId: created.id,
    correlationId: input.requestId ?? null,
    metadata: {
      evidenceId: input.evidenceId,
      reason: input.reason,
    },
  }, client);
  return projectReview(created);
}

// -----------------------------------------------------------------------------
// Transition — single entry point for all status changes.
// -----------------------------------------------------------------------------

export type TransitionDestructionReviewInput = {
  teamId: string;
  id: string;
  actorUserId: string;
  nextStatus: DestructionReviewStatus;
  decisionNote?: string | null;
  deferredUntilUtc?: Date | null;
  requestId?: string | null;
};

export async function transitionDestructionReview(
  input: TransitionDestructionReviewInput,
  client: PrismaClient = defaultPrisma,
): Promise<DestructionReviewProjection> {
  if (!VALID_STATUSES.has(input.nextStatus)) {
    throw new DestructionReviewError("DESTRUCTION_REVIEW_INVALID");
  }
  const existing = await client.destructionReview.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!existing) {
    throw new DestructionReviewError("DESTRUCTION_REVIEW_NOT_FOUND");
  }
  const from = existing.status as DestructionReviewStatus;
  if (isTerminalDestructionReviewStatus(from) && from !== input.nextStatus) {
    throw new DestructionReviewError("DESTRUCTION_REVIEW_TERMINAL", {
      status: from,
    });
  }
  if (!isAllowedDestructionReviewTransition(from, input.nextStatus)) {
    throw new DestructionReviewError(
      "DESTRUCTION_REVIEW_INVALID_TRANSITION",
      { from, to: input.nextStatus },
    );
  }
  // Decision notes required on APPROVED / DENIED / RESTORED.
  if (
    (input.nextStatus === "APPROVED" ||
      input.nextStatus === "DENIED" ||
      input.nextStatus === "RESTORED") &&
    !input.decisionNote?.trim()
  ) {
    throw new DestructionReviewError(
      "DESTRUCTION_REVIEW_DECISION_NOTE_REQUIRED",
    );
  }
  // GOV-003 — the person who proposed destruction cannot be the one who approves
  // it. Nothing compared them; one administrator could open, take up and approve
  // alone. A sweep-opened review has no initiator, so the person who took it up
  // is the proposer and the approver is still the second person.
  if (input.nextStatus === "APPROVED") {
    const proposer = existing.initiatedByUserId ?? existing.reviewStartedByUserId;
    if (!proposer || proposer === input.actorUserId) {
      throw new DestructionReviewError("DESTRUCTION_REVIEW_SEPARATION_OF_DUTIES");
    }
  }
  let queuedFromState: string | null = existing.queuedFromState;
  // Hold re-check on APPROVED (operators may have placed a hold between
  // create + approve — the hold MUST win).
  if (input.nextStatus === "APPROVED") {
    const preflight = await preflightLifecycleTransition(
      {
        teamId: input.teamId,
        evidenceId: existing.evidenceId,
        toState: "PENDING_DESTRUCTION",
      },
      client,
    );
    if (!preflight.allowed) {
      if (preflight.code === "LIFECYCLE_BLOCKED_BY_HOLD") {
        bump("destruction_blocked_by_hold_total");
        safeEmitSecurityEvent({
          teamId: input.teamId,
          eventType: "destruction_blocked_by_hold",
          severity: "WARNING",
          evidenceId: existing.evidenceId,
          details: {
            stage: "review_approve",
            destructionReviewId: existing.id,
            actorUserId: input.actorUserId,
          },
        });
        throw new DestructionReviewError(
          "DESTRUCTION_REVIEW_BLOCKED_BY_HOLD",
        );
      }
      if (preflight.code === "LIFECYCLE_BLOCKED_BY_IMMUTABLE") {
        bump("destruction_blocked_by_immutable_total");
        safeEmitSecurityEvent({
          teamId: input.teamId,
          eventType: "destruction_blocked_by_immutable",
          severity: "WARNING",
          evidenceId: existing.evidenceId,
          details: {
            stage: "review_approve",
            destructionReviewId: existing.id,
            actorUserId: input.actorUserId,
          },
        });
        throw new DestructionReviewError(
          "DESTRUCTION_REVIEW_BLOCKED_BY_IMMUTABLE",
        );
      }
      throw new DestructionReviewError(
        "DESTRUCTION_REVIEW_BLOCKED_BY_LIFECYCLE",
        { code: preflight.code },
      );
    }
    // GOV-007 — refused with its date while the record cannot be destroyed. This
    // used to be met only at the executor, after approval had queued the record
    // and blocked its downloads, sometimes for years.
    const barriers = await readDestructionBarriers(client, existing.evidenceId);
    if (!barriers.eligible) {
      throw new DestructionReviewError("DESTRUCTION_REVIEW_BLOCKED_BY_RETENTION", {
        blockReason: barriers.blockReason,
        eligibleAtUtc: barriers.eligibleAt?.toISOString() ?? null,
      });
    }
    // The approval QUEUES the record for destruction, through the orchestrator
    // (the single lifecycle writer), BEFORE the review is marked APPROVED, so an
    // approval never exists for a record left ACTIVE. The lifecycle table has no
    // ACTIVE -> DESTROYED edge, so an approved review on an ACTIVE record could
    // never execute (every manual review from the Destruction page ended in 409
    // LIFECYCLE_INVALID_TRANSITION). A trashed or retention-archived record needs
    // no queueing: the executor claims it from where it is (GOV-004).
    if (!isDestructionBoundState(preflight.fromState)) {
      try {
        await transitionLifecycle(
          {
            teamId: input.teamId,
            evidenceId: existing.evidenceId,
            toState: "PENDING_DESTRUCTION",
            actorUserId: input.actorUserId,
            summary: "Destruction review approved — evidence queued for destruction",
            // The review's own destruction_review_approved row is written below.
            eventType: "lifecycle_transition",
            metadata: { destructionReviewId: existing.id },
            requestId: input.requestId ?? null,
          },
          client,
        );
      } catch (err) {
        throw new DestructionReviewError("DESTRUCTION_REVIEW_BLOCKED_BY_LIFECYCLE", {
          code: (err as { code?: string }).code ?? "LIFECYCLE_TRANSITION_FAILED",
        });
      }
    }
    queuedFromState = preflight.fromState;
  }

  // An approved review that is CANCELLED releases the record it queued, back to
  // where approval found it and before the review stops saying so: if the record
  // is under an execution claim this refuses, and the review remains the truth.
  if (input.nextStatus === "CANCELLED" && from === "APPROVED") {
    const backTo = existing.queuedFromState ?? "ACTIVE";
    if (!isDestructionBoundState(backTo)) {
      try {
        await transitionLifecycle(
          {
            teamId: input.teamId,
            evidenceId: existing.evidenceId,
            toState: backTo as DestructionReviewReleaseState,
            actorUserId: input.actorUserId,
            summary: "Approved destruction review cancelled — evidence released from the queue",
            eventType: "lifecycle_transition",
            metadata: { destructionReviewId: existing.id },
            requestId: input.requestId ?? null,
          },
          client,
        );
      } catch (err) {
        throw new DestructionReviewError("DESTRUCTION_REVIEW_BLOCKED_BY_LIFECYCLE", {
          code: (err as { code?: string }).code ?? "LIFECYCLE_TRANSITION_FAILED",
        });
      }
    }
  }

  // EXECUTED has its own dedicated branch — see executeApprovedReview.
  if (input.nextStatus === "EXECUTED") {
    return executeApprovedReview(
      {
        teamId: input.teamId,
        id: input.id,
        actorUserId: input.actorUserId,
        requestId: input.requestId ?? null,
      },
      client,
    );
  }

  const now = new Date();
  const decisionNote = input.decisionNote?.trim().slice(0, 2000) ?? null;

  const updated = await client.$transaction(async (tx) => {
    // Compare-and-set on the status this transition was validated from (GOV-019).
    const moved = await tx.destructionReview.updateMany({
      where: { id: existing.id, status: from },
      data: {
        status: input.nextStatus,
        queuedFromState,
        reviewStartedByUserId:
          input.nextStatus === "UNDER_REVIEW"
            ? existing.reviewStartedByUserId ?? input.actorUserId
            : existing.reviewStartedByUserId,
        // Leaving APPROVED withdraws any execution request with it.
        executionRequestedAtUtc: input.nextStatus === "CANCELLED" ? null : existing.executionRequestedAtUtc,
        executionRequestedByUserId: input.nextStatus === "CANCELLED" ? null : existing.executionRequestedByUserId,
        decisionNote:
          input.nextStatus === "APPROVED" ||
          input.nextStatus === "DENIED" ||
          input.nextStatus === "RESTORED"
            ? decisionNote
            : existing.decisionNote,
        deferredUntilUtc:
          input.nextStatus === "DEFERRED"
            ? input.deferredUntilUtc ?? null
            : existing.deferredUntilUtc,
        decidedByUserId:
          input.nextStatus === "APPROVED" ||
          input.nextStatus === "DENIED" ||
          input.nextStatus === "RESTORED" ||
          input.nextStatus === "CANCELLED"
            ? input.actorUserId
            : existing.decidedByUserId,
        decidedAtUtc:
          input.nextStatus === "APPROVED" ||
          input.nextStatus === "DENIED" ||
          input.nextStatus === "RESTORED" ||
          input.nextStatus === "CANCELLED"
            ? now
            : existing.decidedAtUtc,
      },
    });
    if (moved.count !== 1) {
      throw new DestructionReviewError("DESTRUCTION_REVIEW_INVALID_TRANSITION", {
        from,
        to: input.nextStatus,
        reason: "STATUS_CHANGED",
      });
    }
    const row = await tx.destructionReview.findUniqueOrThrow({ where: { id: existing.id } });

    // Clear the active review pointer on terminal statuses (or RESTORED
    // / DENIED, both of which mean "evidence is no longer queued for
    // destruction"). On non-terminal moves (PENDING ↔ UNDER_REVIEW /
    // DEFERRED) we keep the pointer set.
    if (
      isTerminalDestructionReviewStatus(input.nextStatus) ||
      input.nextStatus === "DENIED"
    ) {
      await tx.evidence.update({
        where: { id: existing.evidenceId },
        data: { activeDestructionReviewId: null },
      });
    }

    return row;
  });

  // Ledger event (separate write — orchestrator owns no state change here).
  await recordLifecycleEvent(
    {
      teamId: input.teamId,
      evidenceId: existing.evidenceId,
      eventType:
        input.nextStatus === "APPROVED"
          ? "destruction_review_approved"
          : input.nextStatus === "DENIED"
            ? "destruction_review_denied"
            : input.nextStatus === "DEFERRED"
              ? "destruction_review_deferred"
              : input.nextStatus === "RESTORED"
                ? "destruction_review_restored"
                : "lifecycle_transition",
      summary: `Destruction review ${input.nextStatus.toLowerCase()}`,
      actorUserId: input.actorUserId,
      metadata: {
        destructionReviewId: existing.id,
        from,
        to: input.nextStatus,
      },
      requestId: input.requestId ?? null,
    },
    client,
  ).catch(() => null);

  // If RESTORED, snap the Evidence back to ACTIVE via the orchestrator
  // (only valid path out of a destruction queue).
  if (input.nextStatus === "RESTORED") {
    await transitionLifecycle(
      {
        teamId: input.teamId,
        evidenceId: existing.evidenceId,
        toState: "ACTIVE",
        actorUserId: input.actorUserId,
        summary: "Destruction review restored — evidence returned to ACTIVE",
        eventType: "destruction_review_restored",
        metadata: { destructionReviewId: existing.id },
        requestId: input.requestId ?? null,
      },
      client,
    ).catch(() => null);
  }

  // Metrics + events.
  if (input.nextStatus === "APPROVED") bump("destruction_review_approved_total");
  if (input.nextStatus === "DENIED") bump("destruction_review_denied_total");
  if (input.nextStatus === "DEFERRED") bump("destruction_review_deferred_total");
  if (input.nextStatus === "RESTORED") bump("destruction_review_restored_total");

  if (
    input.nextStatus === "APPROVED" ||
    input.nextStatus === "DENIED" ||
    input.nextStatus === "DEFERRED" ||
    input.nextStatus === "RESTORED"
  ) {
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType:
        input.nextStatus === "APPROVED"
          ? "destruction_review_approved"
          : input.nextStatus === "DENIED"
            ? "destruction_review_denied"
            : input.nextStatus === "DEFERRED"
              ? "destruction_review_deferred"
              : "destruction_review_restored",
      severity: "WARNING",
      evidenceId: existing.evidenceId,
      details: {
        destructionReviewId: existing.id,
        from,
        to: input.nextStatus,
        actorUserId: input.actorUserId,
      },
    });
    await emitTenantAudit({
      action: `destruction.review.${input.nextStatus.toLowerCase()}`,
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      workspaceId: input.teamId,
      resourceType: "destruction_review",
      resourceId: existing.id,
      correlationId: input.requestId ?? null,
      metadata: {
        evidenceId: existing.evidenceId,
        from,
        to: input.nextStatus,
      },
    }, client);
  }

  return projectReview(updated);
}

// -----------------------------------------------------------------------------
// EXECUTED — destruction certificate emission + lifecycle DESTROYED.
// -----------------------------------------------------------------------------

type ExecuteApprovedReviewInput = {
  teamId: string;
  id: string;
  actorUserId: string;
  requestId?: string | null;
};

type DestructionReviewReleaseState = "ACTIVE" | "UNDER_REVIEW" | "ARCHIVED";

/**
 * GOV-019 — the hash of the certificate the executor already minted for this
 * record, for when this caller lost the race or the executor reports the record
 * was already destroyed. Never a second certificate, and never a null written
 * over a real one.
 */
async function certificateHashFromLedger(
  evidenceId: string,
  client: PrismaClient,
): Promise<string | null> {
  const event = await client.evidenceLifecycleEvent.findFirst({
    where: { evidenceId, eventType: "destruction_executed" },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  const hash = (event?.metadata as { certificateHash?: unknown } | null)?.certificateHash;
  return typeof hash === "string" ? hash : null;
}

async function executeApprovedReview(
  input: ExecuteApprovedReviewInput,
  client: PrismaClient,
): Promise<DestructionReviewProjection> {
  const existing = await client.destructionReview.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!existing) {
    throw new DestructionReviewError("DESTRUCTION_REVIEW_NOT_FOUND");
  }
  const from = existing.status as DestructionReviewStatus;
  if (from !== "APPROVED") {
    throw new DestructionReviewError(
      "DESTRUCTION_REVIEW_INVALID_TRANSITION",
      { from, to: "EXECUTED" },
    );
  }
  if (!destructionExecutionEnabled()) {
    throw new DestructionReviewError("DESTRUCTION_EXECUTION_DISABLED");
  }

  // Final hold + immutable check at execution time (defense in depth —
  // the orchestrator will also refuse if a hold landed in flight).
  const preflight = await preflightLifecycleTransition(
    {
      teamId: input.teamId,
      evidenceId: existing.evidenceId,
      toState: "DESTROYED",
    },
    client,
  );
  if (!preflight.allowed) {
    if (preflight.code === "LIFECYCLE_BLOCKED_BY_HOLD") {
      bump("destruction_blocked_by_hold_total");
      throw new DestructionReviewError(
        "DESTRUCTION_REVIEW_BLOCKED_BY_HOLD",
      );
    }
    if (preflight.code === "LIFECYCLE_BLOCKED_BY_IMMUTABLE") {
      bump("destruction_blocked_by_immutable_total");
      throw new DestructionReviewError(
        "DESTRUCTION_REVIEW_BLOCKED_BY_IMMUTABLE",
      );
    }
    throw new DestructionReviewError(
      "DESTRUCTION_REVIEW_BLOCKED_BY_LIFECYCLE",
      { code: preflight.code },
    );
  }

  // EXECUTE — through the ONE canonical destruction executor.
  //
  // WHAT THIS REPLACES: this function built its OWN destruction certificate
  // body, hashed it, and then called `transitionLifecycle(..., toState:
  // "DESTROYED")`. It contacted storage at no point. An operator who approved a
  // destruction review therefore received a certificate hash, a DESTROYED
  // lifecycle state and a `destruction_executed` ledger entry for a record
  // whose every byte was still in the bucket and still downloadable through the
  // ordinary evidence routes. There was no asynchronous follow-up that would
  // have finished the job: the purge worker only ever considered records it had
  // itself scheduled, and it skipped anything already in a terminal state.
  //
  // The executor holds a lease, re-reads the record, re-computes the canonical
  // eligibility (retention, Object Lock, trash grace, hold, approval, lock),
  // deletes every object the record owns, VERIFIES they are gone, and only then
  // tombstones and mints the certificate. This function no longer produces a
  // certificate of its own — it records the one the executor earned.
  const executedAt = new Date();

  // GOV-002 — this person's request is what authorises execution; the executor
  // reads it back and the worker only ever continues it.
  const requested = await client.destructionReview.updateMany({
    where: { id: existing.id, status: "APPROVED" },
    data: {
      executionRequestedAtUtc: existing.executionRequestedAtUtc ?? executedAt,
      executionRequestedByUserId: existing.executionRequestedByUserId ?? input.actorUserId,
      executionNotBeforeUtc: null,
    },
  });
  if (requested.count !== 1) {
    throw new DestructionReviewError("DESTRUCTION_REVIEW_INVALID_TRANSITION", {
      from,
      to: "EXECUTED",
      reason: "STATUS_CHANGED",
    });
  }

  const evidenceRow = await client.evidence.findUnique({
    where: { id: existing.evidenceId },
    select: { id: true, teamId: true, caseLinks: { select: { caseId: true } } },
  });
  if (!evidenceRow) {
    throw new DestructionReviewError("DESTRUCTION_REVIEW_NOT_FOUND");
  }

  const hold = await evaluateEffectiveLegalHold(client, {
    teamId: evidenceRow.teamId ?? null,
    evidenceId: evidenceRow.id,
    caseIds: (evidenceRow.caseLinks ?? []).map((l) => l.caseId),
  });

  const destruction = await executeEvidenceDestruction(
    client,
    {
      evidenceId: existing.evidenceId,
      trigger: "destruction_review",
      actorUserId: input.actorUserId,
      destructionReviewId: existing.id,
      legalHold: hold.held,
      objectLockExpected: String(process.env.S3_OBJECT_LOCK_ENABLED ?? "").trim().toLowerCase() === "true",
      // Named, not vouched for: the executor reads this review back and refuses
      // unless it is this record's, APPROVED, with an execution request.
      destructionApprovalRequired: true,
      correlationId: input.requestId ?? null,
    },
    apiEvidenceDestructionStorage,
  );

  if (!destruction.ok) {
    if (destruction.outcome === "BLOCKED") {
      if (destruction.reason === "LEGAL_HOLD_ACTIVE") {
        bump("destruction_blocked_by_hold_total");
        throw new DestructionReviewError("DESTRUCTION_REVIEW_BLOCKED_BY_HOLD");
      }
      if (destruction.reason === "DESTRUCTION_EXECUTION_DISABLED") {
        throw new DestructionReviewError("DESTRUCTION_EXECUTION_DISABLED");
      }
      if (
        destruction.reason === "EVIDENCE_LOCKED" ||
        destruction.reason === "RETENTION_POLICY_IMMUTABLE"
      ) {
        bump("destruction_blocked_by_immutable_total");
        throw new DestructionReviewError(
          "DESTRUCTION_REVIEW_BLOCKED_BY_IMMUTABLE",
        );
      }
      if (
        destruction.reason === "APP_RETENTION_ACTIVE" ||
        destruction.reason === "OBJECT_LOCK_RETENTION_ACTIVE"
      ) {
        throw new DestructionReviewError("DESTRUCTION_REVIEW_BLOCKED_BY_RETENTION", {
          blockReason: destruction.reason,
          eligibleAtUtc: destruction.retainedUntilUtc ?? null,
        });
      }
      throw new DestructionReviewError(
        "DESTRUCTION_REVIEW_BLOCKED_BY_LIFECYCLE",
        { code: destruction.reason },
      );
    }
    // Storage refused, or an object survived the delete. The review stays
    // APPROVED — recoverable, retryable, and honestly NOT executed. The
    // execution request stands, so the sweep carries on with it.
    throw new DestructionReviewError(
      "DESTRUCTION_REVIEW_BLOCKED_BY_LIFECYCLE",
      { code: destruction.outcome },
    );
  }

  // The hash the executor minted, mirrored onto the review row. There is no
  // second certificate: a redelivery that finds the record already destroyed
  // records the review as executed with the hash already on the ledger.
  const certificateHash =
    destruction.outcome === "DESTROYED"
      ? destruction.certificateHash
      : await certificateHashFromLedger(existing.evidenceId, client);

  // Flip the review to EXECUTED + clear the active pointer. Compare-and-set: if
  // the worker got here first its row stands and is never overwritten (GOV-019).
  const updated = await client.$transaction(async (tx) => {
    const moved = await tx.destructionReview.updateMany({
      where: { id: existing.id, status: "APPROVED" },
      data: {
        status: "EXECUTED",
        executedAtUtc: executedAt,
        certificateHash,
        decidedByUserId: existing.decidedByUserId ?? input.actorUserId,
        decidedAtUtc: existing.decidedAtUtc ?? executedAt,
      },
    });
    if (moved.count === 1) {
      await tx.evidence.update({
        where: { id: existing.evidenceId },
        data: { activeDestructionReviewId: null },
      });
    }
    return tx.destructionReview.findUniqueOrThrow({ where: { id: existing.id } });
  });

  bump("destruction_executed_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "destruction_executed",
    severity: "HIGH",
    evidenceId: existing.evidenceId,
    details: {
      destructionReviewId: existing.id,
      certificateHash,
      reason: existing.reason,
      actorUserId: input.actorUserId,
    },
  });
  await emitTenantAudit({
    action: "destruction.review.execute",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "destruction_review",
    resourceId: existing.id,
    correlationId: input.requestId ?? null,
    metadata: {
      evidenceId: existing.evidenceId,
      certificateHash,
    },
  }, client);

  // Governance incident at the moment of destruction so the /ops
  // dashboard records it alongside other operator-visible events.
  // Best-effort; never blocks the destruction.
  try {
    await recordIncident(
      {
        sourceId: "governance.destruction_executed",
        teamId: input.teamId,
        category: "GOVERNANCE",
        severity: "HIGH",
        fingerprint: `destruction_executed:${existing.id}`,
        message: {
          code: "ops.governance.destruction_executed",
          params: { reviewId: existing.id, evidenceId: existing.evidenceId },
        },
        relatedEvidenceId: existing.evidenceId,
        metadata: {
          destructionReviewId: existing.id,
          certificateHash,
        },
      },
      client,
    );
  } catch {
    /* best-effort */
  }

  return projectReview(updated);
}

// -----------------------------------------------------------------------------
// Listing — destruction queue for the operator console.
// -----------------------------------------------------------------------------

export type ListDestructionReviewsInput = {
  teamId: string;
  status?: DestructionReviewStatus | "ACTIVE" | "ALL";
  limit?: number;
};

export async function listDestructionReviews(
  input: ListDestructionReviewsInput,
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<DestructionReviewProjection>> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const where: prismaPkg.Prisma.DestructionReviewWhereInput = {
    teamId: input.teamId,
  };
  if (input.status && input.status !== "ALL") {
    if (input.status === "ACTIVE") {
      where.status = { in: NON_TERMINAL_STATUSES as unknown as string[] };
    } else {
      where.status = input.status;
    }
  }
  const rows = await client.destructionReview.findMany({
    where,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: limit,
  });
  return rows.map(projectReview);
}

export async function getDestructionReview(
  input: { teamId: string; id: string },
  client: PrismaClient = defaultPrisma,
): Promise<DestructionReviewProjection> {
  const row = await client.destructionReview.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!row) {
    throw new DestructionReviewError("DESTRUCTION_REVIEW_NOT_FOUND");
  }
  return projectReview(row);
}

// -----------------------------------------------------------------------------
// Dashboard signals — queue depth, blocked counts (gauge feeders).
// -----------------------------------------------------------------------------

export async function countActiveDestructionReviews(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<number> {
  return client.destructionReview.count({
    where: {
      teamId,
      status: { in: NON_TERMINAL_STATUSES as unknown as string[] },
    },
  });
}

export async function countPendingDestructionByEvidence(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<number> {
  // WORKSPACE-SCOPE CONVERGENCE — the canonical workspace population,
  // resolved once for every query below. A strict `teamId` equality here
  // omitted a personal workspace's legacy NULL-team rows, and reported the
  // smaller number as if it were the whole population.
  const scope = await workspaceEvidenceWhere(teamId, client);
  return client.evidence.count({
    where: { AND: [scope], lifecycleState: "PENDING_DESTRUCTION" },
  });
}
