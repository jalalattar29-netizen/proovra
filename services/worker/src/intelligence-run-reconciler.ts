/**
 * PHASE 12 — POINT 5: stranded intelligence-run reconciler.
 *
 * `MediaIntelligenceRun` is the durable authority for the intelligence family.
 * Two states can strand:
 *
 *   * PENDING with no live job — the row was committed and the enqueue failed,
 *     or the job was dropped. The run never starts and nothing reports it.
 *
 *   * RUNNING past its lease — the worker that claimed it died. BullMQ will
 *     eventually retry the JOB, but the row stays RUNNING forever, so the
 *     claim can never be won again and the retry no-ops on arrival. That is the
 *     worse of the two: the queue looks healthy and the run is permanently
 *     wedged.
 *
 * This reconciler returns expired-lease rows to PENDING and re-enqueues
 * genuinely stranded work, both under bounded batches.
 *
 * What it deliberately does NOT do:
 *
 *   * It never marks a run SUCCEEDED or FAILED. Terminal state belongs to the
 *     processor; a reconciler that can write success can fabricate it.
 *   * It never re-runs a run that reached a terminal state. Re-running a
 *     completed AI extraction spends money and can produce a second set of
 *     observations for the same evidence.
 *   * It never widens scope. Candidates come from the run rows themselves, so
 *     the workspace is always database-derived.
 */

import {
  DERIVED_PRODUCTION_INELIGIBLE_LIFECYCLE_STATES,
  MEDIA_INTELLIGENCE_RUN_CLAIMED_STATUS as CLAIMED_STATUS,
  MEDIA_INTELLIGENCE_RUN_LEASE_MS,
} from "@proovra/shared-runtime";

import { logger } from "./logger.js";
import { prisma } from "./db.js";

/**
 * THE WORK THIS MODULE RECOVERS.
 *
 * Declared here so the canonical work registry's `reconciler` field can be
 * checked against the module it names rather than merely against the
 * filesystem. The topology gate proves the two agree in both directions: a
 * registry entry pointing at a module that does not claim its work fails, and
 * a module claiming work no entry assigns it fails.
 *
 * That check exists because the weaker one — "the declared file exists" —
 * passed three false declarations in a row: UPGRADE_OTS and
 * PURGE_DELETED_EVIDENCE both named a module containing no such code, and
 * EMBED_SEMANTIC_CHUNKS named one whose every scan keyed on a table the embed
 * chain never writes. All three resolved to a real file. None of them was true.
 *
 * Keys, not values: the registry addresses work through `JOB_NAMES` /
 * `SWEEP_NAMES`, and a literal string here would be a second spelling of a
 * name the shared authority already owns.
 *
 * ET-Q-07 (2026-09-30) — two entries left this list, for two different reasons.
 *
 *   * `EXTRACT_EXIF` — the `mi-exif` queue was retired as producerless, so the
 *     work name no longer exists. EXIF extraction is a `MediaIntelligenceRun`
 *     of kind `extract_exif`, which `RUN_MEDIA_INTELLIGENCE` below covers.
 *
 *   * `GENERATE_DERIVED_ASSET` — THIS WAS A FALSE CLAIM, AND IS NOW A TRUE ONE.
 *     Every scan in this file keyed on `MediaIntelligenceRun` or on the
 *     semantic-chunk embedding; nothing read `EvidencePartDerivedAsset`, so a
 *     derived-asset row whose enqueue was lost stayed PENDING and this module
 *     could not see it. It left the list while that was so. It is back because
 *     `reconcileStrandedDerivedAssets` (step 4 of the tick) now scans exactly
 *     that table and re-enqueues through the canonical producer.
 */
export const RECOVERED_WORK_TYPES = [
  "RUN_MEDIA_INTELLIGENCE",
  "GENERATE_DERIVED_ASSET",
  "EMBED_SEMANTIC_CHUNKS",
  "INTELLIGENCE_RUN_RECONCILER",
] as const;


/**
 * Lease beyond which a claimed row is assumed abandoned.
 *
 * PHASE 12 POINT 5 — this file used to select `status: "RUNNING"`, a value
 * NOTHING in the system writes: every claim goes through `markRunProcessing`,
 * which writes `PROCESSING`. So the expired-lease branch below could never
 * match a row, and a worker that died mid-run left its run claimed forever —
 * exactly the "permanently wedged" case the comment above calls the worse of
 * the two. The health snapshot had the same bug and therefore always reported
 * zero in-flight runs.
 *
 * Both the status and the lease duration are now imported from the tracker
 * that enforces them, so the claim and its recovery cannot drift apart again.
 */
const RUNNING_LEASE_MS = MEDIA_INTELLIGENCE_RUN_LEASE_MS;
/** How long a PENDING row may sit before it is considered stranded. */
const PENDING_STRANDED_MS = 15 * 60 * 1000;
/** A chunk written this recently may still have its original job in flight. */
const EMBED_OWED_MIN_AGE_MS = 30 * 60 * 1000;
/** Older than this and whatever produced it is long gone; not this sweep’s. */
const EMBED_OWED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_BATCH = 50;

/**
 * Attempts beyond which a run is left alone for an operator.
 *
 * A run that has already been recovered this many times is not suffering from a
 * lost worker — something about the run itself is failing — and repeatedly
 * re-enqueuing it burns provider budget to reach the same outcome.
 */
const MAX_RECOVERY_ATTEMPTS = 5;

export type IntelligenceRunReconcileOptions = {
  trigger?: string;
  batchSize?: number;
};

export type IntelligenceRunReconcileResult = {
  ok: boolean;
  expiredLeasesReleased: number;
  strandedReEnqueued: number;
  abandonedForOperator: number;
  failed: number;
  /**
   * Chunks found still owing an embedding, and how many were re-enqueued.
   *
   * ---------------------------------------------------------------------------
   * GOVERNANCE CLOSURE (2026-09-09) — THE REGISTRY NAMED THIS MODULE AND THIS
   * MODULE COULD NOT SEE THE WORK.
   * ---------------------------------------------------------------------------
   * `EMBED_SEMANTIC_CHUNKS` declares `reconciler: intelligence-run-reconciler.ts`,
   * and until now that was false in the way that matters: every scan in this file
   * keys on `MediaIntelligenceRun`, and the embed producer writes no run row. It
   * enqueues with `commandId: anchorChunkId` against chunk rows that already
   * exist. So a lost embed enqueue left chunks unembedded forever, and the one
   * module the registry pointed an operator at could not have found them.
   *
   * The durable fact was already in the schema and needed no new column:
   * `EvidenceSemanticChunk.embedding` is nullable, so `embedding IS NULL` IS
   * "this chunk is owed an embedding". Scanning it makes the existing
   * declaration true rather than re-pointing the registry at something else,
   * and it creates no second embedding authority — recovery re-enqueues through
   * `enqueueMiEmbedJob`, the same canonical producer the live path uses.
   */
  embedChunksOwed: number;
  embedChunksReEnqueued: number;
  /**
   * ET-Q-07 (2026-09-30) — derived assets found stranded PENDING, and what
   * became of each. See {@link reconcileStrandedDerivedAssets}.
   */
  derivedAssetsStranded: number;
  derivedAssetsReEnqueued: number;
  /** The asset's job was already live; the enqueue joined it. Not new work. */
  derivedAssetsCollapsed: number;
  /** Settled FAILED after the recovery ceiling, for an operator to re-request. */
  derivedAssetsAbandoned: number;
  durationMs: number;
  error?: string;
};

export async function runIntelligenceRunReconciler(
  options: IntelligenceRunReconcileOptions = {},
): Promise<IntelligenceRunReconcileResult> {
  const startedAt = Date.now();
  const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH, 500));
  const result: IntelligenceRunReconcileResult = {
    ok: true,
    expiredLeasesReleased: 0,
    strandedReEnqueued: 0,
    abandonedForOperator: 0,
    failed: 0,
    embedChunksOwed: 0,
    embedChunksReEnqueued: 0,
    derivedAssetsStranded: 0,
    derivedAssetsReEnqueued: 0,
    derivedAssetsCollapsed: 0,
    derivedAssetsAbandoned: 0,
    durationMs: 0,
  };

  try {
    // ---- 1. Release expired RUNNING leases ------------------------------
    //
    // The update is CONDITIONAL on the row still being RUNNING with the same
    // stale claim, so two overlapping reconciler ticks cannot both "recover"
    // the same row, and a worker that comes back to life mid-sweep and writes a
    // terminal state wins — its write moves the row out of RUNNING, and this
    // update then matches zero rows.
    const leaseCutoff = new Date(Date.now() - RUNNING_LEASE_MS);
    const expired = await prisma.mediaIntelligenceRun.findMany({
      where: {
        status: CLAIMED_STATUS,
        startedAtUtc: { lt: leaseCutoff },
      },
      select: { id: true, attemptCount: true },
      orderBy: { startedAtUtc: "asc" },
      take: batchSize,
    });

    for (const run of expired) {
      if (run.attemptCount >= MAX_RECOVERY_ATTEMPTS) {
        const abandoned = await prisma.mediaIntelligenceRun.updateMany({
          where: { id: run.id, status: CLAIMED_STATUS, startedAtUtc: { lt: leaseCutoff } },
          data: {
            status: "FAILED",
            lastError: "recovery_attempts_exhausted",
            completedAtUtc: new Date(),
            updatedAtUtc: new Date(),
          },
        });
        if (abandoned.count === 1) result.abandonedForOperator += 1;
        continue;
      }
      const released = await prisma.mediaIntelligenceRun.updateMany({
        where: { id: run.id, status: CLAIMED_STATUS, startedAtUtc: { lt: leaseCutoff } },
        data: {
          status: "PENDING",
          startedAtUtc: null,
          lastError: "lease_expired_recovered",
          updatedAtUtc: new Date(),
        },
      });
      if (released.count === 1) result.expiredLeasesReleased += 1;
    }

    // ---- 2. Re-enqueue stranded PENDING runs -----------------------------
    //
    // UC-DER-013 — a run whose record has left service (trashed, destruction-
    // bound, destroyed) is not re-enqueued: re-running it would write new
    // derived bytes/text onto a record that must not gain any. It stays PENDING
    // (a restored record is served by the next tick) and the eligibility test
    // is in SQL so such runs cannot crowd eligible ones out of the batch.
    const pendingCutoff = new Date(Date.now() - PENDING_STRANDED_MS);
    const stranded = await selectStrandedRuns({ cutoff: pendingCutoff, limit: batchSize });

    if (stranded.length > 0) {
      const { enqueueMediaIntelligenceRunById } = await import("./queue.js");
      for (const run of stranded) {
        if (run.attemptCount >= MAX_RECOVERY_ATTEMPTS) {
          result.abandonedForOperator += 1;
          continue;
        }
        try {
          const outcome = await enqueueMediaIntelligenceRunById(run.id);
          if (outcome.enqueued) result.strandedReEnqueued += 1;
          else result.failed += 1;
        } catch {
          result.failed += 1;
        }
      }
    }

    // ---- 3. Chunks still owing an embedding ------------------------------
    //
    // The population is `embedding IS NULL` on a chunk old enough that the
    // original handoff cannot still be in flight. Both bounds matter: the floor
    // keeps a chunk written seconds ago out of the scan, and the ceiling keeps
    // the sweep off rows so old that whatever produced them is long gone.
    //
    // SELF-DRAINING, so a limit is the right bound rather than a cursor: a
    // chunk leaves this population by acquiring an embedding, so a row not
    // served this tick is matched by the next one, and oldest-first means the
    // longest-waiting chunks are the ones a short tick serves.
    //
    // Re-enqueue is IDEMPOTENT by the canonical job id, so a chunk whose job is
    // still queued collapses onto it rather than being scheduled twice.
    const embedFloor = new Date(Date.now() - EMBED_OWED_MIN_AGE_MS);
    const embedCeiling = new Date(Date.now() - EMBED_OWED_MAX_AGE_MS);
    // ET-Q-10 — "owed" is the column mi-embed WRITES: `embedding_vector`
    // (pgvector, invisible to Prisma's typed client, hence raw SQL). The legacy
    // `embedding` bytes column is written by nothing, so every chunk in the
    // window read as owed forever. And only a workspace whose AI policy allows
    // embeddings owes one: mi-embed drains a disallowed workspace's job without
    // embedding, so selecting its chunks re-enqueued them every tick and
    // crowded genuinely owed chunks out of the batch.
    const owed = await selectChunksOwingEmbedding({
      floor: embedFloor,
      ceiling: embedCeiling,
      limit: batchSize,
    });
    result.embedChunksOwed = owed.length;

    if (owed.length > 0) {
      const { enqueueMiEmbedJob } = await import("./queue.js");
      for (const chunk of owed) {
        try {
          const outcome = await enqueueMiEmbedJob(chunk.id, { reason: "reconciler" });
          if (outcome.enqueued) result.embedChunksReEnqueued += 1;
        } catch {
          // Fail-isolated: one chunk that cannot be enqueued is counted and
          // stepped over. A reconciler that throws stops reconciling.
          result.failed += 1;
        }
      }
    }

    // ---- 4. Derived assets stranded PENDING ------------------------------
    //
    // Fail-isolated inside the helper: a derived-asset scan that cannot run
    // is counted and logged there, and never turns the three steps above —
    // which have already done their work — into a failed tick.
    const derived = await reconcileStrandedDerivedAssets({ batchSize });
    result.derivedAssetsStranded = derived.stranded;
    result.derivedAssetsReEnqueued = derived.reEnqueued;
    result.derivedAssetsCollapsed = derived.collapsed;
    result.derivedAssetsAbandoned = derived.abandoned;
    result.failed += derived.failed;

    logger.info(
      {
        reconciler: "intelligence-run",
        trigger: options.trigger ?? "scheduler",
        ...result,
        durationMs: Date.now() - startedAt,
      },
      "worker.intelligence_run.reconciled",
    );
  } catch (err) {
    result.ok = false;
    result.error = err instanceof Error ? err.message.slice(0, 200) : "unknown";
    logger.error(
      {
        reconciler: "intelligence-run",
        trigger: options.trigger ?? "scheduler",
        error: result.error,
      },
      "worker.intelligence_run.reconcile_failed",
    );
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

/**
 * ET-Q-10 — chunks that genuinely owe an embedding: no `embedding_vector`,
 * inside the age window, in a workspace whose AI policy allows embeddings.
 * Oldest first. An environment without the pgvector column (not migrated)
 * owes nothing this reconciler can deliver, and answers empty.
 */
export async function selectChunksOwingEmbedding(input: {
  floor: Date;
  ceiling: Date;
  limit: number;
}): Promise<Array<{ id: string }>> {
  try {
    return await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id::text AS id
        FROM evidence_semantic_chunks c
        JOIN workspace_ai_policies p ON p.team_id = c.team_id
       WHERE c.embedding_vector IS NULL
         AND c.created_at <= ${input.floor}
         AND c.created_at >= ${input.ceiling}
         AND p.ai_enabled
         AND p.semantic_search_enabled
         AND p.embeddings_allowed
       ORDER BY c.created_at ASC
       LIMIT ${input.limit}
    `;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message.slice(0, 200) : "unknown" },
      "worker.intelligence_run.embed_owed_unavailable",
    );
    return [];
  }
}

// ===========================================================================
// ET-Q-07 (2026-09-30) — DERIVED ASSETS STRANDED PENDING
// ===========================================================================

/**
 * Evidence lifecycle states whose derived assets are NOT regenerated.
 *
 * A trashed record is on its way out and a record in or past destruction has
 * had — or is about to have — its bytes removed. Generating a fresh derivative
 * for either writes a new object the destruction accounting then has to find
 * and remove again. The reconciler steps over them; if the record is restored,
 * the row is still PENDING and the next tick serves it.
 */
export const DERIVED_ASSET_INELIGIBLE_LIFECYCLE_STATES = DERIVED_PRODUCTION_INELIGIBLE_LIFECYCLE_STATES;

/**
 * UC-DER-013 — PENDING runs older than the cutoff whose record is still in
 * service. A run whose evidence row no longer exists keeps its previous
 * treatment (it is served and settles on its own); a run whose record is
 * trashed / destruction-bound / destroyed is excluded.
 */
export async function selectStrandedRuns(input: {
  cutoff: Date;
  limit: number;
}): Promise<Array<{ id: string; kind: string; evidenceId: string; attemptCount: number }>> {
  const ineligible = DERIVED_PRODUCTION_INELIGIBLE_LIFECYCLE_STATES.map((s) => `'${s}'`).join(",");
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT r."id"::text AS id, r."kind" AS kind,
            r."evidence_id"::text AS evidence_id, r."attempt_count" AS attempt_count
       FROM "media_intelligence_runs" r
       LEFT JOIN "evidence" e ON e."id" = r."evidence_id"
      WHERE r."status" = 'PENDING'
        AND r."updated_at_utc" < $1
        AND (
          e."id" IS NULL
          OR (e."deleted_at" IS NULL
              AND COALESCE(e."lifecycle_state"::text, 'ACTIVE') NOT IN (${ineligible}))
        )
      ORDER BY r."updated_at_utc" ASC
      LIMIT $2`,
    input.cutoff,
    input.limit,
  )) as Array<{ id: string; kind: string; evidence_id: string; attempt_count: number }>;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    evidenceId: r.evidence_id,
    attemptCount: Number(r.attempt_count),
  }));
}

/**
 * How many times this reconciler re-enqueues one derived asset before it stops
 * and hands the row to an operator.
 *
 * The row has no attempt counter, and adding a column is a migration this
 * change does not make. The count is therefore carried in `last_error` — a
 * column a PENDING row does not otherwise use (the producer writes NULL when
 * it opens or re-opens a request) — as `stranded_pending_reenqueued:<n>`.
 */
const DERIVED_ASSET_MAX_RECOVERY_ATTEMPTS = MAX_RECOVERY_ATTEMPTS;
export const DERIVED_ASSET_RECOVERY_MARKER = "stranded_pending_reenqueued:";

/** Attempts already spent on a row, read from its recovery marker. */
export function derivedAssetRecoveryAttempts(lastError: string | null | undefined): number {
  if (!lastError || !lastError.startsWith(DERIVED_ASSET_RECOVERY_MARKER)) return 0;
  const n = Number.parseInt(lastError.slice(DERIVED_ASSET_RECOVERY_MARKER.length), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export type DerivedAssetReconcileResult = {
  stranded: number;
  reEnqueued: number;
  collapsed: number;
  abandoned: number;
  /** Rows whose evidence turned out to be ineligible at claim time. */
  skippedIneligible: number;
  failed: number;
};

/**
 * Re-enqueue `EvidencePartDerivedAsset` rows stranded PENDING.
 *
 * THE GAP THIS CLOSES
 * ---------------------------------------------------------------------------
 * The API producer (`enqueueDerivedAssetGeneration`) commits the row PENDING
 * and THEN enqueues its id. Its own comment says a Redis outage "leaves the row
 * PENDING, which is a recoverable and observable state" — and until now
 * nothing recovered it. The registry named this module as the reconciler for
 * `GenerateDerivedAsset` while no scan in it read this table, so a lost enqueue
 * (or a job that died before its processor wrote a terminal status) left the
 * row PENDING forever.
 *
 * THE AUTHORITY is the row itself: `status = 'PENDING'` with an
 * `updated_at_utc` older than the stranded threshold. PENDING is the ONLY
 * non-terminal status this table is ever given — `PROCESSING` is permitted by
 * the CHECK constraint but written by nothing — so there is no lease to expire
 * and no second state to scan.
 *
 * IDEMPOTENCY, in three layers:
 *
 *   1. THE CLAIM. Before enqueueing, the row's `updated_at_utc` is advanced
 *      with a conditional update that still requires `status = 'PENDING'` and
 *      the stale timestamp. Two overlapping ticks (or two worker replicas)
 *      cannot both win it, and the winner's row leaves the stranded window
 *      until a full threshold has passed again.
 *   2. THE JOB ID. The re-enqueue goes through `enqueueDerivedAssetJob`, which
 *      is the same `enqueueCanonicalJob` + registry entry the API producer
 *      uses, with the same command id (the row id). The job id is therefore
 *      `mi-derived-<rowId>` on both paths: an asset whose job is still queued
 *      or running collapses onto it rather than being scheduled twice.
 *   3. THE PROCESSOR. A replayed job for a row already COMPLETED or UNSUPPORTED
 *      is a logged no-op, so a re-enqueue that loses a race with the original
 *      job regenerates nothing.
 *
 * BOUNDED: one page of at most `batchSize` rows per tick, oldest first. The
 * population is self-draining — a served row leaves it through the claim — so
 * successive ticks page through a backlog without a cursor.
 *
 * NOT A RETRY LOOP: a row re-enqueued `DERIVED_ASSET_MAX_RECOVERY_ATTEMPTS`
 * times and still PENDING is not suffering from a lost job. It is settled
 * FAILED with `recovery_attempts_exhausted`, which an operator can see and
 * re-request through the authorized route (that route re-opens the row and
 * clears the marker). Only a NEW schedule spends an attempt: an enqueue that
 * fails, or collapses onto a live job, does not, so a Redis outage cannot walk
 * a healthy backlog to FAILED.
 *
 * It never writes COMPLETED. Success belongs to the processor.
 */
export async function reconcileStrandedDerivedAssets(input: {
  batchSize: number;
  strandedAfterMs?: number;
}): Promise<DerivedAssetReconcileResult> {
  const out: DerivedAssetReconcileResult = {
    stranded: 0,
    reEnqueued: 0,
    collapsed: 0,
    abandoned: 0,
    skippedIneligible: 0,
    failed: 0,
  };
  const limit = Math.max(1, Math.min(input.batchSize, 500));
  const cutoff = new Date(
    Date.now() - Math.max(60_000, input.strandedAfterMs ?? PENDING_STRANDED_MS),
  );

  let stranded: Array<{ id: string; evidence_id: string; last_error: string | null }>;
  try {
    stranded = await selectStrandedDerivedAssets({ cutoff, limit });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message.slice(0, 200) : "unknown" },
      "worker.intelligence_run.derived_assets_scan_unavailable",
    );
    out.failed += 1;
    return out;
  }
  out.stranded = stranded.length;
  if (stranded.length === 0) return out;

  const { enqueueDerivedAssetJob } = await import("./queue.js");

  for (const asset of stranded) {
    try {
      const attempts = derivedAssetRecoveryAttempts(asset.last_error);

      if (attempts >= DERIVED_ASSET_MAX_RECOVERY_ATTEMPTS) {
        const abandoned = await prisma.evidencePartDerivedAsset.updateMany({
          where: { id: asset.id, status: "PENDING", updatedAtUtc: { lt: cutoff } },
          data: {
            status: "FAILED",
            lastError: "recovery_attempts_exhausted",
            updatedAtUtc: new Date(),
          },
        });
        if (abandoned.count === 1) out.abandoned += 1;
        continue;
      }

      // The record may have been trashed or destroyed between the scan and
      // now. Re-read it rather than trust the page.
      const evidence = await prisma.evidence.findFirst({
        where: {
          id: asset.evidence_id,
          deletedAt: null,
          lifecycleState: { notIn: [...DERIVED_ASSET_INELIGIBLE_LIFECYCLE_STATES] },
        },
        select: { id: true },
      });
      if (!evidence) {
        out.skippedIneligible += 1;
        continue;
      }

      // THE CLAIM — see the header. Zero rows means another tick has it, or
      // the processor settled it in the meantime.
      const claimed = await prisma.evidencePartDerivedAsset.updateMany({
        where: { id: asset.id, status: "PENDING", updatedAtUtc: { lt: cutoff } },
        data: { updatedAtUtc: new Date() },
      });
      if (claimed.count !== 1) continue;

      const outcome = await enqueueDerivedAssetJob(asset.id, {
        traceId: "reconciler",
      });
      if (!outcome.enqueued) {
        out.failed += 1;
        continue;
      }
      if (outcome.collapsed) {
        out.collapsed += 1;
        continue;
      }
      out.reEnqueued += 1;
      // Only a NEW schedule spends an attempt. Still conditional on PENDING so
      // a processor that finished first keeps its own `last_error`.
      await prisma.evidencePartDerivedAsset.updateMany({
        where: { id: asset.id, status: "PENDING" },
        data: { lastError: `${DERIVED_ASSET_RECOVERY_MARKER}${attempts + 1}` },
      });
    } catch {
      // Fail-isolated: one row that cannot be served is counted and stepped
      // over. A reconciler that throws stops reconciling.
      out.failed += 1;
    }
  }
  return out;
}

/**
 * The stranded population: PENDING, older than the cutoff, on evidence that is
 * still live. Oldest first, bounded.
 *
 * The eligibility join is in SQL rather than applied to the page afterwards:
 * rows of trashed or destroyed evidence never leave PENDING, so filtering them
 * out in memory would let them accumulate at the head of an oldest-first page
 * until they starved every eligible row behind them.
 */
export async function selectStrandedDerivedAssets(input: {
  cutoff: Date;
  limit: number;
}): Promise<Array<{ id: string; evidence_id: string; last_error: string | null }>> {
  const ineligible = DERIVED_ASSET_INELIGIBLE_LIFECYCLE_STATES.map((s) => `'${s}'`).join(",");
  return (await prisma.$queryRawUnsafe(
    `SELECT d."id"::text AS id,
            d."evidence_id"::text AS evidence_id,
            d."last_error" AS last_error
       FROM "evidence_part_derived_assets" d
       JOIN "evidence" e ON e."id" = d."evidence_id"
      WHERE d."status" = 'PENDING'
        AND d."updated_at_utc" < $1
        AND e."deleted_at" IS NULL
        AND COALESCE(e."lifecycle_state"::text, 'ACTIVE') NOT IN (${ineligible})
      ORDER BY d."updated_at_utc" ASC
      LIMIT $2`,
    input.cutoff,
    input.limit,
  )) as Array<{ id: string; evidence_id: string; last_error: string | null }>;
}

/**
 * Bounded operator projection of intelligence-run health.
 *
 * Counts only — no evidence ids, no run content, no provider detail.
 */
export async function getIntelligenceRunHealthSnapshot(): Promise<{
  pendingCount: number;
  runningCount: number;
  expiredLeaseCount: number;
  failedCount: number;
  oldestPendingAgeMs: number | null;
}> {
  const leaseCutoff = new Date(Date.now() - RUNNING_LEASE_MS);
  const [pendingCount, runningCount, expiredLeaseCount, failedCount, oldest] =
    await Promise.all([
      prisma.mediaIntelligenceRun.count({ where: { status: "PENDING" } }),
      prisma.mediaIntelligenceRun.count({ where: { status: CLAIMED_STATUS } }),
      prisma.mediaIntelligenceRun.count({
        where: { status: CLAIMED_STATUS, startedAtUtc: { lt: leaseCutoff } },
      }),
      prisma.mediaIntelligenceRun.count({ where: { status: "FAILED" } }),
      prisma.mediaIntelligenceRun.findFirst({
        where: { status: "PENDING" },
        select: { updatedAtUtc: true },
        orderBy: { updatedAtUtc: "asc" },
      }),
    ]);

  return {
    pendingCount,
    runningCount,
    expiredLeaseCount,
    failedCount,
    oldestPendingAgeMs: oldest
      ? Date.now() - oldest.updatedAtUtc.getTime()
      : null,
  };
}
