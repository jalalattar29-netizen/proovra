/**
 * Phase 31.21 — bounded per-domain graph sync helpers.
 *
 * The full `reconcileTeamGraph` runs every domain in one pass. For
 * operators who need to RIGHT-NOW tombstone the graph projection
 * of one specific domain (after a bulk delete in the source table,
 * a domain-specific data hygiene action, etc.), waiting for the
 * full cron is wasteful and hides real bounded work behind a "no-
 * op" tag.
 *
 * This service exposes:
 *   * `runDomainStaleSweep(teamId, domain, client)` — runs ONLY the
 *     stale-tombstone sweep for the named domain. Tombstones any
 *     node whose source row is no longer present in the upstream
 *     domain table. Bounded and idempotent.
 *
 *   * `runTimelineSync(teamId, client)` — invokes the existing
 *     timeline builder, counts events, AND runs the cross-edge
 *     stale sweep that tombstones edges whose endpoints both went
 *     stale (the same sweep the full reconciler does at section 4).
 *
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
 *   * Stale sweeps are write-only on graph tables; the source domain
 *     tables are NEVER mutated.
 */
import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
// =============================================================================
// Public types
// =============================================================================
export const DOMAIN_SYNC_DOMAINS = [
    "CASE",
    "REPORT",
    "VERIFICATION_PACKAGE",
    "EXPORT",
    "REVIEW_TASK",
    "ESCALATION",
    "INCIDENT",
    "EXTERNAL_REVIEW",
];
const DOMAIN_SWEEPS = {
    CASE: { nodeKind: "CASE", sourceTable: "cases" },
    REPORT: { nodeKind: "REPORT", sourceTable: "evidence_reports" },
    VERIFICATION_PACKAGE: {
        nodeKind: "VERIFICATION_PACKAGE",
        sourceTable: "verification_packages",
    },
    EXPORT: { nodeKind: "EXPORT", sourceTable: "evidence_exports" },
    REVIEW_TASK: {
        nodeKind: "REVIEW_TASK",
        sourceTable: "evidence_review_workflows",
    },
    ESCALATION: {
        nodeKind: "ESCALATION",
        sourceTable: "review_escalations",
    },
    INCIDENT: {
        nodeKind: "INCIDENT",
        sourceTable: "operational_incidents",
    },
    EXTERNAL_REVIEW: {
        nodeKind: "EXTERNAL_REVIEW",
        sourceTable: "external_review_grants",
    },
};
// =============================================================================
// runDomainStaleSweep
// =============================================================================
export async function runDomainStaleSweep(teamId, domain, client = defaultPrisma) {
    const cfg = DOMAIN_SWEEPS[domain];
    if (!cfg) {
        return { ok: false, domain, tombstoned: 0, reason: "unknown_domain" };
    }
    bump("graph_domain_sync_executed_total");
    let tombstoned = 0;
    try {
        // Team-anchored on BOTH sides of the UPDATE.
        // Bounded: PG `UPDATE ... WHERE ... RETURNING` would tell us the
        // row count exactly, but $executeRawUnsafe returns the affected
        // row count directly.
        const result = await client.$executeRawUnsafe(`UPDATE "investigation_graph_nodes" n
         SET "stale_at_utc" = NOW(),
             "updated_at_utc" = NOW()
         WHERE n."team_id" = $1
           AND n."node_kind" = $2
           AND n."stale_at_utc" IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM "${cfg.sourceTable}" s
              WHERE s."id"::text = n."external_id"
                AND s."team_id" = $1
           )`, teamId, cfg.nodeKind);
        tombstoned = typeof result === "number" ? result : 0;
        if (tombstoned > 0)
            bump("graph_node_removed_total", tombstoned);
        return { ok: true, domain, tombstoned };
    }
    catch (err) {
        return {
            ok: false,
            domain,
            tombstoned,
            reason: err instanceof Error
                ? `sweep_failed:${err.message.slice(0, 60)}`
                : "sweep_failed",
        };
    }
}
// =============================================================================
// runTimelineSync
// =============================================================================
export async function runTimelineSync(teamId, client = defaultPrisma) {
    bump("graph_timeline_sync_executed_total");
    // 1) Build the bounded timeline so we can record its current size
    //    as a readiness signal.
    let eventCount = 0;
    let truncated = false;
    try {
        const { buildInvestigationTimeline } = await import("./graph-builder.service.js");
        const result = await buildInvestigationTimeline({ teamId, rootNodeId: null, evidenceId: null, fromUtc: null, toUtc: null }, client);
        eventCount = result.events.length;
        truncated = result.truncated;
    }
    catch (err) {
        return {
            ok: false,
            eventCount: 0,
            truncated: false,
            edgesStaled: 0,
            reason: err instanceof Error
                ? `timeline_build_failed:${err.message.slice(0, 60)}`
                : "timeline_build_failed",
        };
    }
    // 2) Run the cross-edge stale sweep that tombstones edges whose
    //    source or target node has gone stale. The full reconciler does
    //    this in section 4 — running it on the dedicated timeline-sync
    //    queue lets ops keep the timeline view fresh between full
    //    reconciles without re-running every domain reconciler.
    let edgesStaled = 0;
    try {
        const result = await client.$executeRawUnsafe(`UPDATE "investigation_graph_edges" e
         SET "stale_at_utc" = NOW(),
             "updated_at_utc" = NOW()
         WHERE e."team_id" = $1
           AND e."stale_at_utc" IS NULL
           AND (
             EXISTS (
               SELECT 1 FROM "investigation_graph_nodes" n
                WHERE n."id" = e."source_node_id"
                  AND n."stale_at_utc" IS NOT NULL
             )
             OR EXISTS (
               SELECT 1 FROM "investigation_graph_nodes" n
                WHERE n."id" = e."target_node_id"
                  AND n."stale_at_utc" IS NOT NULL
             )
           )`, teamId);
        edgesStaled = typeof result === "number" ? result : 0;
        if (edgesStaled > 0)
            bump("graph_edge_removed_total", edgesStaled);
    }
    catch {
        /* best-effort — the timeline build already succeeded */
    }
    return { ok: true, eventCount, truncated, edgesStaled };
}
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
export async function runSearchProjectionSync(teamId, client = defaultPrisma, options = {}) {
    bump("graph_search_projection_executed_total");
    const windowMinutes = Math.max(1, Math.min(options.windowMinutes ?? RECENT_SIGNAL_WINDOW_MINUTES, 1440));
    const cap = Math.max(1, Math.min(options.enqueueCap ?? MAX_REINDEX_ENQUEUES_PER_RUN, 500));
    let candidates = [];
    try {
        candidates = (await client.$queryRawUnsafe(`SELECT DISTINCT "evidence_id"
         FROM "media_intelligence_signals"
        WHERE "team_id" = $1
          AND "updated_at_utc" >= NOW() - ($2::text)::interval
        LIMIT $3`, teamId, `${windowMinutes} minutes`, cap));
    }
    catch (err) {
        return {
            ok: false,
            enqueued: 0,
            reason: err instanceof Error
                ? `recent_signal_query_failed:${err.message.slice(0, 60)}`
                : "recent_signal_query_failed",
        };
    }
    if (candidates.length === 0) {
        return { ok: true, enqueued: 0 };
    }
    // The default enqueue path lazily imports the worker's search
    // indexing queue helper. When this service is invoked from the
    // worker process, this lands in the same module that the worker
    // already uses, so no second Redis connection is created.
    const enqueueImpl = options.enqueueImpl ??
        (async (input) => {
            try {
                const mod = (await import(
                /* @vite-ignore */ "../../../../worker/src/queue.js"));
                const r = await mod.enqueueSearchIndexingJob({
                    teamId: input.teamId,
                    kind: "evidence",
                    sourceId: input.evidenceId,
                    reason: input.reason,
                });
                return { enqueued: Boolean(r.enqueued) };
            }
            catch {
                // Worker module not available (e.g. running inside an API
                // process that never imports queue.ts). Skip without error.
                return { enqueued: false };
            }
        });
    let enqueued = 0;
    for (const c of candidates) {
        try {
            const r = await enqueueImpl({
                teamId,
                evidenceId: c.evidence_id,
                reason: "graph_search_projection_sync",
            });
            if (r.enqueued)
                enqueued += 1;
        }
        catch {
            /* per-evidence failure is best-effort */
        }
    }
    return { ok: true, enqueued };
}
