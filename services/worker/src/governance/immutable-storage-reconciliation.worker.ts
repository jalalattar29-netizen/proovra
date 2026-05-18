/**
 * Phase 27.5 — Immutable Storage Reconciliation Worker.
 *
 * Sweeps evidence rows whose DB state should be matched by S3 Object
 * Lock (or equivalent compliance retention) and verifies the storage
 * layer agrees with the DB. Persists every check as an
 * `ImmutableStorageCheck` row — append-only — and raises governance
 * incidents + notifications on drift.
 *
 * Drift outcomes:
 *   - MISSING_LOCK             — DB says locked / immutable, storage has no lock
 *   - RETENTION_MISMATCH       — retention dates disagree
 *   - LEGAL_HOLD_MISMATCH      — hold flag disagrees
 *   - COMPLIANCE_MODE_MISMATCH — compliance mode disagrees
 *
 * On any drift outcome:
 *   - Append `ImmutableStorageCheck` row with the drift detail.
 *   - Raise governance incident (Phase 21) so it shows on /ops.
 *   - Emit governance notification (operator alert).
 *   - Mark the evidence's active destruction execution (if any) as
 *     blocked by raising an incident — the destruction orchestrator
 *     consults the most-recent check before deleting storage.
 *
 * Hard rules:
 *   - The worker NEVER mutates evidence state on its own. It is a
 *     read-only verifier with side effects in `immutable_storage_checks`,
 *     `operational_incidents`, and `governance_notifications`.
 *   - The storage probe is mocked here at the integration boundary
 *     — the real S3 head-object call lives in `services/worker/src/storage.ts`
 *     and is gated by env. When the probe is unavailable, we record
 *     `STORAGE_UNAVAILABLE` rather than synthesizing a spurious drift.
 */

import * as prismaPkg from "@prisma/client";
import { logger } from "../logger.js";
import { prisma } from "../db.js";
import { runGovernanceReconciliation } from "./reconciliation-run.js";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
const DEDUPE_KEY_MAX = 180;

export interface ImmutableStorageReconciliationOptions {
  trigger?: string;
  batchSize?: number;
  teamId?: string | null;
  triggeredByUserId?: string | null;
  /** Optional probe override (test seam). Returns the storage view. */
  probeStorage?: StorageProbe;
}

export interface ImmutableStorageReconciliationResult {
  runId: string;
  status: prismaPkg.GovernanceReconciliationStatus;
  scanned: number;
  ok: number;
  drift: number;
  unavailable: number;
  failed: number;
}

export type StorageProbeResult =
  | { available: true; retainUntilUtc: Date | null; legalHoldActive: boolean; complianceMode: string | null }
  | { available: false; reason: string };

export type StorageProbe = (
  evidenceId: string,
  teamId: string,
) => Promise<StorageProbeResult>;

/**
 * Default probe — placeholder for the real S3 head-object integration.
 * Returns "unavailable" so the worker records the check without
 * synthesizing drift. Replace via `options.probeStorage` in tests, or
 * wire the real S3 call here once the storage env is configured.
 */
const defaultProbe: StorageProbe = async () => ({
  available: false,
  reason: "storage_probe_not_configured",
});

export async function runImmutableStorageReconciliation(
  options: ImmutableStorageReconciliationOptions = {},
): Promise<ImmutableStorageReconciliationResult> {
  const trigger = options.trigger ?? "manual";
  const batchSize = Math.max(
    1,
    Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE),
  );
  const probe = options.probeStorage ?? defaultProbe;
  let ok = 0;
  let drift = 0;
  let unavailable = 0;

  const run = await runGovernanceReconciliation(prisma, {
    kind: prismaPkg.GovernanceReconciliationKind.IMMUTABLE_STORAGE,
    trigger,
    teamId: options.teamId ?? null,
    triggeredByUserId: options.triggeredByUserId ?? null,
    body: async (ctx) => {
      // Pull evidence rows that should have immutable storage state
      // (retentionUntilUtc set OR a legal hold attached OR an immutable
      // policy version bound).
      const candidates = await prisma.evidence.findMany({
        where: {
          ...(options.teamId ? { teamId: options.teamId } : { teamId: { not: null } }),
          deletedAt: null,
          OR: [
            { retentionUntilUtc: { not: null } },
            { legalHolds: { some: { status: "ACTIVE" } } },
            { retentionPolicyVersionId: { not: null } },
          ],
        },
        select: {
          id: true,
          teamId: true,
          retentionUntilUtc: true,
          retentionPolicyVersionId: true,
        },
        orderBy: { id: "asc" },
        take: batchSize,
      });
      ctx.reportProgress({ scanned: candidates.length });

      for (const ev of candidates) {
        if (!ev.teamId) {
          ctx.reportProgress({ skipped: 1 });
          continue;
        }
        const evidenceTeamId = ev.teamId;
        try {
          const directHold = await prisma.evidenceLegalHold.findFirst({
            where: { evidenceId: ev.id, status: prismaPkg.LegalHoldStatus.ACTIVE },
            select: { id: true },
          });
          let immutable = false;
          if (ev.retentionPolicyVersionId) {
            const version = await prisma.evidenceRetentionPolicyVersion.findUnique({
              where: { id: ev.retentionPolicyVersionId },
              select: { immutable: true },
            });
            immutable = Boolean(version?.immutable);
          }

          const probeResult = await probe(ev.id, evidenceTeamId).catch(
            (err): StorageProbeResult => ({
              available: false,
              reason: err instanceof Error ? err.message : String(err),
            }),
          );

          if (!probeResult.available) {
            unavailable += 1;
            await prisma.immutableStorageCheck.create({
              data: {
                teamId: evidenceTeamId,
                evidenceId: ev.id,
                outcome: prismaPkg.ImmutableStorageCheckOutcome.STORAGE_UNAVAILABLE,
                dbRetentionUntilUtc: ev.retentionUntilUtc,
                dbLegalHoldActive: Boolean(directHold),
                dbImmutable: immutable,
                driftSummary: probeResult.reason.slice(0, 400),
              },
            });
            continue;
          }

          // Outcome resolution.
          const dbHoldActive = Boolean(directHold);
          const storageHoldActive = probeResult.legalHoldActive;
          let outcome: prismaPkg.ImmutableStorageCheckOutcome =
            prismaPkg.ImmutableStorageCheckOutcome.OK;
          let driftSummary: string | null = null;

          if (dbHoldActive !== storageHoldActive) {
            outcome = prismaPkg.ImmutableStorageCheckOutcome.LEGAL_HOLD_MISMATCH;
            driftSummary = `legal_hold_active db=${dbHoldActive} storage=${storageHoldActive}`;
          } else if (
            ev.retentionUntilUtc &&
            !probeResult.retainUntilUtc
          ) {
            outcome = prismaPkg.ImmutableStorageCheckOutcome.MISSING_LOCK;
            driftSummary = "db_has_retention_storage_has_no_lock";
          } else if (
            ev.retentionUntilUtc &&
            probeResult.retainUntilUtc &&
            Math.abs(
              ev.retentionUntilUtc.getTime() -
                probeResult.retainUntilUtc.getTime(),
            ) >
              60 * 60 * 1000
          ) {
            outcome = prismaPkg.ImmutableStorageCheckOutcome.RETENTION_MISMATCH;
            driftSummary = `retention_mismatch db=${ev.retentionUntilUtc.toISOString()} storage=${probeResult.retainUntilUtc.toISOString()}`;
          } else if (
            immutable &&
            probeResult.complianceMode !== "COMPLIANCE" &&
            probeResult.complianceMode !== null
          ) {
            outcome = prismaPkg.ImmutableStorageCheckOutcome.COMPLIANCE_MODE_MISMATCH;
            driftSummary = `compliance_mode_mismatch storage=${probeResult.complianceMode ?? "null"}`;
          }

          let raisedIncidentId: string | null = null;
          if (outcome !== prismaPkg.ImmutableStorageCheckOutcome.OK) {
            // Best-effort incident raise.
            raisedIncidentId = await raiseGovernanceIncident(
              evidenceTeamId,
              ev.id,
              outcome,
              driftSummary,
            );
          }

          await prisma.immutableStorageCheck.create({
            data: {
              teamId: evidenceTeamId,
              evidenceId: ev.id,
              outcome,
              dbRetentionUntilUtc: ev.retentionUntilUtc,
              dbLegalHoldActive: dbHoldActive,
              dbImmutable: immutable,
              storageRetainUntilUtc: probeResult.retainUntilUtc,
              storageLegalHoldActive: probeResult.legalHoldActive,
              storageComplianceMode: probeResult.complianceMode,
              raisedIncidentId,
              driftSummary: driftSummary?.slice(0, 400) ?? null,
            },
          });

          if (outcome === prismaPkg.ImmutableStorageCheckOutcome.OK) {
            ok += 1;
          } else {
            drift += 1;
            ctx.reportProgress({ incident: 1 });
            await emitImmutableDriftNotification(
              evidenceTeamId,
              ev.id,
              outcome,
              driftSummary,
            );
          }
        } catch (err) {
          ctx.reportProgress({ failed: 1 });
          logger.error(
            { err, evidenceId: ev.id, runId: ctx.runId },
            "immutable.reconciliation.check_failed",
          );
        }
      }

      ctx.setMetadata("okCount", ok);
      ctx.setMetadata("driftCount", drift);
      ctx.setMetadata("unavailableCount", unavailable);
      ctx.setMetadata("trigger", trigger);

      return { ok, drift, unavailable };
    },
  });

  return {
    runId: run.runId,
    status: run.status,
    scanned: run.counters.scanned,
    ok,
    drift,
    unavailable,
    failed: run.counters.failed,
  };
}

// -----------------------------------------------------------------------------
// Helpers — incident + notification fan-out
// -----------------------------------------------------------------------------

async function raiseGovernanceIncident(
  teamId: string,
  evidenceId: string,
  outcome: prismaPkg.ImmutableStorageCheckOutcome,
  driftSummary: string | null,
): Promise<string | null> {
  try {
    const fingerprint = `immutable_storage_drift:${outcome}:${evidenceId}`.slice(
      0,
      120,
    );
    const existing = await prisma.operationalIncident.findUnique({
      where: { teamId_fingerprint: { teamId, fingerprint } },
    });
    if (existing) {
      const row = await prisma.operationalIncident.update({
        where: { id: existing.id },
        data: {
          lastSeenAtUtc: new Date(),
          occurrenceCount: { increment: 1 },
          status:
            existing.status === prismaPkg.IncidentStatus.RESOLVED ||
            existing.status === prismaPkg.IncidentStatus.SUPPRESSED
              ? prismaPkg.IncidentStatus.OPEN
              : existing.status,
        },
      });
      return row.id;
    }
    const row = await prisma.operationalIncident.create({
      data: {
        teamId,
        category: prismaPkg.IncidentCategory.GOVERNANCE,
        severity: prismaPkg.IncidentSeverity.HIGH,
        status: prismaPkg.IncidentStatus.OPEN,
        fingerprint,
        title: `Immutable storage drift: ${outcome}`,
        safeSummary: driftSummary?.slice(0, 400) ?? `Drift outcome ${outcome} on evidence ${evidenceId.slice(0, 8)}…`,
        relatedEvidenceId: evidenceId,
        openedBySystem: true,
      },
    });
    return row.id;
  } catch (err) {
    logger.warn({ err }, "governance.incident.raise_failed");
    return null;
  }
}

async function emitImmutableDriftNotification(
  teamId: string,
  evidenceId: string,
  outcome: prismaPkg.ImmutableStorageCheckOutcome,
  driftSummary: string | null,
): Promise<void> {
  try {
    const key = `immutable_drift:${outcome}:${evidenceId}`.slice(
      0,
      DEDUPE_KEY_MAX,
    );
    await prisma.governanceNotification.upsert({
      where: {
        teamId_kind_dedupeKey: {
          teamId,
          kind: prismaPkg.GovernanceNotificationKind
            .IMMUTABLE_RECONCILIATION_FAILURE,
          dedupeKey: key,
        },
      },
      create: {
        teamId,
        kind: prismaPkg.GovernanceNotificationKind
          .IMMUTABLE_RECONCILIATION_FAILURE,
        severity: prismaPkg.GovernanceNotificationSeverity.HIGH,
        dedupeKey: key,
        title: "Immutable storage drift detected",
        summary:
          driftSummary?.slice(0, 1000) ??
          `Storage layer disagrees with DB on evidence ${evidenceId.slice(0, 8)}… (outcome=${outcome}).`,
        relatedEvidenceId: evidenceId,
        channels: ["in_app", "email"],
        metadata: {
          outcome,
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
