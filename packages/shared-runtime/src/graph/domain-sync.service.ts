/**
 * Phase 31.21 — bounded graph search-projection sync.
 *
 * This service exposes:
 *   * `runSearchProjectionSync(teamId, client)` — finds evidence
 *     rows with recent signal activity and enqueues bounded
 *     search-indexing rebuilds for them. Real safe work: keeps the
 *     search document's active-signal count fresh without writing
 *     graph-derived columns directly.
 *
 * Hard rules:
 *   * Team-anchored at every SQL.
 *   * NEVER throws — every error path collapses to a bounded reason.
 *   * Bounded result sizes — at most 200 affected items per call.
 *   * NEVER reads or projects evidence content, OCR text, transcript
 *     text, GPS, storage keys, reviewer-private fields, or anything
 *     other than the bounded enum/id surface the rest of the graph
 *     code uses.
 *
 * ET-Q-07 (2026-09-30) — `runDomainStaleSweep`, `runTimelineSync`, the
 * `DOMAIN_SYNC_DOMAINS` catalog and their result types were REMOVED from this
 * module. Their only callers were the `graph-domain-sync` and
 * `graph-timeline-sync` worker processors, and those two queues never had a
 * producer — so neither function ever ran outside a test. Nothing is lost: the
 * per-domain stale sweeps and the cross-edge stale sweep both run inside
 * `reconcileTeamGraph` (graph-builder.service.ts), which is the live path on
 * the `graph-reconcile` queue. A future "sync one domain now" feature must
 * come back end to end (producer, consumer, idempotency, retries,
 * reconciliation, DLQ, runtime proof), not as a helper with no caller.
 */

import type { PrismaClient } from "@prisma/client";

import { getRegisteredPrisma } from "../prisma-registry.js";
import { bump } from "../ops/metrics.service.js";

// =============================================================================
// Public types
// =============================================================================

export type SearchProjectionSyncResult = {
  ok: boolean;
  /** Number of evidence ids enqueued for reindex this run. */
  enqueued: number;
  reason?: string;
};

// =============================================================================
// runSearchProjectionSync
// =============================================================================
//
// Goal: keep the search index fresh for any evidence whose visible
// signal set has changed recently. The Phase 24-J indexer already
// indexes evidence rows; this sync surfaces the indexing TRIGGER —
// it discovers evidence with recent media_intelligence_signals
// activity in the last hour and enqueues a bounded reindex per
// affected evidence.
//
// This is real bounded work because:
//   * The search document caches signal counts.
//   * Without this sync, ACKNOWLEDGED / DISMISSED transitions don't
//     necessarily kick the indexer until the periodic Phase 24-J
//     reconcile runs.
//   * With this sync, the graph-search-projection queue gives
//     operators a "kick the search projection NOW" lever without
//     dipping into Postgres directly.
//
// Idempotent: the enqueue helper collapses duplicate jobs into the
// existing search-indexing job, so repeated invocations of this
// sync don't multiply search-index work.
//
// Bounded: at most 200 evidence reindex enqueues per call.

const RECENT_SIGNAL_WINDOW_MINUTES = 60;
const MAX_REINDEX_ENQUEUES_PER_RUN = 200;

export async function runSearchProjectionSync(
  teamId: string,
  client: PrismaClient = getRegisteredPrisma(),
  options: {
    /** Override the recent-signal window. Bounded to 1..1440 minutes. */
    windowMinutes?: number;
    /** Override the enqueue cap. Bounded to 1..500. */
    enqueueCap?: number;
    /** Optional enqueue function override for testability. When
     *  omitted the function dynamic-imports the worker queue helper.
     *  In API-only environments where the worker module is not
     *  loaded, the call returns `enqueued: 0`. */
    enqueueImpl?: (input: {
      teamId: string;
      evidenceId: string;
      reason: string;
    }) => Promise<{ enqueued: boolean }>;
  } = {},
): Promise<SearchProjectionSyncResult> {
  bump("graph_search_projection_executed_total");
  const windowMinutes = Math.max(
    1,
    Math.min(options.windowMinutes ?? RECENT_SIGNAL_WINDOW_MINUTES, 1440),
  );
  const cap = Math.max(
    1,
    Math.min(options.enqueueCap ?? MAX_REINDEX_ENQUEUES_PER_RUN, 500),
  );
  let candidates: Array<{ evidence_id: string }> = [];
  try {
    candidates = (await client.$queryRawUnsafe(
      `SELECT DISTINCT "evidence_id"
         FROM "media_intelligence_signals"
        WHERE "team_id" = $1
          AND "updated_at_utc" >= NOW() - ($2::text)::interval
        LIMIT $3`,
      teamId,
      `${windowMinutes} minutes`,
      cap,
    )) as Array<{ evidence_id: string }>;
  } catch (err) {
    return {
      ok: false,
      enqueued: 0,
      reason:
        err instanceof Error
          ? `recent_signal_query_failed:${err.message.slice(0, 60)}`
          : "recent_signal_query_failed",
    };
  }
  if (candidates.length === 0) {
    return { ok: true, enqueued: 0 };
  }

  // Phase 31.22 — REQUIRED caller-injected enqueue impl.
  //
  // The shared-runtime package MUST NOT import from services/worker
  // or services/api. Each host (worker / api / tests) injects its
  // own enqueue helper:
  //   * worker — passes a function that calls its local
  //     `enqueueSearchIndexingJob` from services/worker/src/queue.ts.
  //   * api    — passes a function that calls its local
  //     `enqueueSearchIndexingJob` from services/api/src/queue/
  //     search-queue.ts.
  //   * tests  — pass a stub.
  //
  // When NO enqueueImpl is provided, the function returns { ok: true,
  // enqueued: 0 } without making any cross-package call. This keeps
  // the service safe to call from any context (e.g. graph-reconcile
  // sidecar) without coupling the package to a specific queue impl.
  const enqueueImpl =
    options.enqueueImpl ??
    (async () => ({ enqueued: false }));

  let enqueued = 0;
  for (const c of candidates) {
    try {
      const r = await enqueueImpl({
        teamId,
        evidenceId: c.evidence_id,
        reason: "graph_search_projection_sync",
      });
      if (r.enqueued) enqueued += 1;
    } catch {
      /* per-evidence failure is best-effort */
    }
  }
  return { ok: true, enqueued };
}
