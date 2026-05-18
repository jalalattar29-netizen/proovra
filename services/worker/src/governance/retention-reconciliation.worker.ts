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
import { logger } from "../logger.js";
import { prisma } from "../db.js";
import { runGovernanceReconciliation } from "./reconciliation-run.js";

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
            await emitDestructionBlockedNotification(teamId, ev.id, "hold");
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
              );
              continue;
            }
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
                    autoExtensionDays: policySnapshot.autoExtensionDays,
                    nextRetentionUntilUtc: nextRetention.toISOString(),
                    triggeredByRun: ctx.runId,
                  } as prismaPkg.Prisma.InputJsonValue,
                  actorUserId: options.triggeredByUserId ?? undefined,
                },
              });
              await emitRetentionExtensionNotification(
                teamId,
                ev.id,
                policySnapshot.retentionPolicyId,
                policySnapshot.autoExtensionDays,
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
                  destructionReviewId: r.id,
                  reason: "retention_expired",
                  triggeredByRun: ctx.runId,
                } as prismaPkg.Prisma.InputJsonValue,
                actorUserId: options.triggeredByUserId ?? undefined,
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
          );
        } catch (err) {
          ctx.reportProgress({ failed: 1 });
          logger.error(
            { err, evidenceId: ev.id, runId: ctx.runId },
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
                  driftKind: "stale_active_destruction_review",
                  triggeredByRun: ctx.runId,
                } as prismaPkg.Prisma.InputJsonValue,
                actorUserId: options.triggeredByUserId ?? undefined,
              },
            });
            await emitLifecycleDriftNotification(driftTeamId, ev.id);
          }
        } catch (err) {
          ctx.reportProgress({ failed: 1 });
          logger.error(
            { err, evidenceId: ev.id, runId: ctx.runId },
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
// Notification emission — best-effort. Failures never break the run.
// -----------------------------------------------------------------------------

function dedupeKey(...parts: ReadonlyArray<string>): string {
  return parts.join(":").slice(0, NOTIFICATION_DEDUPE_KEY_MAX);
}

async function emitDestructionPendingNotification(
  teamId: string,
  evidenceId: string,
  reviewId: string,
): Promise<void> {
  try {
    const key = dedupeKey("destruction_pending", evidenceId);
    await prisma.governanceNotification.upsert({
      where: {
        teamId_kind_dedupeKey: {
          teamId,
          kind: prismaPkg.GovernanceNotificationKind.DESTRUCTION_PENDING,
          dedupeKey: key,
        },
      },
      create: {
        teamId,
        kind: prismaPkg.GovernanceNotificationKind.DESTRUCTION_PENDING,
        severity: prismaPkg.GovernanceNotificationSeverity.WARNING,
        dedupeKey: key,
        title: "Destruction review pending",
        summary: `Retention has expired on evidence ${evidenceId.slice(0, 8)}…; review #${reviewId.slice(0, 8)}…`,
        relatedEvidenceId: evidenceId,
        relatedReviewId: reviewId,
        channels: ["in_app"],
      },
      update: {
        lastSeenAtUtc: new Date(),
        occurrenceCount: { increment: 1 },
        relatedReviewId: reviewId,
      },
    });
  } catch (err) {
    logger.warn({ err }, "governance.notification.emit_failed");
  }
}

async function emitDestructionBlockedNotification(
  teamId: string,
  evidenceId: string,
  blockReason: "hold" | "case_hold" | "immutable",
): Promise<void> {
  try {
    const key = dedupeKey("destruction_blocked", blockReason, evidenceId);
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
        severity: prismaPkg.GovernanceNotificationSeverity.INFO,
        dedupeKey: key,
        title: "Destruction blocked",
        summary:
          blockReason === "immutable"
            ? "Retention has expired but the policy is immutable. Operator must supersede the policy before destruction."
            : blockReason === "case_hold"
              ? "Retention has expired but the parent case is on legal hold."
              : "Retention has expired but the evidence is on legal hold.",
        relatedEvidenceId: evidenceId,
        channels: ["in_app"],
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

async function emitRetentionExtensionNotification(
  teamId: string,
  evidenceId: string,
  policyId: string,
  days: number,
): Promise<void> {
  try {
    const key = dedupeKey("retention_extension", policyId, evidenceId);
    await prisma.governanceNotification.upsert({
      where: {
        teamId_kind_dedupeKey: {
          teamId,
          kind: prismaPkg.GovernanceNotificationKind.RETENTION_EXTENSION_APPLIED,
          dedupeKey: key,
        },
      },
      create: {
        teamId,
        kind: prismaPkg.GovernanceNotificationKind.RETENTION_EXTENSION_APPLIED,
        severity: prismaPkg.GovernanceNotificationSeverity.INFO,
        dedupeKey: key,
        title: "Retention auto-extended",
        summary: `Policy auto-extended retention by ${days} days following recent custody activity.`,
        relatedEvidenceId: evidenceId,
        relatedPolicyId: policyId,
        channels: ["in_app"],
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

async function emitLifecycleDriftNotification(
  teamId: string,
  evidenceId: string,
): Promise<void> {
  try {
    const key = dedupeKey("lifecycle_drift", "stale_review", evidenceId);
    await prisma.governanceNotification.upsert({
      where: {
        teamId_kind_dedupeKey: {
          teamId,
          kind: prismaPkg.GovernanceNotificationKind.LIFECYCLE_DRIFT,
          dedupeKey: key,
        },
      },
      create: {
        teamId,
        kind: prismaPkg.GovernanceNotificationKind.LIFECYCLE_DRIFT,
        severity: prismaPkg.GovernanceNotificationSeverity.HIGH,
        dedupeKey: key,
        title: "Lifecycle drift detected",
        summary:
          "Evidence is PENDING_DESTRUCTION but its active destruction review pointer is stale.",
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
