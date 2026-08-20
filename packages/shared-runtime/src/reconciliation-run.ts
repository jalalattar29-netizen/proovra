/**
 * Phase 27.5 — Reconciliation run helpers.
 *
 * Append-only run tracking for the three governance workers
 * (retention, destruction sweep, immutable storage). Every invocation
 * creates one `GovernanceReconciliationRun` row, holds a logical lock
 * for the duration, and writes counters + status on completion.
 *
 * Hard rules:
 *   - One RUNNING row per (kind, lockKey) at a time. A second
 *     invocation refuses to start and bumps a contention counter.
 *   - The row is updated to SUCCEEDED / FAILED / PARTIAL on exit. The
 *     row is NEVER deleted.
 *   - The function is exception-safe: a thrown error from the body
 *     still flips the row to FAILED and records the error summary.
 *
 * PHASE 12 POINT 5 — where the lock actually lives.
 *
 * REDESIGN/SEARCH (2026-08-20) — this module moved from
 * `services/worker/src/governance/` into `@proovra/shared-runtime`. Search
 * reconciliation can start from the worker's scheduler OR from the API's
 * `POST /v1/search/reconcile`, and a lock only excludes callers that go
 * through the same wrapper. Both hosts already depend on shared-runtime, which
 * exists for precisely this: Prisma-using logic neither service may own alone.
 * ---------------------------------------------------------------------------
 * The header used to describe an "advisory + RUNNING-row check". There was no
 * advisory lock: the module read for a RUNNING row and then, if it found
 * none, created one. Two callers interleave through that gap trivially — the
 * interval scheduler and an operator-triggered run, or two worker instances —
 * and BOTH created a RUNNING row and BOTH executed the body. For
 * `DESTRUCTION_SWEEP` that meant the destruction pipeline ran twice over the
 * same approved reviews.
 *
 * The lock is now enforced by the database, by the partial unique index
 * `governance_reconciliation_runs_running_lock_uniq` on (kind, lock_key)
 * WHERE status = 'RUNNING' (migration 20271115000000). The INSERT itself is
 * the claim: exactly one caller's INSERT succeeds and every other gets a
 * unique violation, which is contention, not an error. The stale-lock path is
 * unchanged in meaning — a RUNNING row older than the timeout is force-failed,
 * which frees the slot — but it is now also written conditionally, so two
 * callers racing to reclaim the same stale row cannot both proceed.
 */

import * as prismaPkg from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

/**
 * The minimum a host's logger has to offer.
 *
 * This module moved out of `services/worker` so the API's reconcile endpoint
 * and the worker's scheduler resolve through ONE run wrapper — two wrappers
 * over one lock is the same as no lock. It therefore cannot import either
 * host's logger; each passes its own, and the default is silence rather than
 * console noise in a library.
 */
export type ReconciliationLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

const SILENT: ReconciliationLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};



/**
 * How long a RUNNING row may hold the lock before it is treated as crashed.
 *
 * Exported because the work registry records this lease and the Point-5
 * closure gate compares the two: a registry that states a lease the runtime
 * does not use is a claim, not a description.
 */
export const RUN_LOCK_LEASE_MS = 60 * 60 * 1000;

/**
 * Is this the database refusing a second holder of a unique slot?
 *
 * Narrow on purpose. `P2002` is the ONLY error that means "someone else has
 * it"; every other failure — a dead connection, a missing column, a check
 * violation — must propagate, because swallowing those is how a schema error
 * becomes a silent no-op that reads as healthy contention.
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof prismaPkg.Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  );
}

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
  log: ReconciliationLogger = SILENT,
): Promise<ReconciliationRunResult<T>> {
  const lockKey = buildLockKey(input.kind, input.teamId ?? null, input.lockKey);
  const trigger = input.trigger.slice(0, 32);

  // Stale-lock release, BEFORE attempting the claim.
  //
  // A RUNNING row older than the lease is a crashed process, not a live one,
  // and its slot must be freed or the family stops forever. The release is a
  // CONDITIONAL update on the row's still being RUNNING, so two callers that
  // both notice the same stale row cannot both count themselves as having
  // freed it — one of them updates zero rows and simply proceeds to the claim
  // below, where the index decides.
  const existing = await client.governanceReconciliationRun.findFirst({
    where: {
      lockKey,
      kind: input.kind,
      status: prismaPkg.GovernanceReconciliationStatus.RUNNING,
    },
    select: { id: true, startedAtUtc: true },
  });
  if (existing) {
    const ageMs = Date.now() - existing.startedAtUtc.getTime();
    if (ageMs > RUN_LOCK_LEASE_MS) {
      const released = await client.governanceReconciliationRun.updateMany({
        where: {
          id: existing.id,
          status: prismaPkg.GovernanceReconciliationStatus.RUNNING,
        },
        data: {
          status: prismaPkg.GovernanceReconciliationStatus.FAILED,
          finishedAtUtc: new Date(),
          errorSummary: "stale_run_force_failed_after_lock_timeout",
        },
      });
      if (released.count > 0) {
        log.warn(
          { runId: existing.id, lockKey, ageMs },
          "governance.reconciliation.stale_lock_force_failed",
        );
      }
    }
  }

  // THE CLAIM.
  //
  // Not "create because the read said the slot was free" — the INSERT is
  // itself the claim, arbitrated by the partial unique index on
  // (kind, lock_key) WHERE status = 'RUNNING'. A unique violation means
  // another caller holds the lock; that is contention and a bounded no-op,
  // never an error and never a second concurrent body.
  let run: { id: string };
  try {
    run = await client.governanceReconciliationRun.create({
      data: {
        teamId: input.teamId ?? null,
        kind: input.kind,
        trigger,
        lockKey,
        triggeredByUserId: input.triggeredByUserId ?? null,
      },
      select: { id: true },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Report the holder so an operator can see WHICH run owns the slot. If
    // the holder finished between the violation and this read, there is
    // nothing to name; the tick is still a no-op and the next one proceeds.
    const holder = await client.governanceReconciliationRun.findFirst({
      where: {
        lockKey,
        kind: input.kind,
        status: prismaPkg.GovernanceReconciliationStatus.RUNNING,
      },
      select: { id: true },
    });
    log.info(
      { lockKey, kind: input.kind, existingRunId: holder?.id ?? null },
      "governance.reconciliation.lock_held",
    );
    bumpCounter?.("governance_reconciliation_lock_contention_total");
    return {
      runId: holder?.id ?? "",
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

  log.info(
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
