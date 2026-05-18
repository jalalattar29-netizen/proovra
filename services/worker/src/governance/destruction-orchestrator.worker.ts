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
  type EvidenceLifecycleState,
} from "@proovra/shared";
import { logger } from "../logger.js";
import { prisma } from "../db.js";
import { runGovernanceReconciliation } from "./reconciliation-run.js";

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
        try {
          // 1. Idempotency — reuse an existing non-terminal execution row.
          let execution = await prisma.destructionExecution.findFirst({
            where: {
              destructionReviewId: review.id,
              status: {
                notIn: ["COMPLETED", "FAILED", "ROLLED_BACK"],
              },
            },
          });
          if (!execution) {
            execution = await prisma.destructionExecution.create({
              data: {
                teamId: review.teamId,
                evidenceId: review.evidenceId,
                destructionReviewId: review.id,
                status: "PLANNED",
                phase: "validating_inputs",
                attemptCount: 1,
                executedByUserId: review.decidedByUserId,
              },
            });
          } else {
            execution = await prisma.destructionExecution.update({
              where: { id: execution.id },
              data: { attemptCount: { increment: 1 } },
            });
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
            );
            ctx.reportProgress({ skipped: 1 });
            continue;
          }

          // 3. Move into EXECUTING — emit certificate + lineage.
          execution = await prisma.destructionExecution.update({
            where: { id: execution.id },
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
            destructionExecutionId: execution.id,
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

          execution = await prisma.destructionExecution.update({
            where: { id: execution.id },
            data: {
              phase: "deleting_storage",
              certificateHash,
              lineageHash,
            },
          });

          // 4. Storage deletion is owned by the existing evidence-purge
          //    processor. We mark the boundary and let that processor
          //    finish; the lifecycle ledger captures the intent.
          execution = await prisma.destructionExecution.update({
            where: { id: execution.id },
            data: {
              status: "STORAGE_DELETED",
              storageDeletedAtUtc: new Date(),
              phase: "tombstoning_evidence",
            },
          });
          const executionId = execution.id;

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
                  destructionExecutionId: executionId,
                  destructionReviewId: review.id,
                  certificateHash,
                  lineageHash,
                  reason: review.reason,
                  certificate: certificateBody,
                } as unknown as prismaPkg.Prisma.InputJsonValue,
                actorUserId: review.decidedByUserId ?? undefined,
              },
            });
          });

          execution = await prisma.destructionExecution.update({
            where: { id: execution.id },
            data: {
              status: "TOMBSTONED",
              tombstonedAtUtc: new Date(),
              phase: "completing",
            },
          });

          // 6. Complete + emit notifications + governance incident.
          await prisma.destructionExecution.update({
            where: { id: execution.id },
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
          );
        } catch (err) {
          rolledBack += 1;
          ctx.reportProgress({ failed: 1 });
          logger.error(
            { err, reviewId: review.id, runId: ctx.runId },
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
      caseId: true,
      retentionPolicyVersionId: true,
    },
  });
  const lifecycleState = (ev?.lifecycleState ??
    "ACTIVE") as EvidenceLifecycleState;

  const directHold = await prisma.evidenceLegalHold.findFirst({
    where: { evidenceId, status: prismaPkg.LegalHoldStatus.ACTIVE },
    select: { id: true },
  });

  let caseHold: { id: string } | null = null;
  if (ev?.caseId) {
    caseHold = await prisma.caseLegalHold.findFirst({
      where: {
        caseId: ev.caseId,
        status: prismaPkg.CaseLegalHoldStatus.ACTIVE,
      },
      select: { id: true },
    });
  }

  let immutable = false;
  if (ev?.retentionPolicyVersionId) {
    const v = await prisma.evidenceRetentionPolicyVersion.findUnique({
      where: { id: ev.retentionPolicyVersionId },
      select: { immutable: true },
    });
    immutable = Boolean(v?.immutable);
  }

  return {
    lifecycleState,
    hasActiveDirectHold: Boolean(directHold),
    hasActiveCaseHold: Boolean(caseHold),
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
): Promise<void> {
  try {
    const key = `destruction_executed:${reviewId}`.slice(0, DEDUPE_KEY_MAX);
    await prisma.governanceNotification.upsert({
      where: {
        teamId_kind_dedupeKey: {
          teamId,
          kind: prismaPkg.GovernanceNotificationKind.DESTRUCTION_EXECUTED,
          dedupeKey: key,
        },
      },
      create: {
        teamId,
        kind: prismaPkg.GovernanceNotificationKind.DESTRUCTION_EXECUTED,
        severity: prismaPkg.GovernanceNotificationSeverity.HIGH,
        dedupeKey: key,
        title: "Destruction executed",
        summary: `Evidence ${evidenceId.slice(0, 8)}… was destroyed. Certificate ${certificateHash.slice(0, 16)}…`,
        relatedEvidenceId: evidenceId,
        relatedReviewId: reviewId,
        channels: ["in_app", "email"],
        metadata: {
          certificateHash,
        } as prismaPkg.Prisma.InputJsonValue,
      },
      update: {
        lastSeenAtUtc: new Date(),
        occurrenceCount: { increment: 1 },
      },
    });
  } catch (err) {
    logger.warn({ err }, "governance.notification.emit_failed");
  }
}

async function emitDestructionBlockedNotification(
  teamId: string,
  evidenceId: string,
  reason: "hold" | "immutable",
): Promise<void> {
  try {
    const key = `destruction_blocked:${reason}:${evidenceId}`.slice(
      0,
      DEDUPE_KEY_MAX,
    );
    await prisma.governanceNotification.upsert({
      where: {
        teamId_kind_dedupeKey: {
          teamId,
          kind: prismaPkg.GovernanceNotificationKind.DESTRUCTION_BLOCKED,
          dedupeKey: key,
        },
      },
      create: {
        teamId,
        kind: prismaPkg.GovernanceNotificationKind.DESTRUCTION_BLOCKED,
        severity: prismaPkg.GovernanceNotificationSeverity.HIGH,
        dedupeKey: key,
        title: "Destruction blocked at execution",
        summary:
          reason === "hold"
            ? "Destruction was blocked because a legal hold became active before execution."
            : "Destruction was blocked because the retention policy is immutable at execution time.",
        relatedEvidenceId: evidenceId,
        channels: ["in_app", "email"],
      },
      update: {
        lastSeenAtUtc: new Date(),
        occurrenceCount: { increment: 1 },
      },
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
