/**
 * Phase 27.5 — Retention Reconciliation Worker.
 *
 * Scans evidence rows whose retention window has expired and creates a
 * `DestructionReview` row for each. Idempotent — never creates a
 * second active review for an evidence that already has one. Hold-
 * aware — refuses to queue destruction whenever a legal hold is
 * active. Immutable-aware — refuses to queue destruction when the
 * effective retention policy version is `immutable=true`.
 *
 * Additionally:
 *   - Auto-extends retention when the effective policy carries
 *     `autoExtensionEnabled=true` AND a fresh custody event lands on
 *     the evidence within the auto-extension window. The worker
 *     bumps `retentionUntilUtc` by the policy's `autoExtensionDays`
 *     value and records the extension.
 *   - Detects lifecycle drift: evidence flagged as
 *     `PENDING_DESTRUCTION` whose active destruction review pointer is
 *     stale (review terminal or missing). Emits a governance incident
 *     so an operator can reconcile.
 *
 * Hard rules:
 *   - Bounded batch size. Never scans the entire workspace in one go.
 *   - No double review creation — DB lookup before INSERT, then
 *     transactional flip of Evidence.activeDestructionReviewId.
 *   - Every action writes:
 *       1. a row to `evidence_lifecycle_events` (append-only ledger)
 *       2. a `destruction_reviews` row (when a review is created)
 *       3. a SecurityEvent (operator feed)
 *       4. one or more governance notifications (operator UI feed)
 */

import * as prismaPkg from "@prisma/client";
import { newCorrelationId } from "@proovra/shared";
import { logger } from "../logger.js";
import { prisma } from "../db.js";
import { runGovernanceReconciliation } from "./reconciliation-run.js";
import { emitWorkerGovernanceNotification } from "./notification-emitter.js";
import { hasActiveLifecycleLegalHold } from "./lifecycle-legal-hold.js";

const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 1000;
const NOTIFICATION_DEDUPE_KEY_MAX = 180;

export interface RetentionReconciliationOptions {
  trigger?: string;
  batchSize?: number;
  /** When provided, scope the run to one workspace; otherwise global. */
  teamId?: string | null;
  triggeredByUserId?: string | null;
}

export interface RetentionReconciliationResult {
  runId: string;
  status: prismaPkg.GovernanceReconciliationStatus;
  scanned: number;
  matched: number;
  created: number;
  skipped: number;
  failed: number;
  incident: number;
  extended: number;
  drift: number;
}

export async function runRetentionReconciliation(
  options: RetentionReconciliationOptions = {},
): Promise<RetentionReconciliationResult> {
  const trigger = options.trigger ?? "manual";
  const batchSize = Math.max(
    1,
    Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE),
  );
  let extended = 0;
  let drift = 0;

  const run = await runGovernanceReconciliation(prisma, {
    kind: prismaPkg.GovernanceReconciliationKind.RETENTION,
    trigger,
    teamId: options.teamId ?? null,
    triggeredByUserId: options.triggeredByUserId ?? undefined,
    body: async (ctx) => {
      // 1. Expired-retention scan.
      const now = new Date();
      const expiredEvidence = await prisma.evidence.findMany({
        where: {
          ...(options.teamId ? { teamId: options.teamId } : { teamId: { not: null } }),
          deletedAt: null,
          retentionUntilUtc: { not: null, lt: now },
          lifecycleState: { in: ["ACTIVE", "UNDER_REVIEW", "ARCHIVED"] },
          activeDestructionReviewId: null,
        },
        orderBy: { retentionUntilUtc: "asc" },
        take: batchSize,
        select: {
          id: true,
          teamId: true,
          lifecycleState: true,
          retentionPolicyVersionId: true,
        },
      });
      ctx.reportProgress({ scanned: expiredEvidence.length });

      for (const ev of expiredEvidence) {
        if (!ev.teamId) {
          ctx.reportProgress({ skipped: 1 });
          continue;
        }
        const teamId = ev.teamId;
        // Phase X.1 — one correlation id per evidence iteration. Threads
        // into every downstream emission (notification, lifecycle ledger)
        // for end-to-end stitching.
        const correlationId = newCorrelationId();
        try {
          // Hold check.
          const directHold = await prisma.evidenceLegalHold.findFirst({
            where: {
              evidenceId: ev.id,
              status: prismaPkg.LegalHoldStatus.ACTIVE,
            },
            select: { id: true },
          });
          if (directHold) {
            ctx.reportProgress({ skipped: 1 });
            await emitDestructionBlockedNotification(
              teamId,
              ev.id,
              "hold",
              correlationId,
            );
            continue;
          }
          // Cascade case-level hold.
          const evWithCase = await prisma.evidence.findUnique({
            where: { id: ev.id },
            select: { caseId: true },
          });
          if (evWithCase?.caseId) {
            const caseHold = await prisma.caseLegalHold.findFirst({
              where: {
                caseId: evWithCase.caseId,
                status: prismaPkg.CaseLegalHoldStatus.ACTIVE,
              },
              select: { id: true },
            });
            if (caseHold) {
              ctx.reportProgress({ skipped: 1 });
              await emitDestructionBlockedNotification(
                teamId,
                ev.id,
                "case_hold",
                correlationId,
              );
              continue;
            }
          }

          // Phase R6 (F39) — Phase-4B LegalHold check. The 4A checks above
          // only cover EvidenceLegalHold + CaseLegalHold; a hold placed via
          // the live `/lifecycle/legal-holds` UI lands in the 4B `legalHold`
          // table (EVIDENCE/WORKSPACE/ORGANIZATION/CASE scope) and must also
          // suspend automated destruction scheduling.
          if (
            await hasActiveLifecycleLegalHold(prisma, {
              evidenceId: ev.id,
              teamId,
              caseId: evWithCase?.caseId ?? null,
            })
          ) {
            ctx.reportProgress({ skipped: 1 });
            await emitDestructionBlockedNotification(
              teamId,
              ev.id,
              "hold",
              correlationId,
            );
            continue;
          }

          // Immutable check.
          let policySnapshot: {
            retentionPolicyId: string;
            immutable: boolean;
            autoExtensionEnabled: boolean;
            autoExtensionDays: number | null;
          } | null = null;
          if (ev.retentionPolicyVersionId) {
            const v = await prisma.evidenceRetentionPolicyVersion.findUnique({
              where: { id: ev.retentionPolicyVersionId },
              select: {
                retentionPolicyId: true,
                immutable: true,
                autoExtensionEnabled: true,
                autoExtensionDays: true,
              },
            });
            if (v) policySnapshot = v;
          }
          if (policySnapshot?.immutable) {
            ctx.reportProgress({ skipped: 1 });
            await emitDestructionBlockedNotification(
              teamId,
              ev.id,
              "immutable",
              correlationId,
            );
            continue;
          }

          // Auto-extension path: bump retention rather than queue destruction.
          if (policySnapshot?.autoExtensionEnabled && policySnapshot.autoExtensionDays) {
            // Check whether a custody event has landed in the
            // auto-extension window relative to NOW (e.g. last 7 days).
            const windowStart = new Date(
              now.getTime() - 7 * 24 * 60 * 60 * 1000,
            );
            const recentCustody = await prisma.custodyEvent.findFirst({
              where: { evidenceId: ev.id, atUtc: { gte: windowStart } },
              select: { id: true },
            });
            if (recentCustody) {
              const nextRetention = new Date(
                now.getTime() +
                  policySnapshot.autoExtensionDays * 24 * 60 * 60 * 1000,
              );
              await prisma.evidence.update({
                where: { id: ev.id },
                data: { retentionUntilUtc: nextRetention },
              });
              await prisma.evidenceLifecycleEvent.create({
                data: {
                  teamId,
                  evidenceId: ev.id,
                  fromState: ev.lifecycleState,
                  toState: ev.lifecycleState,
                  eventType: "retention_recomputed",
                  summary: `Retention auto-extended by ${policySnapshot.autoExtensionDays} days`,
                  metadata: {
                    correlationId,
                    autoExtensionDays: policySnapshot.autoExtensionDays,
                    nextRetentionUntilUtc: nextRetention.toISOString(),
                    triggeredByRun: ctx.runId,
                  } as prismaPkg.Prisma.InputJsonValue,
                  actorUserId: options.triggeredByUserId ?? undefined,
                  requestId: correlationId.slice(0, 64),
                },
              });
              await emitRetentionExtensionNotification(
                teamId,
                ev.id,
                policySnapshot.retentionPolicyId,
                policySnapshot.autoExtensionDays,
                correlationId,
              );
              ctx.reportProgress({ matched: 1 });
              extended += 1;
              continue;
            }
          }

          // Queue destruction review (atomic).
          const review = await prisma.$transaction(async (tx) => {
            // Double-check inside the tx that no review was created in flight.
            const existing = await tx.destructionReview.findFirst({
              where: {
                evidenceId: ev.id,
                teamId,
                status: {
                  in: ["PENDING", "UNDER_REVIEW", "DEFERRED", "APPROVED"],
                },
              },
              select: { id: true },
            });
            if (existing) return null;
            const r = await tx.destructionReview.create({
              data: {
                teamId,
                evidenceId: ev.id,
                retentionPolicyId: policySnapshot?.retentionPolicyId ?? null,
                status: "PENDING",
                reason: "retention_expired",
                initiatedByUserId: options.triggeredByUserId ?? undefined,
              },
            });
            await tx.evidence.update({
              where: { id: ev.id },
              data: { activeDestructionReviewId: r.id },
            });
            await tx.evidenceLifecycleEvent.create({
              data: {
                teamId,
                evidenceId: ev.id,
                fromState: ev.lifecycleState,
                toState: ev.lifecycleState,
                eventType: "destruction_review_created",
                summary: "Retention expired — destruction review queued",
                metadata: {
                  correlationId,
                  destructionReviewId: r.id,
                  reason: "retention_expired",
                  triggeredByRun: ctx.runId,
                } as prismaPkg.Prisma.InputJsonValue,
                actorUserId: options.triggeredByUserId ?? undefined,
                requestId: correlationId.slice(0, 64),
              },
            });
            return r;
          });
          if (!review) {
            ctx.reportProgress({ skipped: 1 });
            continue;
          }
          ctx.reportProgress({ created: 1, matched: 1 });
          await emitDestructionPendingNotification(
            teamId,
            ev.id,
            review.id,
            correlationId,
          );
        } catch (err) {
          ctx.reportProgress({ failed: 1 });
          logger.error(
            { err, evidenceId: ev.id, runId: ctx.runId, correlationId },
            "retention.reconciliation.evidence_failed",
          );
        }
      }

      // 2. Lifecycle drift scan: Evidence rows in PENDING_DESTRUCTION
      //    whose activeDestructionReviewId is null or points at a
      //    terminal review.
      const driftCandidates = await prisma.evidence.findMany({
        where: {
          ...(options.teamId
            ? { teamId: options.teamId }
            : { teamId: { not: null } }),
          lifecycleState: "PENDING_DESTRUCTION",
        },
        select: {
          id: true,
          teamId: true,
          activeDestructionReviewId: true,
        },
        take: batchSize,
      });
      for (const ev of driftCandidates) {
        if (!ev.teamId) {
          ctx.reportProgress({ skipped: 1 });
          continue;
        }
        const driftTeamId = ev.teamId;
        const driftCorrelationId = newCorrelationId();
        try {
          let isDrifted = ev.activeDestructionReviewId === null;
          if (!isDrifted && ev.activeDestructionReviewId) {
            const review = await prisma.destructionReview.findUnique({
              where: { id: ev.activeDestructionReviewId },
              select: { status: true },
            });
            if (
              !review ||
              ["EXECUTED", "RESTORED", "CANCELLED"].includes(review.status)
            ) {
              isDrifted = true;
            }
          }
          if (isDrifted) {
            drift += 1;
            ctx.reportProgress({ incident: 1 });
            await prisma.evidenceLifecycleEvent.create({
              data: {
                teamId: driftTeamId,
                evidenceId: ev.id,
                fromState: "PENDING_DESTRUCTION",
                toState: "PENDING_DESTRUCTION",
                eventType: "lifecycle_transition",
                summary: "Lifecycle drift detected — pointer stale",
                metadata: {
                  correlationId: driftCorrelationId,
                  driftKind: "stale_active_destruction_review",
                  triggeredByRun: ctx.runId,
                } as prismaPkg.Prisma.InputJsonValue,
                actorUserId: options.triggeredByUserId ?? undefined,
                requestId: driftCorrelationId.slice(0, 64),
              },
            });
            await emitLifecycleDriftNotification(
              driftTeamId,
              ev.id,
              driftCorrelationId,
            );
          }
        } catch (err) {
          ctx.reportProgress({ failed: 1 });
          logger.error(
            { err, evidenceId: ev.id, runId: ctx.runId, correlationId: driftCorrelationId },
            "retention.reconciliation.drift_check_failed",
          );
        }
      }

      ctx.setMetadata("extendedCount", extended);
      ctx.setMetadata("driftCount", drift);
      ctx.setMetadata("trigger", trigger);

      return { extended, drift };
    },
  });

  return {
    runId: run.runId,
    status: run.status,
    scanned: run.counters.scanned,
    matched: run.counters.matched,
    created: run.counters.created,
    skipped: run.counters.skipped,
    failed: run.counters.failed,
    incident: run.counters.incident,
    extended,
    drift,
  };
}

// -----------------------------------------------------------------------------
// Notification emission — Phase X.1 routes every emission through the
// canonical worker emitter so throttle, dedupe, severity escalation,
// and HIGH/CRITICAL incident fan-out stay consistent with the api
// notification service. The inline `prisma.governanceNotification.upsert`
// calls that lived here are gone.
//
// All emissions remain best-effort: a failure to record a notification
// must never break the reconciliation run.
// -----------------------------------------------------------------------------

function dedupeKey(...parts: ReadonlyArray<string>): string {
  return parts.join(":").slice(0, NOTIFICATION_DEDUPE_KEY_MAX);
}

async function emitDestructionPendingNotification(
  teamId: string,
  evidenceId: string,
  reviewId: string,
  correlationId?: string,
): Promise<void> {
  try {
    await emitWorkerGovernanceNotification({
      teamId,
      kind: "DESTRUCTION_PENDING",
      severity: "WARNING",
      dedupeKey: dedupeKey("destruction_pending", evidenceId),
      title: "Destruction review pending",
      summary: `Retention has expired on evidence ${evidenceId.slice(0, 8)}…; review #${reviewId.slice(0, 8)}…`,
      relatedEvidenceId: evidenceId,
      relatedReviewId: reviewId,
      correlationId,
    });
  } catch (err) {
    logger.warn({ err }, "governance.notification.emit_failed");
  }
}

async function emitDestructionBlockedNotification(
  teamId: string,
  evidenceId: string,
  blockReason: "hold" | "case_hold" | "immutable",
  correlationId?: string,
): Promise<void> {
  try {
    await emitWorkerGovernanceNotification({
      teamId,
      kind: "DESTRUCTION_BLOCKED",
      severity: "INFO",
      dedupeKey: dedupeKey("destruction_blocked", blockReason, evidenceId),
      title: "Destruction blocked",
      summary:
        blockReason === "immutable"
          ? "Retention has expired but the policy is immutable. Operator must supersede the policy before destruction."
          : blockReason === "case_hold"
            ? "Retention has expired but the parent case is on legal hold."
            : "Retention has expired but the evidence is on legal hold.",
      relatedEvidenceId: evidenceId,
      correlationId,
    });
  } catch (err) {
    logger.warn({ err }, "governance.notification.emit_failed");
  }
}

async function emitRetentionExtensionNotification(
  teamId: string,
  evidenceId: string,
  policyId: string,
  days: number,
  correlationId?: string,
): Promise<void> {
  try {
    await emitWorkerGovernanceNotification({
      teamId,
      kind: "RETENTION_EXTENSION_APPLIED",
      severity: "INFO",
      dedupeKey: dedupeKey("retention_extension", policyId, evidenceId),
      title: "Retention auto-extended",
      summary: `Policy auto-extended retention by ${days} days following recent custody activity.`,
      relatedEvidenceId: evidenceId,
      relatedPolicyId: policyId,
      correlationId,
    });
  } catch (err) {
    logger.warn({ err }, "governance.notification.emit_failed");
  }
}

async function emitLifecycleDriftNotification(
  teamId: string,
  evidenceId: string,
  correlationId?: string,
): Promise<void> {
  try {
    await emitWorkerGovernanceNotification({
      teamId,
      kind: "LIFECYCLE_DRIFT",
      severity: "HIGH",
      dedupeKey: dedupeKey("lifecycle_drift", "stale_review", evidenceId),
      title: "Lifecycle drift detected",
      summary:
        "Evidence is PENDING_DESTRUCTION but its active destruction review pointer is stale.",
      relatedEvidenceId: evidenceId,
      correlationId,
    });
  } catch (err) {
    logger.warn({ err }, "governance.notification.emit_failed");
  }
}
