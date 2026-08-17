/**
 * Phase 31.5 — Media intelligence run tracker.
 *
 * Tracks each invocation of the media-intelligence analyzer (or
 * any future async job in the same catalog) for an evidence row.
 * The synchronous Phase 31 analyzer continues to work as before;
 * this tracker adds:
 *
 *   * Idempotency — `idempotencyKey` collapses duplicate triggers.
 *   * Bounded retry — `attempt_count` capped at MAX_RETRIES (5).
 *   * State machine — PENDING → PROCESSING → COMPLETED | FAILED.
 *     DISMISSED is set when an operator chooses to stop retrying.
 *   * Observability — every state transition bumps a metric.
 *
 * Hard rules:
 *   * Read-only against Evidence; only writes to media_intelligence_runs.
 *   * Never throws — every call returns a bounded result.
 *   * Idempotency key collapses concurrent triggers within a team.
 *   * Failure NEVER blocks evidence lifecycle (caller must handle
 *     a `{ ok: false }` result without propagating).
 *   * NEVER stores raw error traces — `last_error` bounded to 240
 *     chars (DB enforces 400).
 */

import type { PrismaClient } from "@prisma/client";
import { MEDIA_INTELLIGENCE_JOB_KINDS as SHARED_MEDIA_INTELLIGENCE_JOB_KINDS } from "@proovra/shared";

import { getRegisteredPrisma } from "../prisma-registry.js";
import { bump } from "../ops/metrics.service.js";

// =============================================================================
// Bounded catalogs
// =============================================================================

/**
 * PHASE 12 — POINT 5: this catalog is now the SHARED one plus the two
 * historical row kinds, rather than a third independent list.
 *
 * There were three definitions of "which media-intelligence kinds exist": this
 * one, the api producer's, and the worker processor's branch set. They
 * disagreed. This list was missing `compute_perceptual_hashes`,
 * `extract_ocr_azure`, `extract_transcript_deepgram` and
 * `extract_technical_metadata` — every one of which the worker implements and
 * a producer enqueues — so creating a run row for those kinds was rejected by
 * the tracker's own validation while the job ran anyway. That is precisely how
 * `enqueueMediaIntelligenceAnalysis` ended up with an OPTIONAL `runId`.
 *
 * `compute_duplicates` and `compute_lineage` are retained HERE and only here:
 * no producer enqueues them and no queue accepts them, but historical rows
 * exist and reading a row whose kind the catalog rejects would make old runs
 * unprojectable.
 */
export const MEDIA_INTELLIGENCE_RUN_KINDS = [
  ...SHARED_MEDIA_INTELLIGENCE_JOB_KINDS,
  "compute_duplicates",
  "compute_lineage",
] as const;

export type MediaIntelligenceRunKind =
  (typeof MEDIA_INTELLIGENCE_RUN_KINDS)[number];

export const MEDIA_INTELLIGENCE_RUN_STATUSES = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "DISMISSED",
] as const;

export type MediaIntelligenceRunStatus =
  (typeof MEDIA_INTELLIGENCE_RUN_STATUSES)[number];

const MAX_RETRIES = 5;

/**
 * PHASE 12 — POINT 5: the claim lease.
 *
 * How long a `PROCESSING` row is treated as actively held before another
 * worker may take it over. Exported because the stranded-run reconciler must
 * use the SAME value — a reconciler that releases leases on a different clock
 * than the one the claim enforces will either steal live work or leave dead
 * work wedged.
 */
export const MEDIA_INTELLIGENCE_RUN_LEASE_MS = 20 * 60 * 1000;

/**
 * The status a claimed, in-flight run carries.
 *
 * Exported for the same reason as the lease. The reconciler previously
 * hard-coded the string `"RUNNING"`, which NOTHING in the system ever writes:
 * every claim goes through `markRunProcessing`, which writes `PROCESSING`. The
 * consequence was that the reconciler's expired-lease branch could never match
 * a row, so a worker that died mid-run left its run `PROCESSING` forever —
 * precisely the "permanently wedged" case that branch exists to fix, and the
 * one its own comment calls the worse of the two. A shared constant is what
 * stops the two halves drifting apart again.
 */
export const MEDIA_INTELLIGENCE_RUN_CLAIMED_STATUS = "PROCESSING" as const;

// =============================================================================
// Public surface
// =============================================================================

export type MediaIntelligenceRunRow = {
  id: string;
  teamId: string;
  evidenceId: string;
  kind: MediaIntelligenceRunKind;
  status: MediaIntelligenceRunStatus;
  attemptCount: number;
  idempotencyKey: string | null;
  lastError: string | null;
  startedAtUtc: string | null;
  completedAtUtc: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
};

export type EnqueueRunInput = {
  teamId: string;
  evidenceId: string;
  kind: MediaIntelligenceRunKind;
  /** Idempotency key — collapses duplicate triggers for the same
   *  (team, kind, evidenceId). Convention:
   *  `${kind}:${evidenceId}` for the canonical per-evidence run. */
  idempotencyKey?: string | null;
};

export type EnqueueRunResult =
  | { ok: true; run: MediaIntelligenceRunRow; reused: boolean }
  | { ok: false; reason: "tracker_unavailable" };

/**
 * Create (or reuse via idempotency key) a PENDING run row. The
 * actual analyzer work happens elsewhere — this function only
 * records the intent + state.
 *
 * Idempotency: re-calls with the same `(team, idempotencyKey)`
 * return the existing row regardless of its current status.
 */
export async function enqueueMediaIntelligenceRun(
  input: EnqueueRunInput,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<EnqueueRunResult> {
  // Reuse path — collapse duplicates.
  if (input.idempotencyKey) {
    try {
      const existing = (await client.$queryRawUnsafe(
        `SELECT "id", "team_id", "evidence_id", "kind", "status",
                "attempt_count", "idempotency_key", "last_error",
                "started_at_utc", "completed_at_utc",
                "created_at_utc", "updated_at_utc"
           FROM "media_intelligence_runs"
           WHERE "team_id" = $1 AND "idempotency_key" = $2
           LIMIT 1`,
        input.teamId,
        input.idempotencyKey,
      )) as RawRunRow[];
      if (existing.length > 0) {
        return {
          ok: true,
          run: projectRun(existing[0]!),
          reused: true,
        };
      }
    } catch {
      // Fall through to insert; the unique index catches races.
    }
  }
  try {
    const rows = (await client.$queryRawUnsafe(
      `INSERT INTO "media_intelligence_runs"
         ("team_id", "evidence_id", "kind", "status", "idempotency_key", "scheduled_at_utc")
       VALUES ($1, $2, $3, 'PENDING', $4, NOW())
       RETURNING "id", "team_id", "evidence_id", "kind", "status",
         "attempt_count", "idempotency_key", "last_error",
         "started_at_utc", "completed_at_utc",
         "created_at_utc", "updated_at_utc"`,
      input.teamId,
      input.evidenceId,
      input.kind,
      input.idempotencyKey?.slice(0, 120) ?? null,
      // No scheduled_at_utc param — using NOW() literal in SQL.
    )) as RawRunRow[];
    const row = rows[0];
    if (!row) {
      return { ok: false, reason: "tracker_unavailable" };
    }
    bump("media_intelligence_job_started_total");
    return {
      ok: true,
      run: projectRun(row),
      reused: false,
    };
  } catch {
    bump("media_intelligence_job_failed_total");
    return { ok: false, reason: "tracker_unavailable" };
  }
}

/**
 * Transition a run to PROCESSING. Increments attempt_count. Refuses
 * to start if attempt_count has hit MAX_RETRIES — caller surfaces
 * that as a permanent FAILED state needing operator review.
 */
export async function markRunProcessing(
  runId: string,
  teamId: string,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<
  | { ok: true; fence: number }
  | { ok: false; reason: "max_retries_exceeded" | "tracker_unavailable" }
> {
  try {
    // PHASE 12 POINT 5 — THE CLAIM, made exclusive.
    //
    // The predicate used to be `status IN ('PENDING','PROCESSING','FAILED')`
    // with no lease condition, which is not a claim at all: a second worker
    // handed the same job could take a run another worker was actively
    // processing, and both would then call the AI provider and both would
    // charge the workspace. `attempt_count < MAX_RETRIES` bounded how many
    // times that could happen; it did not stop it happening.
    //
    // A run may now be claimed from PENDING or FAILED unconditionally — those
    // are the retry states and nobody holds them — or from PROCESSING ONLY
    // when the previous claim's lease has expired, which is exactly the
    // takeover the reconciler also performs. `started_at_utc IS NULL` is
    // included for the degenerate row whose claim never stamped a start: it
    // cannot be held by anyone, so holding it forever would be the same wedge
    // in a different disguise.
    const leaseCutoff = new Date(Date.now() - MEDIA_INTELLIGENCE_RUN_LEASE_MS);
    const rows = (await client.$queryRawUnsafe(
      `UPDATE "media_intelligence_runs"
         SET "status" = 'PROCESSING',
             "attempt_count" = "attempt_count" + 1,
             "started_at_utc" = NOW(),
             "updated_at_utc" = NOW()
         WHERE "id" = $1 AND "team_id" = $2
           AND "attempt_count" < $3
           AND (
             "status" IN ('PENDING', 'FAILED')
             OR (
               "status" = 'PROCESSING'
               AND ("started_at_utc" IS NULL OR "started_at_utc" < $4)
             )
           )
         RETURNING "id", "attempt_count"`,
      runId,
      teamId,
      MAX_RETRIES,
      leaseCutoff,
    )) as Array<{ id: string; attempt_count: number }>;
    if (rows.length === 0) {
      // Either the attempt ceiling is reached, or another worker holds a live
      // claim, or the run already reached a terminal state. All three mean the
      // same thing to the caller: it may not proceed.
      return { ok: false, reason: "max_retries_exceeded" };
    }
    // THE FENCE. `status = 'PROCESSING'` alone is not enough to protect a
    // terminal write: after a stale-lease takeover the row is PROCESSING again,
    // held by a DIFFERENT worker, and the original worker's late write would
    // still match. `attempt_count` is incremented by exactly one on every
    // successful claim, so it is a monotonic generation — and a terminal write
    // that also matches on it can only come from the worker that holds the
    // current claim.
    return { ok: true, fence: Number(rows[0]!.attempt_count) };
  } catch {
    return { ok: false, reason: "tracker_unavailable" };
  }
}

/**
 * Transition a run to COMPLETED. Clears `last_error`. Bumps the
 * completed counter.
 */
export async function markRunCompleted(
  runId: string,
  teamId: string,
  client: PrismaClient = getRegisteredPrisma(),
  /**
   * The value `markRunProcessing` returned for THIS claim.
   *
   * Optional only so that legacy call sites keep compiling; every production
   * caller passes it, and the fencing gate asserts they do. Omitting it falls
   * back to the status-only predicate, which is safe against replay but NOT
   * against a stale worker whose replacement re-claimed the row.
   */
  fence?: number,
): Promise<{ ok: boolean }> {
  try {
    // PHASE 12 POINT 5 — only the CLAIM HOLDER may write a terminal state.
    //
    // Without the `status = 'PROCESSING'` predicate, a worker whose lease had
    // expired — and whose replacement had already finished or failed the run —
    // could write its own late outcome over the truth. It would also let a
    // COMPLETED run be re-completed by a replayed delivery, restamping
    // `completed_at_utc` and re-incrementing the counter.
    const affected = await client.$executeRawUnsafe(
      `UPDATE "media_intelligence_runs"
         SET "status" = 'COMPLETED',
             "last_error" = NULL,
             "completed_at_utc" = NOW(),
             "updated_at_utc" = NOW()
         WHERE "id" = $1 AND "team_id" = $2 AND "status" = 'PROCESSING'
           AND ($3::int IS NULL OR "attempt_count" = $3::int)`,
      runId,
      teamId,
      fence ?? null,
    );
    if (affected === 0) return { ok: false };
    bump("media_intelligence_job_completed_total");
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Transition a run to FAILED. Stores a bounded error summary
 * (caller must strip stack traces / paths before passing). After
 * MAX_RETRIES the run stays in FAILED until manually dismissed
 * or re-run with a fresh idempotency key.
 */
export async function markRunFailed(
  runId: string,
  teamId: string,
  errorSummary: string,
  client: PrismaClient = getRegisteredPrisma(),
  /** The value `markRunProcessing` returned for THIS claim. See above. */
  fence?: number,
): Promise<{ ok: boolean }> {
  try {
    // Same claim-holder predicate as `markRunCompleted`. A late failure from a
    // superseded worker must not overwrite a COMPLETED run: the extraction
    // succeeded, and the row saying otherwise would send an operator hunting a
    // failure that did not happen.
    const affected = await client.$executeRawUnsafe(
      `UPDATE "media_intelligence_runs"
         SET "status" = 'FAILED',
             "last_error" = $3,
             "updated_at_utc" = NOW()
         WHERE "id" = $1 AND "team_id" = $2 AND "status" = 'PROCESSING'
           AND ($4::int IS NULL OR "attempt_count" = $4::int)`,
      runId,
      teamId,
      // Strip newlines, slash-paths, and bound to 240 chars so
      // stack traces / S3 URLs can never bleed in.
      errorSummary
        .replace(/[\n\r\t]/g, " ")
        .replace(/https?:\/\/[^\s]+/g, "")
        .slice(0, 240),
      fence ?? null,
    );
    if (affected === 0) return { ok: false };
    bump("media_intelligence_job_failed_total");
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Operator-initiated dismissal. Stops the retry ladder for runs
 * that have been determined to be permanently failed (e.g.
 * unsupported file type).
 *
 * PHASE 13 §4 (2026-08-17) — `ok` now reports whether a row actually moved.
 *
 * It previously discarded the affected count and returned `{ ok: true }` for
 * anything that did not throw, which made the three cases the WHERE clause
 * exists to distinguish — run absent, run in another workspace, run already
 * terminal — indistinguishable from a successful dismissal. Once an operator
 * route sits in front of this (POST /v1/ops/media-intelligence/runs/:runId/
 * dismiss) that is the difference between telling an operator the run is
 * handled and telling them the truth, and the `media_intelligence_run_
 * dismissed_total` counter would have counted requests rather than dismissals.
 *
 * Idempotency is unchanged and is the WHERE clause's doing: a second dismissal
 * of the same run matches no row, writes nothing, and now honestly reports
 * `ok: false` rather than claiming a second dismissal happened.
 */
export async function dismissRun(
  runId: string,
  teamId: string,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<{ ok: boolean }> {
  try {
    const affected = await client.$executeRawUnsafe(
      `UPDATE "media_intelligence_runs"
         SET "status" = 'DISMISSED',
             "updated_at_utc" = NOW()
         WHERE "id" = $1 AND "team_id" = $2
           AND "status" IN ('PENDING', 'FAILED', 'PROCESSING')`,
      runId,
      teamId,
    );
    if (typeof affected === "number" && affected === 0) return { ok: false };
    bump("media_intelligence_run_dismissed_total");
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Read the recent runs for an evidence row (team-anchored).
 */
export async function listRecentRunsForEvidence(
  teamId: string,
  evidenceId: string,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<ReadonlyArray<MediaIntelligenceRunRow>> {
  try {
    const rows = (await client.$queryRawUnsafe(
      `SELECT "id", "team_id", "evidence_id", "kind", "status",
              "attempt_count", "idempotency_key", "last_error",
              "started_at_utc", "completed_at_utc",
              "created_at_utc", "updated_at_utc"
         FROM "media_intelligence_runs"
         WHERE "team_id" = $1 AND "evidence_id" = $2
         ORDER BY "created_at_utc" DESC
         LIMIT 50`,
      teamId,
      evidenceId,
    )) as RawRunRow[];
    return rows.map(projectRun);
  } catch {
    return [];
  }
}

// =============================================================================
// Internals
// =============================================================================

type RawRunRow = {
  id: string;
  team_id: string;
  evidence_id: string;
  kind: string;
  status: string;
  attempt_count: number;
  idempotency_key: string | null;
  last_error: string | null;
  started_at_utc: Date | null;
  completed_at_utc: Date | null;
  created_at_utc: Date;
  updated_at_utc: Date;
};

function projectRun(raw: RawRunRow): MediaIntelligenceRunRow {
  return {
    id: raw.id,
    teamId: raw.team_id,
    evidenceId: raw.evidence_id,
    kind: raw.kind as MediaIntelligenceRunKind,
    status: raw.status as MediaIntelligenceRunStatus,
    attemptCount: raw.attempt_count,
    idempotencyKey: raw.idempotency_key,
    lastError: raw.last_error,
    startedAtUtc: raw.started_at_utc?.toISOString() ?? null,
    completedAtUtc: raw.completed_at_utc?.toISOString() ?? null,
    createdAtUtc: raw.created_at_utc.toISOString(),
    updatedAtUtc: raw.updated_at_utc.toISOString(),
  };
}
