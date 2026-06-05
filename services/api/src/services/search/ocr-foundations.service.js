/**
 * Phase 24-J — OCR text foundations.
 *
 * TODO(phase-repair-cleanup): ORPHAN. `recordOcrSegment` and friends
 * write to `evidence_ocr_text`, a table the live extraction pipeline
 * never populates. The canonical OCR/transcript write path is
 * `extractAndPersist` in `intelligence/extraction.service.ts`, which
 * writes to `evidence_extracted_texts` (EvidenceExtractedText). No
 * production code path imports anything from this file (audited:
 * the only callers are compiled .js mirrors and a doc-comment in
 * `deepgram-client.ts`). A follow-up wave should remove this
 * service and the `evidence_ocr_text` table.
 *
 * Schema-side foundations for indexable OCR text. This service is the
 * SINGLE mutation/read surface for `evidence_ocr_text` rows. No
 * recognition engine is wired here — those are external services
 * (Tesseract, AWS Textract, Google Document AI, …) that submit
 * already-extracted text through `recordOcrSegment`.
 *
 * Hard governance rules:
 *   - The CALLER asserts the `visibilityScope` for the OCR row. We
 *     bound it to the documented catalog ('TEAM', 'REVIEWER_RESTRICTED',
 *     'CONTRIBUTOR_PRIVATE', 'BLOCKED'). The catalog mirrors the search
 *     document visibility ladder so the indexer can consume OCR
 *     without re-deriving the scope.
 *   - The CALLER asserts whether the row is `redacted`. Redacted rows
 *     are stored but flagged for the indexer to skip.
 *   - The READ surface (`listOcrTextForEvidence`) re-checks team
 *     scope on every call. Cross-team reads are impossible.
 *   - Text is bounded by chunk_index — long documents are sharded by
 *     the engine before submission. We refuse to store individual
 *     rows larger than 64 KB to keep audit / paginated reads sane.
 *   - Forbidden-overclaim phrases (the same SEARCH catalog used by
 *     the indexer) are stripped at write time. Even if an external
 *     engine produces over-claim text, the platform never persists
 *     it.
 *   - Search consumers READ via `listIndexableOcrText` which enforces
 *     `visibility_scope = 'TEAM'` AND `redacted = false` AND lifecycle
 *     guard via the source evidence (legal hold / ON_HOLD / DESTROYED
 *     never expose OCR text).
 *
 * No Prisma model — uses `$queryRaw` against the Phase 24-J
 * `evidence_ocr_text` table. Future regeneration can add a typed model.
 */
import { SEARCH_FORBIDDEN_OVERCLAIM_PHRASES, stringContainsForbiddenOverclaim, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
// -----------------------------------------------------------------------------
// Visibility catalog
// -----------------------------------------------------------------------------
export const OCR_VISIBILITY_SCOPES = [
    "TEAM",
    "REVIEWER_RESTRICTED",
    "CONTRIBUTOR_PRIVATE",
    "BLOCKED",
];
const OCR_VISIBILITY_SCOPE_SET = new Set(OCR_VISIBILITY_SCOPES);
// -----------------------------------------------------------------------------
// Bounded length
// -----------------------------------------------------------------------------
const MAX_TEXT_CHARS = 64 * 1024;
function projectRow(raw) {
    return {
        id: raw.id,
        teamId: raw.team_id,
        evidenceId: raw.evidence_id,
        partId: raw.part_id,
        chunkIndex: raw.chunk_index,
        engine: raw.engine,
        languageHint: raw.language_hint,
        text: raw.text,
        confidence: raw.confidence,
        visibilityScope: raw.visibility_scope,
        redacted: raw.redacted,
        indexedAtUtc: raw.indexed_at_utc?.toISOString() ?? null,
        extractedAtUtc: raw.extracted_at_utc.toISOString(),
    };
}
// -----------------------------------------------------------------------------
// Forbidden-overclaim scrubber
// -----------------------------------------------------------------------------
function scrubOverclaim(text) {
    if (!stringContainsForbiddenOverclaim(text)) {
        return { safe: text, scrubbed: false };
    }
    let cleaned = text;
    for (const phrase of SEARCH_FORBIDDEN_OVERCLAIM_PHRASES) {
        const re = new RegExp(phrase, "gi");
        cleaned = cleaned.replace(re, "[redacted]");
    }
    return { safe: cleaned, scrubbed: true };
}
// -----------------------------------------------------------------------------
// Write
// -----------------------------------------------------------------------------
export async function recordOcrSegment(input, client = defaultPrisma) {
    if (!OCR_VISIBILITY_SCOPE_SET.has(input.visibilityScope)) {
        return { ok: false, reason: "visibility_scope_invalid" };
    }
    if (!input.text || input.text.length === 0) {
        return { ok: false, reason: "empty_text" };
    }
    if (input.text.length > MAX_TEXT_CHARS) {
        return { ok: false, reason: "text_exceeds_chunk_bound" };
    }
    if (input.chunkIndex < 0 || !Number.isInteger(input.chunkIndex)) {
        return { ok: false, reason: "chunk_index_invalid" };
    }
    if (input.confidence !== null &&
        (input.confidence < 0 || input.confidence > 1)) {
        return { ok: false, reason: "confidence_out_of_range" };
    }
    // Forbidden-overclaim scrub. If the engine produced over-claim
    // wording, we redact it AND mark the row as redacted so the indexer
    // skips it.
    const { safe, scrubbed } = scrubOverclaim(input.text);
    const redacted = input.redacted || scrubbed;
    try {
        const rows = (await client.$queryRawUnsafe(`INSERT INTO "evidence_ocr_text" (
         "team_id", "evidence_id", "part_id", "chunk_index", "engine",
         "language_hint", "text", "confidence", "visibility_scope",
         "redacted"
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (
         "evidence_id",
         COALESCE("part_id", '00000000-0000-0000-0000-000000000000'),
         "chunk_index"
       ) DO UPDATE SET
         "text" = EXCLUDED."text",
         "confidence" = EXCLUDED."confidence",
         "visibility_scope" = EXCLUDED."visibility_scope",
         "redacted" = EXCLUDED."redacted",
         "engine" = EXCLUDED."engine",
         "language_hint" = EXCLUDED."language_hint",
         "updated_at_utc" = NOW(),
         "indexed_at_utc" = NULL
       RETURNING "id"`, input.teamId, input.evidenceId, input.partId, input.chunkIndex, input.engine.slice(0, 40), input.languageHint ? input.languageHint.slice(0, 16) : null, safe, input.confidence, input.visibilityScope, redacted));
        const id = rows[0]?.id;
        if (!id) {
            return { ok: false, reason: "upsert_returned_no_id" };
        }
        bump("search_ocr_text_recorded_total");
        if (scrubbed) {
            safeEmitSecurityEvent({
                teamId: input.teamId,
                eventType: "search_ocr_text_redacted",
                severity: "INFO",
                details: { evidenceId: input.evidenceId, chunkIndex: input.chunkIndex },
            });
        }
        return { ok: true, id };
    }
    catch (err) {
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "search_ocr_text_indexing_failed",
            severity: "WARNING",
            details: {
                reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
            },
        });
        return { ok: false, reason: "db_write_failed" };
    }
}
// -----------------------------------------------------------------------------
// Read — operator-facing
// -----------------------------------------------------------------------------
export async function listOcrTextForEvidence(input, client = defaultPrisma) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
    const raw = (await client.$queryRawUnsafe(`SELECT "id", "team_id", "evidence_id", "part_id", "chunk_index",
            "engine", "language_hint", "text", "confidence",
            "visibility_scope", "redacted", "indexed_at_utc",
            "extracted_at_utc"
       FROM "evidence_ocr_text"
       WHERE "team_id" = $1
         AND "evidence_id" = $2
       ORDER BY "part_id" NULLS FIRST, "chunk_index" ASC
       LIMIT $3`, input.teamId, input.evidenceId, limit));
    return raw.map(projectRow);
}
export async function listIndexableOcrText(input, client = defaultPrisma) {
    if (!input.sourceEvidenceIsIndexable) {
        bump("search_fail_closed_engaged_total");
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "search_fail_closed_engaged",
            severity: "INFO",
            details: {
                evidenceId: input.evidenceId,
                reason: "source_not_indexable",
                surface: "ocr",
            },
        });
        return [];
    }
    const raw = (await client.$queryRawUnsafe(`SELECT "text"
       FROM "evidence_ocr_text"
       WHERE "team_id" = $1
         AND "evidence_id" = $2
         AND "visibility_scope" = 'TEAM'
         AND "redacted" = FALSE
       ORDER BY "part_id" NULLS FIRST, "chunk_index" ASC`, input.teamId, input.evidenceId));
    return raw.map((r) => r.text);
}
// -----------------------------------------------------------------------------
// Indexing lag — supports the readiness probe
// -----------------------------------------------------------------------------
export async function getOcrIndexingLagSeconds(teamId, client = defaultPrisma) {
    const raw = (await client.$queryRawUnsafe(`SELECT EXTRACT(EPOCH FROM (NOW() - MIN("extracted_at_utc"))) AS lag_seconds
       FROM "evidence_ocr_text"
       WHERE "team_id" = $1
         AND "indexed_at_utc" IS NULL`, teamId));
    const lag = raw[0]?.lag_seconds;
    if (lag === null || lag === undefined)
        return null;
    const n = Number(lag);
    return Number.isFinite(n) ? n : null;
}
