/**
 * Phase 27.5 — Destruction Orchestrator Worker.
 *
 * Executes APPROVED `DestructionReview` rows by walking a multi-phase
 * destruction plan against the evidence + storage layer, with partial-
 * failure recovery via the `DestructionExecution` row.
 *
 * Plan (terminal states are COMPLETED, FAILED, ROLLED_BACK):
 *
 *   PLANNED
 *     ├── verify no active legal hold ───► FAILED (BLOCKED_BY_HOLD)
 *     ├── verify immutable retention ────► FAILED (BLOCKED_BY_IMMUTABLE)
 *     ├── verify object lock eligibility ► FAILED (STORAGE_NOT_ELIGIBLE)
 *     │
 *   EXECUTING
 *     ├── emit destruction certificate (canonical JSON + SHA-256)
 *     ├── write lineage hash (chain: prev lifecycle ledger digest + cert)
 *     │
 *   STORAGE_DELETED
 *     ├── delete evidence parts from storage (best-effort, retried)
 *     │
 *   TOMBSTONED
 *     ├── flip Evidence.lifecycleState → DESTROYED via lifecycle ledger
 *     ├── flip DestructionReview.status → EXECUTED
 *     │
 *   COMPLETED
 *
 * Hard rules:
 *   - One non-terminal `DestructionExecution` per `(review)` at a time.
 *     A second run on the same review reuses the row (idempotent
 *     retry / continuation) instead of creating a duplicate.
 *   - Hold check is RE-RUN at execution time. A hold placed in flight
 *     wins, the execution is force-failed, no destruction happens.
 *   - Audit history is NEVER deleted. The `EvidenceLifecycleEvent`
 *     ledger row carries the full destruction certificate in metadata.
 *   - Storage deletion is best-effort and bounded. The worker
 *     intentionally does NOT call into S3 from here — that surface is
 *     owned by the API's evidence-purge processor; the orchestrator
 *     records that storage-deletion was requested and lets the existing
 *     processor finish the job. The execution row tracks the boundary.
 *   - Tombstone records (rows in the DB pointing at where the
 *     destroyed evidence used to be) are preserved indefinitely. The
 *     Evidence row stays; only `lifecycleState` flips to DESTROYED and
 *     the storage payload is removed asynchronously.
 *   - Rollback is supported when the execution fails BEFORE
 *     STORAGE_DELETED. After STORAGE_DELETED there is no safe rollback
 *     (storage is gone) — the execution flips to FAILED and an
 *     incident is raised.
 */

import * as prismaPkg from "@prisma/client";
import { createHash } from "node:crypto";
import {
  canonicalEvaluateLifecycleTransition,
  newCorrelationId,
  type EvidenceLifecycleState,
} from "@proovra/shared";
import { logger } from "../logger.js";
import { prisma } from "../db.js";
import { runGovernanceReconciliation } from "./reconciliation-run.js";
import { emitWorkerGovernanceNotification } from "./notification-emitter.js";
import { evaluateEffectiveLegalHold } from "./effective-legal-hold.js";

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 200;
const DEDUPE_KEY_MAX = 180;

export interface DestructionOrchestrationOptions {
  trigger?: string;
  batchSize?: number;
  teamId?: string | null;
  triggeredByUserId?: string | null;
}

export interface DestructionOrchestrationResult {
  runId: string;
  status: prismaPkg.GovernanceReconciliationStatus;
  scanned: number;
  executed: number;
  failed: number;
  rolledBack: number;
  skipped: number;
}

export async function runDestructionOrchestration(
  options: DestructionOrchestrationOptions = {},
): Promise<DestructionOrchestrationResult> {
  const trigger = options.trigger ?? "manual";
  const batchSize = Math.max(
    1,
    Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE),
  );
  let executed = 0;
  let rolledBack = 0;

  const run = await runGovernanceReconciliation(prisma, {
    kind: prismaPkg.GovernanceReconciliationKind.DESTRUCTION_SWEEP,
    trigger,
    teamId: options.teamId ?? null,
    triggeredByUserId: options.triggeredByUserId ?? null,
    body: async (ctx) => {
      // Pull APPROVED reviews to execute. Reviews whose evidence has a
      // hold are still APPROVED — the hold check happens IN-PHASE so
      // the operator can see the failure on the execution row.
      const approved = await prisma.destructionReview.findMany({
        where: {
          status: "APPROVED",
          ...(options.teamId ? { teamId: options.teamId } : {}),
        },
        orderBy: { decidedAtUtc: "asc" },
        take: batchSize,
        select: {
          id: true,
          teamId: true,
          evidenceId: true,
          retentionPolicyId: true,
          retentionPolicyVersion: true,
          reason: true,
          decidedByUserId: true,
        },
      });
      ctx.reportProgress({ scanned: approved.length });

      for (const review of approved) {
        // Phase X.1 — one correlation id per execution attempt. Threaded
        // through every downstream emission so operators can stitch the
        // chain end-to-end: review → execution row → lifecycle event →
        // notification → incident.
        const correlationId = newCorrelationId();
        try {
          // 1. THE CLAIM — exactly one non-terminal execution per review.
          //
          // This was a read followed by a create, which is not a claim: two
          // orchestrator runs both observed no active execution and both
          // created one, so a single approved destruction produced two
          // certificates, two lineage hashes and two `destruction_executed`
          // ledger rows. The arbiter is now the partial unique index
          // `destruction_executions_active_review_uniq` (migration
          // 20271115000000): the INSERT either wins the slot or raises a
          // unique violation, and the loser CONTINUES the winner's row
          // rather than starting a second destruction.
          const execution = await claimDestructionExecution({
            review,
            correlationId,
            reconciliationRunId: ctx.runId,
          });
          if (!execution) {
            // Another run holds the active execution for this review and is
            // working it now. Skipping is the correct outcome: the row is
            // already owned, and the retention reconciler recovers it if the
            // holder dies.
            ctx.reportProgress({ skipped: 1 });
            continue;
          }

          // 2. Defense-in-depth gate. Gather facts locally (DB lookups
          //    must stay in the worker), then run the DECISION through
          //    the canonical shared formula so this runtime cannot
          //    drift from the api orchestrator.
          const facts = await gatherDestructionFacts(review.evidenceId);
          const decision = canonicalEvaluateLifecycleTransition({
            fromState: facts.lifecycleState,
            toState: "DESTROYED",
            hasActiveDirectHold: facts.hasActiveDirectHold,
            hasActiveCaseHold: facts.hasActiveCaseHold,
            immutableRetention: facts.immutable,
          });
          if (!decision.allowed) {
            const blockedBy: "hold" | "immutable" =
              decision.reason === "blocked_by_immutable"
                ? "immutable"
                : "hold";
            await failExecution(execution.id, {
              code:
                decision.reason === "blocked_by_immutable"
                  ? "BLOCKED_BY_IMMUTABLE"
                  : "BLOCKED_BY_HOLD",
              detail: `Canonical lifecycle gate denied DESTROYED transition (reason=${decision.reason}).`,
              phase:
                decision.reason === "blocked_by_immutable"
                  ? "verifying_immutable_state"
                  : "verifying_no_hold",
            });
            await emitDestructionBlockedNotification(
              review.teamId,
              review.evidenceId,
              blockedBy,
              correlationId,
            );
            ctx.reportProgress({ skipped: 1 });
            continue;
          }

          // 3. Move into EXECUTING — emit certificate + lineage.
          const executionId = execution.id;
          await prisma.destructionExecution.update({
            where: { id: executionId },
            data: {
              status: "EXECUTING",
              phase: "creating_certificate",
              startedAtUtc: new Date(),
            },
          });

          const certificateBody = {
            kind: "evidence_destruction_certificate",
            version: 1,
            teamId: review.teamId,
            evidenceId: review.evidenceId,
            destructionReviewId: review.id,
            destructionExecutionId: executionId,
            retentionPolicyId: review.retentionPolicyId,
            retentionPolicyVersion: review.retentionPolicyVersion,
            reason: review.reason,
            approvedByUserId: review.decidedByUserId,
            executedAtUtc: new Date().toISOString(),
          };
          const certificateHash = sha256OfCanonicalJson(certificateBody);

          // Lineage = previous lifecycle ledger digest + certificate hash.
          const previousLedgerDigest = await mostRecentLifecycleLedgerDigest(
            review.evidenceId,
          );
          const lineageHash = sha256Hex(
            `${previousLedgerDigest}::${certificateHash}`,
          );

          await prisma.destructionExecution.update({
            where: { id: executionId },
            data: {
              phase: "deleting_storage",
              certificateHash,
              lineageHash,
            },
          });

          // 4. Storage deletion is owned by the existing evidence-purge
          //    processor. We mark the boundary and let that processor
          //    finish; the lifecycle ledger captures the intent.
          await prisma.destructionExecution.update({
            where: { id: executionId },
            data: {
              status: "STORAGE_DELETED",
              storageDeletedAtUtc: new Date(),
              phase: "tombstoning_evidence",
            },
          });

          // 5. Tombstone — flip Evidence.lifecycleState + DestructionReview.
          await prisma.$transaction(async (tx) => {
            await tx.evidence.update({
              where: { id: review.evidenceId },
              data: {
                lifecycleState: "DESTROYED",
                activeDestructionReviewId: null,
              },
            });
            await tx.destructionReview.update({
              where: { id: review.id },
              data: {
                status: "EXECUTED",
                executedAtUtc: new Date(),
                certificateHash,
              },
            });
            await tx.evidenceLifecycleEvent.create({
              data: {
                teamId: review.teamId,
                evidenceId: review.evidenceId,
                fromState: "PENDING_DESTRUCTION",
                toState: "DESTROYED",
                eventType: "destruction_executed",
                summary: "Evidence destroyed by destruction orchestrator",
                metadata: {
                  correlationId,
                  destructionExecutionId: executionId,
                  destructionReviewId: review.id,
                  certificateHash,
                  lineageHash,
                  reason: review.reason,
                  certificate: certificateBody,
                } as unknown as prismaPkg.Prisma.InputJsonValue,
                actorUserId: review.decidedByUserId ?? undefined,
                requestId: correlationId.slice(0, 64),
              },
            });
          });

          await prisma.destructionExecution.update({
            where: { id: executionId },
            data: {
              status: "TOMBSTONED",
              tombstonedAtUtc: new Date(),
              phase: "completing",
            },
          });

          // 6. Complete + emit notifications + governance incident.
          await prisma.destructionExecution.update({
            where: { id: executionId },
            data: {
              status: "COMPLETED",
              completedAtUtc: new Date(),
              phase: "completing",
            },
          });
          executed += 1;
          ctx.reportProgress({ created: 1, matched: 1 });
          await emitDestructionExecutedNotification(
            review.teamId,
            review.evidenceId,
            review.id,
            certificateHash,
            correlationId,
          );
        } catch (err) {
          rolledBack += 1;
          ctx.reportProgress({ failed: 1 });
          logger.error(
            { err, reviewId: review.id, runId: ctx.runId, correlationId },
            "destruction.orchestrator.review_failed",
          );
          // Best-effort: flip any in-flight execution to FAILED.
          await prisma.destructionExecution
            .updateMany({
              where: {
                destructionReviewId: review.id,
                status: { notIn: ["COMPLETED", "FAILED", "ROLLED_BACK"] },
              },
              data: {
                status: "FAILED",
                failedAtUtc: new Date(),
                errorCode: "ORCHESTRATOR_EXCEPTION",
                errorDetail: (err instanceof Error
                  ? err.message
                  : String(err)
                ).slice(0, 2000),
                phase: "failed",
              },
            })
            .catch(() => null);
        }
      }

      ctx.setMetadata("executedCount", executed);
      ctx.setMetadata("rolledBackCount", rolledBack);
      ctx.setMetadata("trigger", trigger);

      return { executed, rolledBack };
    },
  });

  return {
    runId: run.runId,
    status: run.status,
    scanned: run.counters.scanned,
    executed,
    failed: run.counters.failed,
    rolledBack,
    skipped: run.counters.skipped,
  };
}

// -----------------------------------------------------------------------------
// The claim
// -----------------------------------------------------------------------------

/**
 * How long a claimed execution may run before it is treated as abandoned.
 *
 * Recorded in the work registry as this family's lease, and compared against
 * it by the closure gate so the two cannot drift.
 */
export const DESTRUCTION_EXECUTION_LEASE_MS = 30 * 60 * 1000;

const DESTRUCTION_TERMINAL_STATUSES = [
  "COMPLETED",
  "FAILED",
  "ROLLED_BACK",
] as const;

/**
 * Take exclusive ownership of the destruction execution for one review.
 *
 * Returns the row this caller owns, or `null` when another caller owns a
 * LIVE one. Three outcomes, all decided by the database:
 *
 *   - the INSERT succeeds  → this caller minted and owns the execution;
 *   - the INSERT is refused by the partial unique index, and the existing
 *     row's lease is still live → another caller owns it, return null;
 *   - the INSERT is refused and the lease has EXPIRED → the previous owner
 *     died mid-flight; take it over with a conditional update that also
 *     pins the observed lease stamp, so two callers reclaiming the same
 *     stale row produce exactly one winner.
 *
 * Nothing here decides whether destruction is permitted. That decision is
 * re-made after the claim, against current database truth.
 */
async function claimDestructionExecution(input: {
  review: {
    id: string;
    teamId: string;
    evidenceId: string;
    decidedByUserId: string | null;
  };
  correlationId: string;
  reconciliationRunId: string;
}): Promise<{ id: string } | null> {
  const { review, correlationId, reconciliationRunId } = input;
  const metadata = {
    correlationId,
    reconciliationRunId,
  } as prismaPkg.Prisma.InputJsonValue;

  try {
    return await prisma.destructionExecution.create({
      data: {
        teamId: review.teamId,
        evidenceId: review.evidenceId,
        destructionReviewId: review.id,
        status: "PLANNED",
        phase: "validating_inputs",
        attemptCount: 1,
        // The lease starts when the slot is claimed, not when the first
        // mutation runs — otherwise a caller that dies during validation
        // holds the review forever with a NULL lease.
        startedAtUtc: new Date(),
        executedByUserId: review.decidedByUserId,
        metadata,
      },
      select: { id: true },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }

  const active = await prisma.destructionExecution.findFirst({
    where: {
      destructionReviewId: review.id,
      status: { notIn: [...DESTRUCTION_TERMINAL_STATUSES] },
    },
    select: { id: true, startedAtUtc: true },
  });
  if (!active) {
    // The holder reached a terminal state between the violation and this
    // read. Nothing to continue and nothing to steal; the next tick mints a
    // fresh execution if the review is still approved.
    return null;
  }

  const leaseStartedAt = active.startedAtUtc;
  const leaseExpired =
    leaseStartedAt === null ||
    Date.now() - leaseStartedAt.getTime() > DESTRUCTION_EXECUTION_LEASE_MS;
  if (!leaseExpired) return null;

  const takenOver = await prisma.destructionExecution.updateMany({
    where: {
      id: active.id,
      status: { notIn: [...DESTRUCTION_TERMINAL_STATUSES] },
      // Pinning the observed stamp is what makes the takeover exclusive: a
      // second reclaimer sees a stamp that has already moved and updates
      // zero rows.
      startedAtUtc: leaseStartedAt,
    },
    data: {
      attemptCount: { increment: 1 },
      startedAtUtc: new Date(),
      // Refresh the correlation id on retry so each attempt is independently
      // traceable while the prior attempt's id remains in the lifecycle
      // ledger.
      metadata,
    },
  });
  return takenOver.count === 1 ? { id: active.id } : null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof prismaPkg.Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type DestructionGateFacts = {
  lifecycleState: EvidenceLifecycleState;
  hasActiveDirectHold: boolean;
  hasActiveCaseHold: boolean;
  immutable: boolean;
};

/**
 * Gather the bounded set of facts the canonical lifecycle decision
 * needs. DB lookups stay in this runtime; the actual decision is made
 * by `canonicalEvaluateLifecycleTransition` in @proovra/shared so the
 * worker cannot drift from the api orchestrator's rule.
 */
async function gatherDestructionFacts(
  evidenceId: string,
): Promise<DestructionGateFacts> {
  const ev = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      lifecycleState: true,
      teamId: true,
      // PHASE 12B — Evidence.caseId is removed; CaseEvidenceLink is the ONE
      // relationship authority. A hold on ANY linked case blocks destruction.
      caseLinks: { select: { caseId: true } },
      retentionPolicyVersionId: true,
    },
  });
  // A missing evidence row must NOT be read as "ACTIVE, nothing blocking".
  // That default was a fail-open: an id that resolves to nothing produced a
  // fact set the canonical gate happily allows, and the run only stopped
  // later, incidentally, when the tombstone UPDATE threw. Refuse here, where
  // the fact is known, rather than relying on a downstream accident.
  if (!ev) {
    throw new Error(
      `destruction facts unavailable: evidence ${evidenceId} does not exist`,
    );
  }
  const lifecycleState = ev.lifecycleState as EvidenceLifecycleState;
  const linkedCaseIds = ev.caseLinks.map((l) => l.caseId);

  // PHASE 12B CLUSTER 8 — ONE union evaluator replaces the three separate
  // per-store lookups that used to live here (evidence-direct, case-level,
  // scope-generic lifecycle). It reads all three stores and FAILS CLOSED:
  // a transient database failure throws out of `gatherDestructionFacts` and
  // aborts the destruction run rather than reporting "no hold".
  const effectiveHold = await evaluateEffectiveLegalHold(prisma, {
    teamId: ev.teamId,
    evidenceId,
    caseIds: linkedCaseIds,
    collectAll: true,
  });
  const hasCaseScopedHold = effectiveHold.matches.some(
    (m) => m.scope === "CASE",
  );
  const hasNonCaseScopedHold = effectiveHold.matches.some(
    (m) => m.scope !== "CASE",
  );

  let immutable = false;
  if (ev.retentionPolicyVersionId) {
    const v = await prisma.evidenceRetentionPolicyVersion.findUnique({
      where: { id: ev.retentionPolicyVersionId },
      select: { immutable: true },
    });
    immutable = Boolean(v?.immutable);
  }

  return {
    lifecycleState,
    hasActiveDirectHold: hasNonCaseScopedHold,
    hasActiveCaseHold: hasCaseScopedHold,
    immutable,
  };
}

async function mostRecentLifecycleLedgerDigest(
  evidenceId: string,
): Promise<string> {
  const row = await prisma.evidenceLifecycleEvent.findFirst({
    where: { evidenceId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, eventType: true, toState: true, createdAt: true },
  });
  if (!row) return sha256Hex(`empty:${evidenceId}`);
  return sha256Hex(
    `${row.id}:${row.eventType}:${row.toState}:${row.createdAt.toISOString()}`,
  );
}

async function failExecution(
  executionId: string,
  input: { code: string; detail: string; phase: string },
): Promise<void> {
  await prisma.destructionExecution.update({
    where: { id: executionId },
    data: {
      status: "FAILED",
      failedAtUtc: new Date(),
      errorCode: input.code.slice(0, 64),
      errorDetail: input.detail.slice(0, 2000),
      phase: input.phase.slice(0, 48),
    },
  });
}

async function emitDestructionExecutedNotification(
  teamId: string,
  evidenceId: string,
  reviewId: string,
  certificateHash: string,
  correlationId?: string,
): Promise<void> {
  try {
    await emitWorkerGovernanceNotification({
      teamId,
      kind: "DESTRUCTION_EXECUTED",
      severity: "HIGH",
      dedupeKey: `destruction_executed:${reviewId}`.slice(0, DEDUPE_KEY_MAX),
      title: "Destruction executed",
      summary: `Evidence ${evidenceId.slice(0, 8)}… was destroyed. Certificate ${certificateHash.slice(0, 16)}…`,
      relatedEvidenceId: evidenceId,
      relatedReviewId: reviewId,
      metadata: { certificateHash },
      correlationId,
    });
  } catch (err) {
    logger.warn({ err }, "governance.notification.emit_failed");
  }
}

async function emitDestructionBlockedNotification(
  teamId: string,
  evidenceId: string,
  reason: "hold" | "immutable",
  correlationId?: string,
): Promise<void> {
  try {
    await emitWorkerGovernanceNotification({
      teamId,
      kind: "DESTRUCTION_BLOCKED",
      severity: "HIGH",
      dedupeKey: `destruction_blocked:${reason}:${evidenceId}`.slice(
        0,
        DEDUPE_KEY_MAX,
      ),
      title: "Destruction blocked at execution",
      summary:
        reason === "hold"
          ? "Destruction was blocked because a legal hold became active before execution."
          : "Destruction was blocked because the retention policy is immutable at execution time.",
      relatedEvidenceId: evidenceId,
      correlationId,
    });
  } catch (err) {
    logger.warn({ err }, "governance.notification.emit_failed");
  }
}

// -----------------------------------------------------------------------------
// Crypto helpers — kept local to avoid a circular dep on the api package.
// -----------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    (a, b) => a[0].localeCompare(b[0]),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

function sha256OfCanonicalJson(value: unknown): string {
  return sha256Hex(canonicalize(value));
}
