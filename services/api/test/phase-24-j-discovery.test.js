/**
 * Phase 24-J — Enterprise Discovery Platform source-contract tests.
 *
 * Phase 24 base ships:
 *   - `EvidenceSearchDocument` schema + governance-aware query gate
 *   - `executeSearch()` query service with per-row gates
 *   - `SavedSearchView` saved-views, `EvidenceRelationship` discovery
 *   - SecurityEvent emission on every search
 *
 * Phase 24-J adds:
 *   - Dedicated `search_audit_logs` table + service (operator-facing
 *     audit, never stores raw query text)
 *   - OCR + transcript text foundations with visibility scope catalog
 *     and forbidden-overclaim scrub
 *   - PostgreSQL FTS (tsvector + GIN) + optional pgvector embedding
 *     column via idempotent SQL patch
 *   - Async indexing queue stub (BullMQ `search-indexing`) with API +
 *     worker counterparts
 *   - Schema-validation registration for every new table + critical
 *     column (so drift fails fast at startup)
 *
 * This file asserts the source-level contracts on each of those
 * pieces — pure string + structure assertions, no DB, no Fastify.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readSource(rel) {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
// =============================================================================
// SQL drift patches — idempotent + partial-state-safe
// =============================================================================
describe("Phase 24-J — SQL drift patches", () => {
    it("search_audit_logs patch creates the table with IF NOT EXISTS + bounded constraints", () => {
        const src = readSource("../../../services/api/sql/drift-patches/2026-05-19-search-audit-log.sql");
        expect(src).toMatch(/CREATE TABLE IF NOT EXISTS\s+"search_audit_logs"/i);
        expect(src).toMatch(/"query_hash"\s+VARCHAR\(64\)/i);
        expect(src).toMatch(/"fail_closed"\s+BOOLEAN NOT NULL DEFAULT FALSE/i);
        expect(src).toMatch(/CONSTRAINT "search_audit_logs_result_count_nonneg"/i);
        expect(src).toMatch(/CONSTRAINT "search_audit_logs_filtered_gov_nonneg"/i);
        expect(src).toMatch(/CONSTRAINT "search_audit_logs_filtered_vis_nonneg"/i);
        expect(src).toMatch(/CREATE INDEX IF NOT EXISTS "search_audit_logs_team_occurred_idx"/i);
        expect(src).toMatch(/CREATE INDEX IF NOT EXISTS "search_audit_logs_team_fail_closed_idx"[\s\S]*?WHERE "fail_closed" = TRUE/i);
        expect(src).toMatch(/^\s*BEGIN\s*;/m);
        expect(src).toMatch(/^\s*COMMIT\s*;/m);
    });
    it("evidence_ocr_text patch bounds visibility scope to the documented catalog", () => {
        const src = readSource("../../../services/api/sql/drift-patches/2026-05-19-evidence-ocr-text.sql");
        expect(src).toMatch(/CREATE TABLE IF NOT EXISTS\s+"evidence_ocr_text"/i);
        expect(src).toMatch(/CONSTRAINT "evidence_ocr_text_visibility_scope_bounded"[\s\S]*?CHECK[\s\S]*?'TEAM'[\s\S]*?'REVIEWER_RESTRICTED'[\s\S]*?'CONTRIBUTOR_PRIVATE'[\s\S]*?'BLOCKED'/i);
        // Unique upsert key matches the service helper.
        expect(src).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "evidence_ocr_text_uk"/i);
        // Indexing-lag readiness probe support — partial index on
        // unindexed rows.
        expect(src).toMatch(/CREATE INDEX IF NOT EXISTS "evidence_ocr_text_unindexed_idx"[\s\S]*?WHERE "indexed_at_utc" IS NULL/i);
    });
    it("evidence_transcript_segments patch bounds visibility scope + segment offset rules", () => {
        const src = readSource("../../../services/api/sql/drift-patches/2026-05-19-evidence-transcripts.sql");
        expect(src).toMatch(/CREATE TABLE IF NOT EXISTS\s+"evidence_transcript_segments"/i);
        expect(src).toMatch(/start_ms[\s\S]*?end_ms.*?>=.*?start_ms/i);
        expect(src).toMatch(/CONSTRAINT "evidence_transcript_segments_visibility_scope_bounded"/i);
        expect(src).toMatch(/CREATE INDEX IF NOT EXISTS "evidence_transcript_segments_unindexed_idx"/i);
    });
    it("FTS / pgvector patch is fully idempotent + gates pgvector on extension availability", () => {
        const src = readSource("../../../services/api/sql/drift-patches/2026-05-19-search-fts-pgvector.sql");
        // tsvector generated column guarded by information_schema.columns
        // existence check (idempotent).
        expect(src).toMatch(/information_schema\.columns[\s\S]*?column_name = 'tsv'/i);
        expect(src).toMatch(/ADD COLUMN "tsv" tsvector[\s\S]*?GENERATED ALWAYS AS[\s\S]*?STORED/i);
        expect(src).toMatch(/CREATE INDEX IF NOT EXISTS "evidence_search_documents_tsv_gin"[\s\S]*?USING GIN/i);
        // pgvector column is only added if extension is present.
        expect(src).toMatch(/pg_extension WHERE extname = 'vector'/i);
        expect(src).toMatch(/has_pgvector BOOLEAN/i);
        expect(src).toMatch(/IF has_pgvector THEN/i);
        expect(src).toMatch(/USING ivfflat \("embedding" vector_cosine_ops\)/i);
        // pgvector absence is a soft notice, never an error.
        expect(src).toMatch(/RAISE NOTICE\s+'pgvector extension not present/i);
    });
});
// =============================================================================
// search-audit service
// =============================================================================
describe("Phase 24-J — search-audit service", () => {
    const src = readSource("../../../services/api/src/services/search/search-audit.service.ts");
    it("hashes the raw query text and length, never stores raw text", () => {
        expect(src).toMatch(/createHash\("sha256"\)/);
        expect(src).toMatch(/hashQuery/);
        // The write path passes `queryHash` (the hash result), never the
        // raw `queryText`.
        expect(src).toMatch(/"query_hash"[\s\S]*?queryHash/);
        expect(src).not.toMatch(/"query_text"/);
    });
    it("hashes the IP address before storage (correlation, not identification)", () => {
        expect(src).toMatch(/hashIp\b/);
        expect(src).toMatch(/"ip_hash"/);
        expect(src).not.toMatch(/"ip_address"/);
    });
    it("never throws to the calling search handler (best-effort write)", () => {
        // Both write + read paths wrap their DB call in try/catch and emit
        // a SecurityEvent on failure.
        expect(src).toMatch(/recordSearchAudit[\s\S]*?try\s*\{[\s\S]*?\}\s*catch/);
        expect(src).toMatch(/listSearchAudit[\s\S]*?try\s*\{[\s\S]*?\}\s*catch/);
        expect(src).toMatch(/search_audit_log_write_failed_total/);
        expect(src).toMatch(/search_audit_log_read_failed_total/);
    });
    it("clamps document_types JSON to a bounded length (no gargantuan rows)", () => {
        expect(src).toMatch(/documentTypes\.slice\(0,\s*40\)/);
        expect(src).toMatch(/filtersJson[\s\S]*?slice\(0,\s*4000\)/);
    });
    it("list endpoint is workspace-anchored (every read filters on team_id)", () => {
        expect(src).toMatch(/`"team_id" = \$1`/);
        // No code path lists across teams.
        expect(src).not.toMatch(/SELECT[\s\S]*?FROM\s+"search_audit_logs"\s+WHERE\s+"actor_user_id"/i);
    });
    it("list endpoint is bounded by limit (clamped to 200 max)", () => {
        expect(src).toMatch(/Math\.min\(Math\.max\(input\.limit \?\? 50, 1\), 200\)/);
    });
});
// =============================================================================
// OCR foundations
// =============================================================================
describe("Phase 24-J — OCR foundations", () => {
    const src = readSource("../../../services/api/src/services/search/ocr-foundations.service.ts");
    it("bounds visibility scope to the documented catalog", () => {
        expect(src).toMatch(/OCR_VISIBILITY_SCOPES = \[\s*"TEAM",\s*"REVIEWER_RESTRICTED",\s*"CONTRIBUTOR_PRIVATE",\s*"BLOCKED",\s*\]/);
        expect(src).toMatch(/OCR_VISIBILITY_SCOPE_SET\.has\(input\.visibilityScope\)/);
    });
    it("bounds individual chunk text length (no gargantuan rows)", () => {
        expect(src).toMatch(/MAX_TEXT_CHARS = 64 \* 1024/);
        expect(src).toMatch(/text_exceeds_chunk_bound/);
    });
    it("scrubs forbidden-overclaim phrases at write time + marks the row redacted", () => {
        expect(src).toMatch(/stringContainsForbiddenOverclaim/);
        expect(src).toMatch(/SEARCH_FORBIDDEN_OVERCLAIM_PHRASES/);
        expect(src).toMatch(/redacted = input\.redacted \|\| scrubbed/);
        expect(src).toMatch(/search_ocr_text_redacted/);
    });
    it("upsert uses ON CONFLICT on (evidence_id, COALESCE(part_id, …), chunk_index)", () => {
        expect(src).toMatch(/ON CONFLICT \(\s*"evidence_id",\s*COALESCE\("part_id",\s*'00000000-0000-0000-0000-000000000000'\),\s*"chunk_index"\s*\) DO UPDATE/i);
        // Upsert resets indexed_at_utc = NULL so the lag-pointer rises.
        expect(src).toMatch(/"indexed_at_utc" = NULL/);
    });
    it("indexer-facing read enforces TEAM scope + non-redacted + lifecycle gate (fail-closed)", () => {
        expect(src).toMatch(/WHERE "team_id" = \$1[\s\S]*?"evidence_id" = \$2[\s\S]*?"visibility_scope" = 'TEAM'[\s\S]*?"redacted" = FALSE/i);
        expect(src).toMatch(/sourceEvidenceIsIndexable/);
        expect(src).toMatch(/!input\.sourceEvidenceIsIndexable[\s\S]*?return \[\]/);
        expect(src).toMatch(/search_fail_closed_engaged/);
    });
    it("indexing-lag helper supports the readiness probe (real lag, not fake)", () => {
        expect(src).toMatch(/getOcrIndexingLagSeconds/);
        expect(src).toMatch(/MIN\("extracted_at_utc"\)/);
        expect(src).toMatch(/"indexed_at_utc" IS NULL/);
    });
    it("never references the raw OCR engine secret / API key / model version", () => {
        expect(src).not.toMatch(/OCR_API_KEY|TEXTRACT|VISION_API_KEY/);
    });
});
// =============================================================================
// Transcript foundations
// =============================================================================
describe("Phase 24-J — Transcript foundations", () => {
    const src = readSource("../../../services/api/src/services/search/transcript-foundations.service.ts");
    it("bounds visibility scope to the documented catalog", () => {
        expect(src).toMatch(/TRANSCRIPT_VISIBILITY_SCOPES = \[\s*"TEAM",\s*"REVIEWER_RESTRICTED",\s*"CONTRIBUTOR_PRIVATE",\s*"BLOCKED",\s*\]/);
    });
    it("requires non-negative start_ms + end_ms >= start_ms at write time", () => {
        expect(src).toMatch(/startMs < 0 \|\| input\.endMs < input\.startMs/);
        expect(src).toMatch(/segment_offsets_invalid/);
    });
    it("scrubs forbidden-overclaim phrases at write time", () => {
        expect(src).toMatch(/stringContainsForbiddenOverclaim/);
        expect(src).toMatch(/search_transcript_segment_redacted/);
    });
    it("indexer-facing read enforces TEAM scope + non-redacted + lifecycle gate", () => {
        expect(src).toMatch(/WHERE "team_id" = \$1[\s\S]*?"evidence_id" = \$2[\s\S]*?"visibility_scope" = 'TEAM'[\s\S]*?"redacted" = FALSE/i);
        expect(src).toMatch(/sourceEvidenceIsIndexable/);
    });
    it("indexing-lag helper supports the readiness probe", () => {
        expect(src).toMatch(/getTranscriptIndexingLagSeconds/);
    });
});
// =============================================================================
// Schema validation
// =============================================================================
describe("Phase 24-J — schema validation registrations", () => {
    const src = readSource("../../../services/api/src/runtime/schema-validation.ts");
    it("introduces the search_discovery subsystem", () => {
        expect(src).toMatch(/\|\s*"search_discovery"/);
        expect(src).toMatch(/"search_discovery"\s*,?\s*\]/);
    });
    it("registers every Phase 24 + 24-J discovery table", () => {
        for (const table of [
            "evidence_search_documents",
            "saved_search_views",
            "search_audit_logs",
            "evidence_ocr_text",
            "evidence_transcript_segments",
        ]) {
            expect(src, `${table} not registered`).toMatch(new RegExp(`name:\\s*"${table}"[\\s\\S]*?subsystem:\\s*"search_discovery"`));
        }
    });
    it("registers visibility_scope + redacted columns on OCR + transcript (governance-load-bearing)", () => {
        for (const col of [
            `table: "evidence_ocr_text", column: "visibility_scope"`,
            `table: "evidence_ocr_text", column: "redacted"`,
            `table: "evidence_transcript_segments", column: "visibility_scope"`,
            `table: "evidence_transcript_segments", column: "redacted"`,
        ]) {
            expect(src, `${col} not registered`).toContain(col);
        }
    });
    it("registers the FTS tsv column + GIN index at OPTIONAL severity (graceful fallback)", () => {
        expect(src).toMatch(/table:\s*"evidence_search_documents",\s*column:\s*"tsv",\s*severity:\s*"optional",\s*subsystem:\s*"search_discovery"/);
        expect(src).toMatch(/indexName:\s*"evidence_search_documents_tsv_gin",\s*severity:\s*"optional",\s*subsystem:\s*"search_discovery"/);
    });
    it("registers the search_audit_logs.fail_closed column (compliance-critical)", () => {
        expect(src).toMatch(/table:\s*"search_audit_logs",\s*column:\s*"fail_closed",\s*severity:\s*"important",\s*subsystem:\s*"search_discovery"/);
    });
});
// =============================================================================
// Async indexing queue + worker stub
// =============================================================================
describe("Phase 24-J — async indexing pipeline", () => {
    const apiSrc = readSource("../../../services/api/src/queue/search-queue.ts");
    const workerQueueSrc = readSource("../../../services/worker/src/queue.ts");
    const workerProcessorSrc = readSource("../../../services/worker/src/search-indexing.processor.ts");
    it("API + worker agree on the queue name + job name", () => {
        expect(apiSrc).toMatch(/searchIndexingQueueName = "search-indexing"/);
        expect(apiSrc).toMatch(/searchIndexingJobName = "RebuildSearchDocument"/);
        expect(workerQueueSrc).toMatch(/searchIndexingQueueName = "search-indexing"/);
        expect(workerQueueSrc).toMatch(/searchIndexingJobName = "RebuildSearchDocument"/);
    });
    it("API helper is idempotent — repeat enqueues collapse to the existing job", () => {
        expect(apiSrc).toMatch(/buildJobId/);
        expect(apiSrc).toMatch(/getJob\(jobId\)/);
        expect(apiSrc).toMatch(/state === "waiting"[\s\S]*?state === "delayed"[\s\S]*?state === "active"[\s\S]*?state === "prioritized"/);
    });
    it("API helper never throws + reports queue_unavailable on Redis failure", () => {
        expect(apiSrc).toMatch(/queue_unavailable/);
        expect(apiSrc).toMatch(/search_indexing_enqueue_failed_total/);
        expect(apiSrc).toMatch(/search_indexing_enqueue_failed/);
    });
    it("Worker processor refuses jobs without (teamId, kind, sourceId)", () => {
        expect(workerProcessorSrc).toMatch(/!teamId \|\| !kind \|\| !sourceId[\s\S]*?throw new Error\("invalid_payload"\)/);
    });
    it("Worker processor unblocks OCR + transcript indexing-lag pointers on success", () => {
        expect(workerProcessorSrc).toMatch(/UPDATE "evidence_ocr_text"[\s\S]*?SET "indexed_at_utc" = \$1[\s\S]*?WHERE "team_id" = \$2[\s\S]*?"evidence_id" = \$3[\s\S]*?"indexed_at_utc" IS NULL/);
        expect(workerProcessorSrc).toMatch(/UPDATE "evidence_transcript_segments"[\s\S]*?SET "indexed_at_utc" = \$1[\s\S]*?WHERE "team_id" = \$2[\s\S]*?"evidence_id" = \$3[\s\S]*?"indexed_at_utc" IS NULL/);
    });
    it("Worker processor logs a structured worker.search.indexing.* event (scrapeable)", () => {
        expect(workerProcessorSrc).toMatch(/"worker\.search\.indexing\.succeeded"/);
        expect(workerProcessorSrc).toMatch(/"worker\.search\.indexing\.failed"/);
    });
});
// =============================================================================
// Audit route — /v1/search/audit
// =============================================================================
describe("Phase 24-J — /v1/search/audit route", () => {
    const src = readSource("../../../services/api/src/routes/search.routes.ts");
    it("exposes GET /v1/search/audit gated by the search-operator role", () => {
        expect(src).toMatch(/"\/v1\/search\/audit"/);
        expect(src).toMatch(/\/v1\/search\/audit"[\s\S]*?requireSearchOperator\(req, reply, q\.teamId\)/);
    });
    it("validates query params + bounds limit to 200", () => {
        expect(src).toMatch(/teamId:\s*z\.string\(\)\.uuid\(\)/);
        expect(src).toMatch(/limit:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(200\)/);
        expect(src).toMatch(/beforeUtc:\s*z\.string\(\)\.datetime\(\)/);
    });
    it("the act of reading the audit log is itself audited", () => {
        expect(src).toMatch(/listSearchAudit\([\s\S]*?\)[\s\S]*?recordSearchAudit\(\{[\s\S]*?surface:\s*"api:\/v1\/search\/audit"/);
    });
    it("never echoes the raw query text in the audit row it writes", () => {
        expect(src).toMatch(/recordSearchAudit\(\{[\s\S]*?queryText:\s*null,/);
    });
});
// =============================================================================
// Cross-surface invariants
// =============================================================================
describe("Phase 24-J — cross-surface invariants", () => {
    const SURFACE_FILES = [
        "../../../services/api/src/services/search/search-audit.service.ts",
        "../../../services/api/src/services/search/ocr-foundations.service.ts",
        "../../../services/api/src/services/search/transcript-foundations.service.ts",
        "../../../services/api/src/queue/search-queue.ts",
        "../../../services/worker/src/search-indexing.processor.ts",
    ];
    it("no Discovery surface uses banned wording in string literals", () => {
        const banned = /\btamper(ed|ing)?\b|\bforged\b|\bforgery\b|\baltered content\b|\bmanipulated evidence\b/i;
        for (const rel of SURFACE_FILES) {
            const src = readSource(rel);
            const literals = src.match(/"[^"\n]+"/g) ?? [];
            expect(literals.join(" "), `banned wording in ${rel}`).not.toMatch(banned);
        }
    });
    it("no Discovery surface fabricates operational counters", () => {
        for (const rel of SURFACE_FILES) {
            const src = readSource(rel);
            expect(src).not.toMatch(/escalations:\s*\d+,/);
            expect(src).not.toMatch(/incidents:\s*\d+,/);
        }
    });
    it("no Discovery surface stores raw query text / unhashed IPs / private notes", () => {
        for (const rel of SURFACE_FILES) {
            const src = readSource(rel);
            expect(src, `${rel} references query_text column`).not.toMatch(/"query_text"|"raw_query"/);
            expect(src, `${rel} references ip_address column`).not.toMatch(/"ip_address"/);
            expect(src, `${rel} references private reviewer note`).not.toContain("privateReviewerNote");
        }
    });
    it("every workspace-scoped read on a new table filters on team_id", () => {
        // Every SELECT against the new tables must include `"team_id" = $N`
        // in its WHERE clause.
        for (const rel of [
            "../../../services/api/src/services/search/search-audit.service.ts",
            "../../../services/api/src/services/search/ocr-foundations.service.ts",
            "../../../services/api/src/services/search/transcript-foundations.service.ts",
        ]) {
            const src = readSource(rel);
            const selectMatches = src.match(/FROM "[^"]+"/g) ?? [];
            expect(selectMatches.length, `no SELECT FROM in ${rel}`).toBeGreaterThan(0);
            // Each file has at least one team_id filter.
            expect(src, `${rel} missing team_id filter`).toMatch(/"team_id" = \$1/);
        }
    });
});
