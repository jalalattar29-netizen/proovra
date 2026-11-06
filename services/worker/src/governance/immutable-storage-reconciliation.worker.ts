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
 *   - The default probe HEADs the record's sealed version through
 *     `services/worker/src/storage.ts` (WORKERS-02); tests pass their own.
 *     When the probe is unavailable, we record `STORAGE_UNAVAILABLE` rather
 *     than synthesizing a spurious drift.
 */

import * as prismaPkg from "@prisma/client";
import { newCorrelationId } from "@proovra/shared";
import { logger } from "../logger.js";
import { prisma } from "../db.js";
import {
  resolveEvidenceWorkspaceIds,
  runGovernanceReconciliation,
  workspaceEvidenceWhere,
} from "@proovra/shared-runtime";
import { emitWorkerGovernanceNotification } from "./notification-emitter.js";
import { recordWorkerIncident } from "./incident-emitter.js";
import { headObject, isObjectLockEnabled } from "../storage.js";

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
 * WORKERS-02 — THE REAL PROBE: a HEAD of the record's SEALED version.
 *
 * The default used to answer "unavailable" unconditionally and the scheduler
 * passed no other, so in production the drift worker never detected drift.
 * It now reads the Object Lock state the store reports for the exact version
 * the record was sealed at (never "latest at the key"). A record with no
 * stored object or no sealed version is reported unavailable with that
 * reason, not as drift. With Object Lock disabled for the deployment there is
 * no lock to compare and the probe says so.
 */
export const s3SealedVersionProbe: StorageProbe = async (evidenceId) => {
  if (!isObjectLockEnabled()) {
    return { available: false, reason: "object_lock_disabled" };
  }
  const ev = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: { storageBucket: true, storageKey: true, storageVersionId: true },
  });
  if (!ev?.storageBucket || !ev.storageKey) {
    return { available: false, reason: "no_stored_object" };
  }
  if (!ev.storageVersionId) {
    return { available: false, reason: "no_sealed_version" };
  }
  const head = await headObject({
    bucket: ev.storageBucket,
    key: ev.storageKey,
    versionId: ev.storageVersionId,
  });
  return {
    available: true,
    retainUntilUtc: head.objectLockRetainUntilDate ?? null,
    legalHoldActive: head.objectLockLegalHoldStatus === "ON",
    complianceMode: head.objectLockMode ?? null,
  };
};

const defaultProbe: StorageProbe = s3SealedVersionProbe;

/**
 * WORKERS-02 — where the previous run stopped. The candidate scan was
 * `id asc, take N` with no cursor, so every run re-checked the same lowest
 * ids and the rest of the population was never checked. Each run records the
 * last id it reached in its own run row (`metadata.cursorEvidenceId`); the
 * next run of the same scope continues after it and wraps to the start when
 * it reaches the end. The run table is small and indexed on
 * (team, kind, started), so the cursor costs one indexed read.
 */
async function lastCheckedEvidenceId(teamId: string | null): Promise<string | null> {
  const last = await prisma.governanceReconciliationRun.findFirst({
    where: {
      teamId,
      kind: prismaPkg.GovernanceReconciliationKind.IMMUTABLE_STORAGE,
      status: { not: prismaPkg.GovernanceReconciliationStatus.RUNNING },
    },
    orderBy: { startedAtUtc: "desc" },
    select: { metadata: true },
  });
  const meta = last?.metadata as { cursorEvidenceId?: unknown } | null | undefined;
  return typeof meta?.cursorEvidenceId === "string" ? meta.cursorEvidenceId : null;
}

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
      //
      // PRO-110 / WORKERS-12 — a scoped run uses the canonical workspace scope,
      // never a bare teamId, and an unscoped run no longer drops a Personal
      // Space's records stored with team_id NULL: each record's workspace is
      // resolved (its team, or its owner's personal workspace) below.
      const workspaceScope = options.teamId
        ? await workspaceEvidenceWhere(options.teamId, prisma)
        : null;
      const population = {
        ...(workspaceScope ? { AND: [workspaceScope] } : {}),
        deletedAt: null,
        OR: [
          { retentionUntilUtc: { not: null } },
          { legalHolds: { some: { status: "ACTIVE" as const } } },
          { retentionPolicyVersionId: { not: null } },
          { storageObjectLockRetainUntilUtc: { not: null } },
        ],
      };
      const candidateSelect = {
        id: true,
        teamId: true,
        ownerUserId: true,
        retentionUntilUtc: true,
        retentionPolicyVersionId: true,
        storageObjectLockMode: true,
        storageObjectLockRetainUntilUtc: true,
        storageObjectLockLegalHoldStatus: true,
      } as const;
      const cursor = await lastCheckedEvidenceId(options.teamId ?? null);
      const candidates = await prisma.evidence.findMany({
        where: cursor ? { AND: [population, { id: { gt: cursor } }] } : population,
        select: candidateSelect,
        orderBy: { id: "asc" },
        take: batchSize,
      });
      if (cursor && candidates.length < batchSize) {
        // Reached the end of the id range: wrap to the start.
        const seen = new Set(candidates.map((c) => c.id));
        const wrapped = await prisma.evidence.findMany({
          where: { AND: [population, { id: { lte: cursor } }] },
          select: candidateSelect,
          orderBy: { id: "asc" },
          take: batchSize - candidates.length,
        });
        for (const w of wrapped) if (!seen.has(w.id)) candidates.push(w);
      }
      ctx.reportProgress({ scanned: candidates.length });
      const workspaceOf = await resolveEvidenceWorkspaceIds(candidates, prisma);

      for (const ev of candidates) {
        const evidenceTeamId = workspaceOf.get(ev.id) ?? null;
        if (!evidenceTeamId) {
          ctx.reportProgress({ skipped: 1 });
          continue;
        }
        const correlationId = newCorrelationId();
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

          // Outcome resolution — WORKERS-02: against the lock the record
          // RECORDS it placed on its sealed version, not against the
          // application's own retention and holds. The product deliberately
          // does not mirror a legal hold into a native S3 hold
          // (services/api/src/storage.ts, applyObjectRetention), and the seal
          // lock is the record's resolved eight-year horizon, not the policy's
          // retention date (evidence-complete.service.ts). Comparing those
          // application facts with the store would report drift on every held
          // or policy-retained record and block its packages. Drift is the
          // store disagreeing with what was written to it.
          const dbHoldActive = Boolean(directHold);
          const recordedRetainUntil = ev.storageObjectLockRetainUntilUtc;
          const recordedHoldActive = ev.storageObjectLockLegalHoldStatus === "ON";
          const storageHoldActive = probeResult.legalHoldActive;
          let outcome: prismaPkg.ImmutableStorageCheckOutcome =
            prismaPkg.ImmutableStorageCheckOutcome.OK;
          let driftSummary: string | null = null;

          if (recordedHoldActive !== storageHoldActive) {
            outcome = prismaPkg.ImmutableStorageCheckOutcome.LEGAL_HOLD_MISMATCH;
            driftSummary = `native_legal_hold recorded=${recordedHoldActive} storage=${storageHoldActive}`;
          } else if (recordedRetainUntil && !probeResult.retainUntilUtc) {
            outcome = prismaPkg.ImmutableStorageCheckOutcome.MISSING_LOCK;
            driftSummary = "recorded_lock_storage_has_no_lock";
          } else if (
            recordedRetainUntil &&
            probeResult.retainUntilUtc &&
            Math.abs(
              recordedRetainUntil.getTime() -
                probeResult.retainUntilUtc.getTime(),
            ) >
              60 * 60 * 1000
          ) {
            outcome = prismaPkg.ImmutableStorageCheckOutcome.RETENTION_MISMATCH;
            driftSummary = `retention_mismatch recorded=${recordedRetainUntil.toISOString()} storage=${probeResult.retainUntilUtc.toISOString()}`;
          } else if (
            recordedRetainUntil &&
            ev.storageObjectLockMode === "COMPLIANCE" &&
            probeResult.complianceMode !== "COMPLIANCE"
          ) {
            outcome = prismaPkg.ImmutableStorageCheckOutcome.COMPLIANCE_MODE_MISMATCH;
            driftSummary = `compliance_mode_mismatch recorded=COMPLIANCE storage=${probeResult.complianceMode ?? "null"}`;
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
              correlationId,
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
              metadata: {
                correlationId,
                reconciliationRunId: ctx.runId,
              } as prismaPkg.Prisma.InputJsonValue,
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
              correlationId,
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

      // The last id this run checked in walk order (a wrapped id when it
      // wrapped), so the next run continues right after it.
      const reached = candidates.length > 0 ? candidates[candidates.length - 1]!.id : null;
      if (reached) ctx.setMetadata("cursorEvidenceId", reached);
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
  correlationId?: string,
): Promise<string | null> {
  // Phase X.1 — route through the canonical worker incident emitter
  // (incident-emitter.ts) which mirrors the Phase 21 recordIncident
  // contract. The inline `operationalIncident.upsert` logic that
  // lived here is gone.
  const row = await recordWorkerIncident({
    sourceId: "storage.immutable_drift",
    teamId,
    category: "GOVERNANCE",
    severity: "HIGH",
    fingerprint: `immutable_storage_drift:${outcome}:${evidenceId}`,
    message: {
      code: "ops.storage.immutable_drift",
      params: { outcome: String(outcome), evidenceRef: evidenceId.slice(0, 8), detail: driftSummary },
    },
    relatedEvidenceId: evidenceId,
    correlationId,
    metadata: { outcome, driftSummary: driftSummary ?? null },
  });
  return row?.id ?? null;
}

async function emitImmutableDriftNotification(
  teamId: string,
  evidenceId: string,
  outcome: prismaPkg.ImmutableStorageCheckOutcome,
  driftSummary: string | null,
  correlationId?: string,
): Promise<void> {
  // Phase X.1 — route through the canonical worker notification
  // emitter (notification-emitter.ts). Inline upsert removed.
  try {
    await emitWorkerGovernanceNotification({
      teamId,
      kind: "IMMUTABLE_RECONCILIATION_FAILURE",
      severity: "HIGH",
      dedupeKey: `immutable_drift:${outcome}:${evidenceId}`.slice(
        0,
        DEDUPE_KEY_MAX,
      ),
      title: "Immutable storage drift detected",
      conditionMessage: {
        code: "ops.governance.notification.immutable_drift",
        params: { evidenceRef: evidenceId.slice(0, 8), outcome: String(outcome) },
      },
      summary:
        driftSummary?.slice(0, 1000) ??
        `Storage layer disagrees with DB on evidence ${evidenceId.slice(0, 8)}… (outcome=${outcome}).`,
      relatedEvidenceId: evidenceId,
      metadata: { outcome },
      correlationId,
    });
  } catch (err) {
    logger.warn({ err }, "governance.notification.emit_failed");
  }
}
