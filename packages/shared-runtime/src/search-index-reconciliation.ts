/**
 * Search index reconciliation — the ONE entry point.
 *
 * WHY THIS EXISTS
 *
 * Readiness used to be inferred from `MAX(indexed_at_utc)`: a recent write
 * meant "a job is running", an old one meant "stalled". Neither is true. A
 * recent write can be a single inline hook firing while no backfill exists at
 * all; an old one can be a run that started two minutes ago and has not
 * reached its first write yet. The timestamp cannot distinguish queued from
 * running, running-but-silent from finished, or finished-with-nothing-to-do
 * from failed.
 *
 * A lock is also only a lock if every caller goes through it. Search
 * reconciliation can begin from the worker's scheduler, from the API's
 * `POST /v1/search/reconcile`, or from the backfill CLI. Before this module
 * each did its own thing, so two of them could work the same workspace at the
 * same time and neither would know.
 *
 * Both problems are answered by the SAME existing authority:
 * `runGovernanceReconciliation` already provides per-(kind, lock_key) database
 * exclusion via a partial unique index, a lease, exception-safe terminal
 * transitions, and append-only history. This module is the Search-shaped face
 * of it — not a second run system, not a second lock, and not a second
 * vocabulary.
 */

import * as prismaPkg from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import {
  RUN_LOCK_LEASE_MS,
  runGovernanceReconciliation,
  type ReconciliationLogger,
  type ReconciliationRunContext,
} from "./reconciliation-run.js";

/** The kind under which every Search reconciliation run is recorded. */
export const SEARCH_INDEX_RUN_KIND =
  prismaPkg.GovernanceReconciliationKind.SEARCH_INDEX;

/**
 * The lock identity for one workspace's Search population.
 *
 * Built here rather than at each call site so the scheduler, the endpoint and
 * the CLI cannot produce three different keys for one workspace — which would
 * be three locks and therefore no lock. The kind prefix keeps it from
 * colliding with the governance families that share the table, and a workspace
 * id is a UUID, so it cannot collide across workspace types either.
 */
export function searchIndexLockKey(teamId: string): string {
  return `${SEARCH_INDEX_RUN_KIND}:${teamId}`;
}

/** What the caller learns about a request to reconcile. */
export type SearchReconcileOutcome =
  /** This caller holds the lock and the body ran. */
  | { kind: "ran"; runId: string; counters: SearchReconcileCounters }
  /** Another caller holds the lock. Not an error — the work is in hand. */
  | { kind: "already_running"; runId: string | null }
  /** The body threw. The run row is FAILED with a safe category. */
  | { kind: "failed"; runId: string; reason: string };

export type SearchReconcileCounters = {
  scanned: number;
  indexed: number;
  removed: number;
  failed: number;
  /**
   * Rebuilds this run handed to the durable queue and did NOT itself complete.
   *
   * WHY A COMPLETED RUN NEEDS THIS FIELD
   *
   * The scheduler's body converges by ENQUEUEING: it finds the drifted rows,
   * schedules a rebuild for each under a deterministic job id, and returns.
   * The run then closes SUCCEEDED within milliseconds while the index is still
   * empty — so readiness saw a completed run with drift remaining and, quite
   * correctly under its own rules, called that STALLED.
   *
   * The result was a workspace that reported "indexing is not progressing —
   * 0 of 2 records are searchable" during the seconds between a HEALTHY
   * reconciler tick and the queue draining it, with no polling (STALLED does
   * not poll) to ever correct the reading. A user who looked in that window
   * saw a permanent-sounding failure and was told to press Rebuild.
   *
   * `SearchRunFacts.continuationScheduled` already existed to express exactly
   * this — "a bounded run that scheduled its own next batch" — and had no
   * writer anywhere in the codebase, so it was dead input and the STALLED
   * branch was unconditional. This counter is that writer.
   *
   * It is deliberately NOT the same thing as `indexed`: work asked for is not
   * work done, and the credit it earns is bounded (see
   * `SEARCH_CONTINUATION_CREDIT_MS`) so a queue that never drains reverts to
   * the truth rather than claiming progress forever.
   */
  scheduled?: number;
};

export type SearchReconcileInput = {
  teamId: string;
  /** Who or what asked. Bounded to 32 chars by the run authority. */
  trigger: "scheduler" | "api" | "cli" | "retry";
  triggeredByUserId?: string | null;
  /**
   * The actual work. Receives the run context so it can report progress into
   * the durable row rather than into memory.
   */
  body: (ctx: ReconciliationRunContext) => Promise<SearchReconcileCounters>;
  log?: ReconciliationLogger;
};

/**
 * Reduce an exception to a bounded category.
 *
 * The run row is read by operators and projected to the UI, so it must never
 * carry a stack, a SQL fragment, a connection string or record content. The
 * categories are coarse on purpose: they say what KIND of thing went wrong,
 * which is what a recovery decision needs.
 */
export function safeFailureCategory(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const m = message.toLowerCase();
  if (m.includes("timeout") || m.includes("etimedout")) return "timeout";
  if (m.includes("econnrefused") || m.includes("connection")) return "database_unavailable";
  if (m.includes("permission") || m.includes("denied")) return "permission_denied";
  if (m.includes("constraint") || m.includes("unique")) return "constraint_violation";
  return "unexpected_error";
}

/**
 * Run one workspace's Search reconciliation under the durable lock.
 *
 * Contention is a NO-OP, not an error: if another caller holds the lock the
 * work is already in hand, and the honest answer to "please reconcile" is that
 * it is being reconciled.
 */
export async function reconcileSearchIndex(
  client: PrismaClient,
  input: SearchReconcileInput,
): Promise<SearchReconcileOutcome> {
  const lockKey = searchIndexLockKey(input.teamId);
  let counters: SearchReconcileCounters = {
    scanned: 0,
    indexed: 0,
    removed: 0,
    failed: 0,
    scheduled: 0,
  };

  const result = await runGovernanceReconciliation<SearchReconcileCounters>(
    client,
    {
      kind: SEARCH_INDEX_RUN_KIND,
      trigger: input.trigger,
      teamId: input.teamId,
      triggeredByUserId: input.triggeredByUserId ?? null,
      lockKey,
      body: async (ctx) => {
        counters = await input.body(ctx);
        // Persist what the run actually did, so "completed with zero changes"
        // is a fact on the row rather than an inference from silence.
        ctx.reportProgress({
          scanned: counters.scanned,
          created: counters.indexed,
          skipped: counters.removed,
          failed: counters.failed,
        });
        // Durable, on the run row, so readiness reads a PERSISTED fact rather
        // than re-deriving intent from queue state it cannot see.
        ctx.setMetadata(
          SEARCH_RUN_SCHEDULED_METADATA_KEY,
          Math.max(0, counters.scheduled ?? 0),
        );
        return counters;
      },
    },
    undefined,
    input.log,
  );

  if (result.status === prismaPkg.GovernanceReconciliationStatus.RUNNING) {
    // The claim lost: another caller holds the lock and its body is running.
    return { kind: "already_running", runId: result.runId || null };
  }
  if (result.status === prismaPkg.GovernanceReconciliationStatus.FAILED) {
    return {
      kind: "failed",
      runId: result.runId,
      reason: result.error ? safeFailureCategory(result.error) : "unexpected_error",
    };
  }
  return { kind: "ran", runId: result.runId, counters };
}

// ---------------------------------------------------------------------------
// Projecting the latest run for readiness
// ---------------------------------------------------------------------------

/**
 * The durable facts readiness needs, and nothing else.
 *
 * No lock key, no row id, no trigger user, no error text — those are either
 * internal or another tenant's business. What survives is the shape of the run
 * and whether its lease is still valid.
 */
export type SearchRunSnapshot = {
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "PARTIAL";
  startedAtUtc: string;
  finishedAtUtc: string | null;
  /** True only while a RUNNING row is inside its lease. */
  leaseValid: boolean;
  /** Bounded category. Never a stack, never SQL. */
  failureCategory: string | null;
  scanned: number;
  indexed: number;
  removed: number;
  failed: number;
  /**
   * A completed run scheduled durable follow-on work that has not landed yet,
   * AND that work is still young enough to be credible.
   *
   * Both halves are load-bearing. Without the first, a finished run with drift
   * is indistinguishable from an abandoned one. Without the second, a queue
   * that never drains would let one tick's enqueue claim "still working"
   * forever — which is the exact class of permanent, unfalsifiable
   * reassurance the readiness model was built to delete.
   */
  continuationScheduled: boolean;
};

/**
 * Where a run records how much follow-on work it handed to the queue.
 *
 * A metadata key rather than a column: the run table is shared with the
 * governance families, and a Search-only column on it would be a schema change
 * that four other kinds have to carry and none of them can use.
 */
export const SEARCH_RUN_SCHEDULED_METADATA_KEY = "searchScheduled";

/**
 * How long enqueued-but-unlanded rebuilds may stand in for progress.
 *
 * Sized against the projection queue's own recovery contract: a rebuild that
 * has not been picked up within the processing-lease window is not slow, it is
 * lost — and the honest readout for lost work is STALLED, which the periodic
 * reconciler then re-schedules. Deliberately shorter than the scheduler
 * interval so credit cannot be rolled over indefinitely by a tick that keeps
 * enqueueing into a queue nobody is consuming.
 */
export const SEARCH_CONTINUATION_CREDIT_MS = 5 * 60 * 1000;

/**
 * The most recent Search run for ONE workspace.
 *
 * Tenant-bound by `teamId` in the query itself — a caller cannot ask about a
 * workspace it did not name, and the endpoint that calls this has already
 * proven the actor may see that workspace.
 */
export async function latestSearchRun(
  client: PrismaClient,
  teamId: string,
  now: Date = new Date(),
): Promise<SearchRunSnapshot | null> {
  const row = await client.governanceReconciliationRun.findFirst({
    where: { teamId, kind: SEARCH_INDEX_RUN_KIND },
    orderBy: { startedAtUtc: "desc" },
    select: {
      status: true,
      startedAtUtc: true,
      finishedAtUtc: true,
      errorSummary: true,
      metadata: true,
      scannedCount: true,
      createdCount: true,
      skippedCount: true,
      failedCount: true,
    },
  });
  if (!row) return null;

  const running =
    row.status === prismaPkg.GovernanceReconciliationStatus.RUNNING;
  // A RUNNING row past its lease is a crashed process, not a live one. The run
  // wrapper force-fails it on the next claim; until then readiness must not
  // treat it as progress, or a crash would read as "still working" forever.
  const leaseValid =
    running && now.getTime() - row.startedAtUtc.getTime() <= RUN_LOCK_LEASE_MS;

  // Follow-on work this run handed to the queue, and whether it is still young
  // enough to stand for progress. A run that finished more than the credit
  // window ago has had its answer: either the queue drained it (and the counts
  // above say so) or it did not (and STALLED is the truth).
  const scheduled = readScheduledCount(row.metadata);
  const finishedMs = row.finishedAtUtc?.getTime() ?? null;
  const continuationScheduled =
    !running &&
    scheduled > 0 &&
    finishedMs != null &&
    now.getTime() - finishedMs <= SEARCH_CONTINUATION_CREDIT_MS;

  return {
    status: row.status,
    startedAtUtc: row.startedAtUtc.toISOString(),
    finishedAtUtc: row.finishedAtUtc?.toISOString() ?? null,
    leaseValid,
    // BOUNDED, and bounded HERE.
    //
    // `runGovernanceReconciliation` persists `error.message` verbatim into
    // `errorSummary` — deliberately, because an operator reading the run table
    // needs the real message. This projection is read by the browser, and it
    // used to hand that message straight through as `failureReason`: a
    // workspace whose run died on a Postgres enum mismatch showed the user
    // `invalid input value for enum GovernanceReconciliationKind:
    // SEARCH_INDEX`. The row keeps the detail; the wire gets a category.
    //
    // The stale-lock marker is the authority's own wording rather than an
    // exception, so it is preserved as-is instead of being reduced.
    failureCategory:
      row.status === prismaPkg.GovernanceReconciliationStatus.FAILED
        ? projectFailureCategory(row.errorSummary)
        : null,
    scanned: row.scannedCount,
    indexed: row.createdCount,
    removed: row.skippedCount,
    failed: row.failedCount,
    continuationScheduled,
  };
}

/** The one marker the run authority writes itself, which is already safe. */
const STALE_LOCK_MARKER = "stale_run_force_failed_after_lock_timeout";

function projectFailureCategory(errorSummary: string | null): string {
  if (!errorSummary) return "unexpected_error";
  if (errorSummary === STALE_LOCK_MARKER) return STALE_LOCK_MARKER;
  return safeFailureCategory(new Error(errorSummary));
}

function readScheduledCount(metadata: unknown): number {
  if (metadata == null || typeof metadata !== "object") return 0;
  const raw = (metadata as Record<string, unknown>)[
    SEARCH_RUN_SCHEDULED_METADATA_KEY
  ];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : 0;
}
