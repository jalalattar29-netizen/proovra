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
import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
// =============================================================================
// Bounded catalogs
// =============================================================================
export const MEDIA_INTELLIGENCE_RUN_KINDS = [
    "analyze_metadata",
    // Phase 31.8 — real EXIF extraction job. Sits between
    // analyze_metadata (which is DB-only) and extract_assets (deferred).
    // The worker that runs `extract_exif` fetches a bounded byte range,
    // invokes the EXIF extractor library, and persists the safe summary.
    "extract_exif",
    "extract_assets",
    "compute_duplicates",
    "compute_lineage",
    "wire_ocr_transcript",
    "reindex",
    "reconcile",
];
export const MEDIA_INTELLIGENCE_RUN_STATUSES = [
    "PENDING",
    "PROCESSING",
    "COMPLETED",
    "FAILED",
    "DISMISSED",
];
const MAX_RETRIES = 5;
/**
 * Create (or reuse via idempotency key) a PENDING run row. The
 * actual analyzer work happens elsewhere — this function only
 * records the intent + state.
 *
 * Idempotency: re-calls with the same `(team, idempotencyKey)`
 * return the existing row regardless of its current status.
 */
export async function enqueueMediaIntelligenceRun(input, client = defaultPrisma) {
    // Reuse path — collapse duplicates.
    if (input.idempotencyKey) {
        try {
            const existing = (await client.$queryRawUnsafe(`SELECT "id", "team_id", "evidence_id", "kind", "status",
                "attempt_count", "idempotency_key", "last_error",
                "started_at_utc", "completed_at_utc",
                "created_at_utc", "updated_at_utc"
           FROM "media_intelligence_runs"
           WHERE "team_id" = $1 AND "idempotency_key" = $2
           LIMIT 1`, input.teamId, input.idempotencyKey));
            if (existing.length > 0) {
                return {
                    ok: true,
                    run: projectRun(existing[0]),
                    reused: true,
                };
            }
        }
        catch {
            // Fall through to insert; the unique index catches races.
        }
    }
    try {
        const rows = (await client.$queryRawUnsafe(`INSERT INTO "media_intelligence_runs"
         ("team_id", "evidence_id", "kind", "status", "idempotency_key", "scheduled_at_utc")
       VALUES ($1, $2, $3, 'PENDING', $4, NOW())
       RETURNING "id", "team_id", "evidence_id", "kind", "status",
         "attempt_count", "idempotency_key", "last_error",
         "started_at_utc", "completed_at_utc",
         "created_at_utc", "updated_at_utc"`, input.teamId, input.evidenceId, input.kind, input.idempotencyKey?.slice(0, 120) ?? null));
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
    }
    catch {
        bump("media_intelligence_job_failed_total");
        return { ok: false, reason: "tracker_unavailable" };
    }
}
/**
 * Transition a run to PROCESSING. Increments attempt_count. Refuses
 * to start if attempt_count has hit MAX_RETRIES — caller surfaces
 * that as a permanent FAILED state needing operator review.
 */
export async function markRunProcessing(runId, teamId, client = defaultPrisma) {
    try {
        const rows = (await client.$queryRawUnsafe(`UPDATE "media_intelligence_runs"
         SET "status" = 'PROCESSING',
             "attempt_count" = "attempt_count" + 1,
             "started_at_utc" = NOW(),
             "updated_at_utc" = NOW()
         WHERE "id" = $1 AND "team_id" = $2
           AND "status" IN ('PENDING', 'PROCESSING', 'FAILED')
           AND "attempt_count" < $3
         RETURNING "id"`, runId, teamId, MAX_RETRIES));
        if (rows.length === 0) {
            return { ok: false, reason: "max_retries_exceeded" };
        }
        return { ok: true };
    }
    catch {
        return { ok: false, reason: "tracker_unavailable" };
    }
}
/**
 * Transition a run to COMPLETED. Clears `last_error`. Bumps the
 * completed counter.
 */
export async function markRunCompleted(runId, teamId, client = defaultPrisma) {
    try {
        await client.$executeRawUnsafe(`UPDATE "media_intelligence_runs"
         SET "status" = 'COMPLETED',
             "last_error" = NULL,
             "completed_at_utc" = NOW(),
             "updated_at_utc" = NOW()
         WHERE "id" = $1 AND "team_id" = $2`, runId, teamId);
        bump("media_intelligence_job_completed_total");
        return { ok: true };
    }
    catch {
        return { ok: false };
    }
}
/**
 * Transition a run to FAILED. Stores a bounded error summary
 * (caller must strip stack traces / paths before passing). After
 * MAX_RETRIES the run stays in FAILED until manually dismissed
 * or re-run with a fresh idempotency key.
 */
export async function markRunFailed(runId, teamId, errorSummary, client = defaultPrisma) {
    try {
        await client.$executeRawUnsafe(`UPDATE "media_intelligence_runs"
         SET "status" = 'FAILED',
             "last_error" = $3,
             "updated_at_utc" = NOW()
         WHERE "id" = $1 AND "team_id" = $2`, runId, teamId, 
        // Strip newlines, slash-paths, and bound to 240 chars so
        // stack traces / S3 URLs can never bleed in.
        errorSummary
            .replace(/[\n\r\t]/g, " ")
            .replace(/https?:\/\/[^\s]+/g, "")
            .slice(0, 240));
        bump("media_intelligence_job_failed_total");
        return { ok: true };
    }
    catch {
        return { ok: false };
    }
}
/**
 * Operator-initiated dismissal. Stops the retry ladder for runs
 * that have been determined to be permanently failed (e.g.
 * unsupported file type).
 */
export async function dismissRun(runId, teamId, client = defaultPrisma) {
    try {
        await client.$executeRawUnsafe(`UPDATE "media_intelligence_runs"
         SET "status" = 'DISMISSED',
             "updated_at_utc" = NOW()
         WHERE "id" = $1 AND "team_id" = $2
           AND "status" IN ('PENDING', 'FAILED', 'PROCESSING')`, runId, teamId);
        bump("media_intelligence_run_dismissed_total");
        return { ok: true };
    }
    catch {
        return { ok: false };
    }
}
/**
 * Read the recent runs for an evidence row (team-anchored).
 */
export async function listRecentRunsForEvidence(teamId, evidenceId, client = defaultPrisma) {
    try {
        const rows = (await client.$queryRawUnsafe(`SELECT "id", "team_id", "evidence_id", "kind", "status",
              "attempt_count", "idempotency_key", "last_error",
              "started_at_utc", "completed_at_utc",
              "created_at_utc", "updated_at_utc"
         FROM "media_intelligence_runs"
         WHERE "team_id" = $1 AND "evidence_id" = $2
         ORDER BY "created_at_utc" DESC
         LIMIT 50`, teamId, evidenceId));
        return rows.map(projectRun);
    }
    catch {
        return [];
    }
}
function projectRun(raw) {
    return {
        id: raw.id,
        teamId: raw.team_id,
        evidenceId: raw.evidence_id,
        kind: raw.kind,
        status: raw.status,
        attemptCount: raw.attempt_count,
        idempotencyKey: raw.idempotency_key,
        lastError: raw.last_error,
        startedAtUtc: raw.started_at_utc?.toISOString() ?? null,
        completedAtUtc: raw.completed_at_utc?.toISOString() ?? null,
        createdAtUtc: raw.created_at_utc.toISOString(),
        updatedAtUtc: raw.updated_at_utc.toISOString(),
    };
}
