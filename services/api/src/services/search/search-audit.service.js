/**
 * Phase 24-J — Search Discovery audit log.
 *
 * Operator-facing audit log for every Enterprise Search / Discovery
 * query. Phase 24 base already emits SecurityEvents on every search;
 * this service writes a dedicated, queryable, paginated audit row so
 * compliance can answer the question "who searched for what when, and
 * how many results did the fail-closed gate suppress?" without
 * walking the global SecurityEvent stream.
 *
 * Hard contracts:
 *   - Raw query text is NEVER stored. Only a SHA-256 prefix.
 *   - Workspace-scoped reads only. Cross-workspace lookups would be a
 *     governance leak.
 *   - All writes are best-effort: a failed write bumps the metric +
 *     emits a SecurityEvent but never throws to the calling search
 *     handler (we never block discovery on the audit-log write).
 *   - Uses `$queryRaw` against the `search_audit_logs` table created
 *     in the Phase 24-J drift patch — Prisma model addition can come
 *     in a follow-up regeneration.
 */
import { createHash } from "node:crypto";
import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
const SURFACE_MAX_LEN = 24;
const QUERY_HASH_LEN = 64;
const QUERY_PREFIX_HASH_LEN = 16;
function hashSha256Hex(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}
function hashQuery(text) {
    const trimmed = text.trim().toLowerCase().slice(0, 4000);
    const hash = hashSha256Hex(trimmed).slice(0, QUERY_PREFIX_HASH_LEN);
    return { hash, length: text.length };
}
function hashIp(ip) {
    // Truncate the hash to 16 chars so the audit log never enables IP
    // identification — only correlation across rows from the same IP.
    return hashSha256Hex(ip).slice(0, 16);
}
function clampSurface(surface) {
    if (surface.length <= SURFACE_MAX_LEN)
        return surface;
    return surface.slice(0, SURFACE_MAX_LEN);
}
// -----------------------------------------------------------------------------
// Write
// -----------------------------------------------------------------------------
/**
 * Record a single Discovery / Enterprise Search execution. Best-effort
 * — never throws to the calling search handler. The compliance audit
 * pipeline tolerates a missed write (the SecurityEvent stream is the
 * authoritative backup).
 */
export async function recordSearchAudit(input, client = defaultPrisma) {
    try {
        let queryHash = null;
        let queryLength = 0;
        if (input.queryText) {
            const h = hashQuery(input.queryText);
            queryHash = h.hash;
            queryLength = h.length;
        }
        const ipHash = input.ipAddress ? hashIp(input.ipAddress) : null;
        const surface = clampSurface(input.surface);
        // Bounded JSONB payloads — clip to prevent gargantuan rows from a
        // pathological caller.
        const documentTypesJson = input.documentTypes
            ? JSON.stringify(input.documentTypes.slice(0, 40))
            : null;
        const filtersJson = input.filters
            ? JSON.stringify(input.filters).slice(0, 4000)
            : null;
        await client.$executeRawUnsafe(`INSERT INTO "search_audit_logs" (
         "team_id", "actor_user_id", "surface", "query_hash",
         "query_length", "document_types", "filters_json",
         "result_count", "filtered_governance_count",
         "filtered_visibility_count", "fail_closed", "request_id", "ip_hash"
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13)`, input.teamId, input.actorUserId, surface, queryHash, queryLength, documentTypesJson, filtersJson, Math.max(0, Math.floor(input.resultCount)), Math.max(0, Math.floor(input.filteredGovernanceCount)), Math.max(0, Math.floor(input.filteredVisibilityCount)), input.failClosed, input.requestId ?? null, ipHash);
        bump("search_audit_log_written_total");
    }
    catch (err) {
        bump("search_audit_log_write_failed_total");
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "search_audit_log_write_failed",
            severity: "WARNING",
            details: {
                reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
            },
        });
    }
}
function projectRow(raw) {
    return {
        id: raw.id,
        teamId: raw.team_id,
        actorUserId: raw.actor_user_id,
        surface: raw.surface,
        queryHash: raw.query_hash,
        queryLength: raw.query_length,
        documentTypes: Array.isArray(raw.document_types)
            ? raw.document_types
            : null,
        filters: raw.filters_json && typeof raw.filters_json === "object"
            ? raw.filters_json
            : null,
        resultCount: raw.result_count,
        filteredGovernanceCount: raw.filtered_governance_count,
        filteredVisibilityCount: raw.filtered_visibility_count,
        failClosed: raw.fail_closed,
        requestId: raw.request_id,
        occurredAtUtc: raw.occurred_at_utc.toISOString(),
    };
}
export async function listSearchAudit(input, client = defaultPrisma) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const overscan = limit + 1;
    // Build the parameterised query. Every parameter is bound — no
    // string interpolation anywhere near the SQL.
    const filterClauses = [`"team_id" = $1`];
    const params = [input.teamId];
    if (input.actorUserId) {
        params.push(input.actorUserId);
        filterClauses.push(`"actor_user_id" = $${params.length}`);
    }
    if (input.failClosedOnly) {
        filterClauses.push(`"fail_closed" = TRUE`);
    }
    if (input.beforeUtc) {
        params.push(new Date(input.beforeUtc));
        filterClauses.push(`"occurred_at_utc" < $${params.length}`);
    }
    params.push(overscan);
    const limitParam = `$${params.length}`;
    // Note: `query_hash`, `query_length`, … never include the raw text.
    const sql = `SELECT "id", "team_id", "actor_user_id", "surface",
       "query_hash", "query_length", "document_types", "filters_json",
       "result_count", "filtered_governance_count",
       "filtered_visibility_count", "fail_closed", "request_id",
       "occurred_at_utc"
     FROM "search_audit_logs"
     WHERE ${filterClauses.join(" AND ")}
     ORDER BY "occurred_at_utc" DESC, "id" DESC
     LIMIT ${limitParam}`;
    let raw;
    try {
        raw = (await client.$queryRawUnsafe(sql, ...params));
    }
    catch (err) {
        bump("search_audit_log_read_failed_total");
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "search_audit_log_read_failed",
            severity: "WARNING",
            details: {
                reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
            },
        });
        return { rows: [], nextBeforeUtc: null };
    }
    const hasMore = raw.length > limit;
    if (hasMore)
        raw.pop();
    const rows = raw.map(projectRow);
    const nextBeforeUtc = hasMore && rows.length > 0
        ? rows[rows.length - 1].occurredAtUtc
        : null;
    return { rows, nextBeforeUtc };
}
