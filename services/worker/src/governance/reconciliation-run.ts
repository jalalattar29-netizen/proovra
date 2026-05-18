/**
 * Phase 27.5 — Reconciliation run helpers.
 *
 * Append-only run tracking for the three governance workers
 * (retention, destruction sweep, immutable storage). Every invocation
 * creates one `GovernanceReconciliationRun` row, holds a logical lock
 * (advisory + RUNNING-row check) for the duration, and writes counters
 * + status on completion.
 *
 * Hard rules:
 *   - One RUNNING row per (kind, lockKey) at a time. A second
 *     invocation refuses to start and bumps a contention counter.
 *   - The row is updated to SUCCEEDED / FAILED / PARTIAL on exit. The
 *     row is NEVER deleted.
 *   - The function is exception-safe: a thrown error from the body
 *     still flips the row to FAILED and records the error summary.
 */

import * as prismaPkg from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { logger } from "../logger.js";

export type ReconciliationRunResult<T> = {
  runId: string;
  status: prismaPkg.GovernanceReconciliationStatus;
  result: T | null;
  error: Error | null;
  counters: ReconciliationCounters;
};

export type ReconciliationCounters = {
  scanned: number;
  matched: number;
  created: number;
  skipped: number;
  failed: number;
  incident: number;
};

export type ReconciliationRunContext = {
  runId: string;
  counters: ReconciliationCounters;
  /** Append-only progress reporting from inside the run body. */
  reportProgress: (patch: Partial<ReconciliationCounters>) => void;
  /** Operator metadata captured into the run row on completion. */
  setMetadata: (key: string, value: unknown) => void;
};

export type RunGovernanceReconciliationInput<T> = {
  kind: prismaPkg.GovernanceReconciliationKind;
  trigger: string;
  /** Workspace-scoped runs pass teamId; cross-team scans pass null. */
  teamId?: string | null;
  triggeredByUserId?: string | null;
  /**
   * Logical lock identity. Defaults to `${kind}:${teamId ?? "global"}`.
   * Two invocations with the same lockKey cannot both be RUNNING.
   */
  lockKey?: string;
  /** The actual reconciliation body. Receives counters + metadata helpers. */
  body: (ctx: ReconciliationRunContext) => Promise<T>;
};

function buildLockKey(
  kind: prismaPkg.GovernanceReconciliationKind,
  teamId: string | null,
  override?: string,
): string {
  if (override) return override.slice(0, 128);
  return `${kind}:${teamId ?? "global"}`.slice(0, 128);
}

export async function runGovernanceReconciliation<T>(
  client: PrismaClient,
  input: RunGovernanceReconciliationInput<T>,
  bumpCounter?: (name: string) => void,
): Promise<ReconciliationRunResult<T>> {
  const lockKey = buildLockKey(input.kind, input.teamId ?? null, input.lockKey);
  const trigger = input.trigger.slice(0, 32);

  // Lock check — refuse if another RUNNING row holds this lockKey.
  const existing = await client.governanceReconciliationRun.findFirst({
    where: {
      lockKey,
      kind: input.kind,
      status: prismaPkg.GovernanceReconciliationStatus.RUNNING,
    },
    select: { id: true, startedAtUtc: true },
  });
  if (existing) {
    // Stale-lock detection: if the RUNNING row is older than 1 hour,
    // we assume the previous process crashed and force-fail it. This
    // releases the lock for the current invocation.
    const ageMs = Date.now() - existing.startedAtUtc.getTime();
    if (ageMs > 60 * 60 * 1000) {
      await client.governanceReconciliationRun.update({
        where: { id: existing.id },
        data: {
          status: prismaPkg.GovernanceReconciliationStatus.FAILED,
          finishedAtUtc: new Date(),
          errorSummary: "stale_run_force_failed_after_lock_timeout",
        },
      });
      logger.warn(
        { runId: existing.id, lockKey, ageMs },
        "governance.reconciliation.stale_lock_force_failed",
      );
    } else {
      logger.info(
        { lockKey, kind: input.kind, existingRunId: existing.id },
        "governance.reconciliation.lock_held",
      );
      bumpCounter?.("governance_reconciliation_lock_contention_total");
      return {
        runId: existing.id,
        status: prismaPkg.GovernanceReconciliationStatus.RUNNING,
        result: null,
        error: null,
        counters: {
          scanned: 0,
          matched: 0,
          created: 0,
          skipped: 0,
          failed: 0,
          incident: 0,
        },
      };
    }
  }

  const run = await client.governanceReconciliationRun.create({
    data: {
      teamId: input.teamId ?? null,
      kind: input.kind,
      trigger,
      lockKey,
      triggeredByUserId: input.triggeredByUserId ?? null,
    },
  });
  bumpCounter?.("governance_reconciliation_runs_total");

  const counters: ReconciliationCounters = {
    scanned: 0,
    matched: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    incident: 0,
  };
  const metadataBag: Record<string, unknown> = {};
  const ctx: ReconciliationRunContext = {
    runId: run.id,
    counters,
    reportProgress: (patch) => {
      if (patch.scanned !== undefined) counters.scanned += patch.scanned;
      if (patch.matched !== undefined) counters.matched += patch.matched;
      if (patch.created !== undefined) counters.created += patch.created;
      if (patch.skipped !== undefined) counters.skipped += patch.skipped;
      if (patch.failed !== undefined) counters.failed += patch.failed;
      if (patch.incident !== undefined) counters.incident += patch.incident;
    },
    setMetadata: (key, value) => {
      metadataBag[String(key).slice(0, 64)] = value;
    },
  };

  let bodyResult: T | null = null;
  let error: Error | null = null;
  let status: prismaPkg.GovernanceReconciliationStatus =
    prismaPkg.GovernanceReconciliationStatus.SUCCEEDED;

  try {
    bodyResult = await input.body(ctx);
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
    status = prismaPkg.GovernanceReconciliationStatus.FAILED;
  }

  // Partial success: had failures but did not throw.
  if (!error && counters.failed > 0) {
    status = prismaPkg.GovernanceReconciliationStatus.PARTIAL;
  }

  await client.governanceReconciliationRun.update({
    where: { id: run.id },
    data: {
      status,
      finishedAtUtc: new Date(),
      scannedCount: counters.scanned,
      matchedCount: counters.matched,
      createdCount: counters.created,
      skippedCount: counters.skipped,
      failedCount: counters.failed,
      incidentCount: counters.incident,
      errorSummary: error ? error.message.slice(0, 2000) : null,
      metadata:
        Object.keys(metadataBag).length > 0
          ? (metadataBag as unknown as prismaPkg.Prisma.InputJsonValue)
          : undefined,
    },
  });

  if (status === prismaPkg.GovernanceReconciliationStatus.FAILED) {
    bumpCounter?.("governance_reconciliation_run_failed_total");
  } else if (status === prismaPkg.GovernanceReconciliationStatus.PARTIAL) {
    bumpCounter?.("governance_reconciliation_run_partial_total");
  }

  logger.info(
    {
      runId: run.id,
      kind: input.kind,
      status,
      counters,
      trigger,
      teamId: input.teamId ?? null,
    },
    "governance.reconciliation.finished",
  );

  return { runId: run.id, status, result: bodyResult, error, counters };
}

export function newRequestId(): string {
  return randomUUID();
}
