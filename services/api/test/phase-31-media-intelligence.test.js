/**
 * Phase 31 — Media intelligence advisory layer tests.
 *
 * Seven layers of coverage:
 *
 *   1. **SQL drift patch** — bounded CHECK constraints match the
 *      service-layer catalog exactly; idempotent shape.
 *
 *   2. **Bounded catalogs** — every signal type, severity,
 *      confidence, and status is exhaustively registered + cased.
 *
 *   3. **Safe-wording library** — every `safeSummary()` output is
 *      free of forbidden wording ("tampered", "forged", "fake",
 *      "authentic", "manipulated", "admissible", "proves",
 *      "confirms"). This is the legal contract.
 *
 *   4. **Pure heuristics behavioral** — `detectMimeExtensionMismatch`,
 *      `isScreenshotLikeFilename`, `computeClientServerGapSeconds`
 *      against full true/false matrices.
 *
 *   5. **Analyzer source contract** — never mutates evidence,
 *      never claims truth, never blocks the lifecycle on failure,
 *      never throws, always team-anchored.
 *
 *   6. **Route source contract** — anti-enumeration, bounded
 *      projection, authorizeOrFail gating.
 *
 *   7. **Observability** — 4 new analyzer counters + reserved
 *      catalog entries + runtime subsystem registered.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MEDIA_INTELLIGENCE_CONFIDENCES, MEDIA_INTELLIGENCE_SEVERITIES, MEDIA_INTELLIGENCE_SIGNAL_TYPES, MEDIA_INTELLIGENCE_STATUSES, SIGNAL_METADATA, safeSummary, } from "../src/services/media-intelligence/signal-catalog.js";
import { computeClientServerGapSeconds, detectMimeExtensionMismatch, isScreenshotLikeFilename, } from "../src/services/media-intelligence/analyzer.service.js";
function readSource(rel) {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
// =============================================================================
// PART 1 — SQL drift patch
// =============================================================================
describe("Phase 31 — media intelligence SQL drift patch", () => {
    const sql = readSource("../../../services/api/sql/drift-patches/2026-05-20-media-intelligence-signals.sql");
    it("BEGIN/COMMIT for partial-state safety", () => {
        expect(sql).toMatch(/^\s*BEGIN\s*;/m);
        expect(sql).toMatch(/^\s*COMMIT\s*;/m);
    });
    it("CREATE TABLE IF NOT EXISTS (idempotent)", () => {
        expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS\s+"media_intelligence_signals"/);
    });
    it("signal_type CHECK constraint enumerates every catalog value (across all drift patches)", () => {
        // Catalog values may be added by later patches via ALTER TABLE
        // DROP/ADD CONSTRAINT. The check is satisfied as long as SOME
        // drift patch in the directory contains the catalog value.
        // Phase 31.8 added `DEVICE_METADATA_OBSERVATION` via the
        // evidence-part-exif-summaries patch.
        // Phase 31.20 added `OCR_INDEXED` and `TRANSCRIPT_INDEXED` via
        // the ocr-transcript-indexed-signals patch.
        const exifPatch = readSource("../../../services/api/sql/drift-patches/2026-05-20-evidence-part-exif-summaries.sql");
        const indexedPatch = readSource("../../../services/api/sql/drift-patches/2026-05-20-ocr-transcript-indexed-signals.sql");
        const combined = sql + "\n" + exifPatch + "\n" + indexedPatch;
        for (const type of MEDIA_INTELLIGENCE_SIGNAL_TYPES) {
            expect(combined, `signal_type ${type} missing from any drift patch`).toMatch(new RegExp(`'${type}'`));
        }
    });
    it("severity vocabulary is INFO / REVIEW_RECOMMENDED / ATTENTION (no WARNING/CRITICAL/ALERT)", () => {
        expect(sql).toMatch(/CHECK \("severity" IN \('INFO', 'REVIEW_RECOMMENDED', 'ATTENTION'\)\)/);
        // Defensive — these alarmist labels never appear.
        expect(sql).not.toMatch(/'WARNING'/);
        expect(sql).not.toMatch(/'CRITICAL'/);
        expect(sql).not.toMatch(/'ALERT'/);
    });
    it("confidence bounded to LOW / MEDIUM / HIGH", () => {
        expect(sql).toMatch(/CHECK \("confidence" IN \('LOW', 'MEDIUM', 'HIGH'\)\)/);
    });
    it("status bounded to PENDING / ACKNOWLEDGED / DISMISSED (no 'CONFIRMED' / 'PROVEN')", () => {
        expect(sql).toMatch(/CHECK \("status" IN \('PENDING', 'ACKNOWLEDGED', 'DISMISSED'\)\)/);
        expect(sql).not.toMatch(/'CONFIRMED'/);
        expect(sql).not.toMatch(/'PROVEN'/);
    });
    it("unique index on (evidence_id, COALESCE(material_id, sentinel), signal_type) for idempotent upsert", () => {
        expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "media_intelligence_signals_evidence_material_type_uk"[\s\S]*?COALESCE\("material_id",\s*'00000000-0000-0000-0000-000000000000'::uuid\),\s*"signal_type"/);
    });
    it("safe_summary bounded to 240 chars (DB-enforced max length)", () => {
        expect(sql).toMatch(/"safe_summary"\s+VARCHAR\(240\)\s+NOT NULL/);
    });
});
// =============================================================================
// PART 2 — Bounded catalogs
// =============================================================================
describe("Phase 31 — bounded catalogs", () => {
    it("signal types: 16 entries from the brief", () => {
        for (const expected of [
            "EXIF_MISSING",
            "EXIF_TIMESTAMP_MISMATCH",
            "CLIENT_SERVER_TIME_GAP",
            "MIME_EXTENSION_MISMATCH",
            "CODEC_CONTAINER_OBSERVATION",
            "SCREENSHOT_LIKE_FILENAME",
            "DUPLICATE_HASH_MATCH",
            "SIMILAR_FILE_CANDIDATE",
            "POSSIBLE_DERIVATIVE_FILE",
            "TRANSCODING_LINEAGE_CANDIDATE",
            "AUDIO_METADATA_OBSERVATION",
            "VIDEO_DURATION_OBSERVATION",
            "FRAME_EXTRACTION_AVAILABLE",
            "THUMBNAIL_AVAILABLE",
            "OCR_AVAILABLE",
            "TRANSCRIPT_AVAILABLE",
        ]) {
            expect(MEDIA_INTELLIGENCE_SIGNAL_TYPES).toContain(expected);
        }
    });
    it("severity / confidence / status vocabularies are UPPER_SNAKE_CASE", () => {
        for (const v of [
            ...MEDIA_INTELLIGENCE_SEVERITIES,
            ...MEDIA_INTELLIGENCE_CONFIDENCES,
            ...MEDIA_INTELLIGENCE_STATUSES,
        ]) {
            expect(v).toMatch(/^[A-Z][A-Z_]+$/);
        }
    });
    it("every signal type has metadata (displayLabel + defaults)", () => {
        for (const type of MEDIA_INTELLIGENCE_SIGNAL_TYPES) {
            const meta = SIGNAL_METADATA[type];
            expect(meta, `metadata for ${type} missing`).toBeDefined();
            expect(meta.displayLabel.length).toBeGreaterThan(0);
            expect(MEDIA_INTELLIGENCE_SEVERITIES).toContain(meta.defaultSeverity);
            expect(MEDIA_INTELLIGENCE_CONFIDENCES).toContain(meta.defaultConfidence);
            expect(typeof meta.implemented).toBe("boolean");
        }
    });
    it("display labels never use forbidden truth-claim wording", () => {
        const forbidden = /\b(tamper(ed|ing)?|forged|fake|authentic|manipulated|admissible|proves?|confirms?|demonstrates that|verified as real|identity confirmed)\b/i;
        for (const type of MEDIA_INTELLIGENCE_SIGNAL_TYPES) {
            const label = SIGNAL_METADATA[type].displayLabel;
            expect(label, `label "${label}" uses forbidden wording`).not.toMatch(forbidden);
        }
    });
});
// =============================================================================
// PART 3 — Safe-wording library
// =============================================================================
describe("Phase 31 — safe-wording library", () => {
    const forbidden = /\b(tamper(ed|ing)?|forgery|forged|fake|authentic|manipulated|doctored|admissible|proof of|proves?|confirms?|demonstrates that|verified as real|identity confirmed)\b/i;
    it("EXIF_MISSING summary is advisory + bounded", () => {
        const out = safeSummary({ type: "EXIF_MISSING" });
        expect(out).toMatch(/advisory/i);
        expect(out).not.toMatch(forbidden);
    });
    it("CLIENT_SERVER_TIME_GAP summary uses 'approximately' / 'advisory'", () => {
        const out = safeSummary({
            type: "CLIENT_SERVER_TIME_GAP",
            gapSeconds: 3600,
        });
        expect(out).toMatch(/approximately/i);
        expect(out).toMatch(/advisory/i);
        expect(out).not.toMatch(forbidden);
    });
    it("MIME_EXTENSION_MISMATCH summary uses 'review recommended'", () => {
        const out = safeSummary({
            type: "MIME_EXTENSION_MISMATCH",
            extension: "jpg",
            mimeType: "video/mp4",
        });
        expect(out).toMatch(/review recommended/i);
        expect(out).not.toMatch(forbidden);
    });
    it("SCREENSHOT_LIKE_FILENAME uses 'may have been' + 'advisory'", () => {
        const out = safeSummary({ type: "SCREENSHOT_LIKE_FILENAME" });
        expect(out).toMatch(/may have been/i);
        expect(out).toMatch(/advisory/i);
        expect(out).not.toMatch(forbidden);
    });
    it("DUPLICATE_HASH_MATCH uses 'observed' + 'review recommended'", () => {
        const out = safeSummary({
            type: "DUPLICATE_HASH_MATCH",
            otherMaterialCount: 3,
        });
        expect(out).toMatch(/observed/i);
        expect(out).toMatch(/review recommended/i);
        expect(out).not.toMatch(forbidden);
    });
    it("OCR_AVAILABLE / TRANSCRIPT_AVAILABLE are neutral availability statements", () => {
        for (const input of [
            { type: "OCR_AVAILABLE" },
            { type: "TRANSCRIPT_AVAILABLE" },
        ]) {
            const out = safeSummary(input);
            expect(out).toMatch(/available/i);
            expect(out).not.toMatch(forbidden);
        }
    });
    it("every summary is bounded to 240 chars (DB constraint defense)", () => {
        const samples = [
            safeSummary({ type: "EXIF_MISSING" }),
            safeSummary({ type: "CLIENT_SERVER_TIME_GAP", gapSeconds: 86_400 }),
            safeSummary({
                type: "MIME_EXTENSION_MISMATCH",
                extension: "extremely-long-extension-name",
                mimeType: "application/" + "x".repeat(200),
            }),
            safeSummary({ type: "SCREENSHOT_LIKE_FILENAME" }),
            safeSummary({ type: "DUPLICATE_HASH_MATCH", otherMaterialCount: 999 }),
            safeSummary({ type: "OCR_AVAILABLE" }),
            safeSummary({ type: "TRANSCRIPT_AVAILABLE" }),
        ];
        for (const s of samples) {
            expect(s.length).toBeLessThanOrEqual(240);
        }
    });
});
// =============================================================================
// PART 4 — Pure heuristics
// =============================================================================
describe("Phase 31 — pure heuristics", () => {
    describe("detectMimeExtensionMismatch", () => {
        it("returns null when filename or mime is empty", () => {
            expect(detectMimeExtensionMismatch("", "image/jpeg")).toBeNull();
            expect(detectMimeExtensionMismatch("photo.jpg", "")).toBeNull();
        });
        it("returns null when extension is unknown (no signal — we can't say)", () => {
            expect(detectMimeExtensionMismatch("photo.xyz", "image/jpeg")).toBeNull();
        });
        it("returns null when families align (jpg ↔ image/jpeg, mp4 ↔ video/mp4)", () => {
            expect(detectMimeExtensionMismatch("photo.jpg", "image/jpeg")).toBeNull();
            expect(detectMimeExtensionMismatch("clip.mp4", "video/mp4")).toBeNull();
            expect(detectMimeExtensionMismatch("doc.pdf", "application/pdf")).toBeNull();
        });
        it("returns mismatch when extension family ≠ MIME family", () => {
            const r = detectMimeExtensionMismatch("hidden.jpg", "video/mp4");
            expect(r).toEqual({ extension: "jpg", mimeType: "video/mp4" });
        });
        it("handles MIME parameter (e.g. 'image/jpeg; charset=utf-8')", () => {
            expect(detectMimeExtensionMismatch("photo.jpg", "image/jpeg; charset=utf-8")).toBeNull();
        });
        it("is case-insensitive on extension + MIME", () => {
            expect(detectMimeExtensionMismatch("PHOTO.JPG", "Image/JPEG")).toBeNull();
        });
    });
    describe("isScreenshotLikeFilename", () => {
        it("flags common screenshot patterns", () => {
            expect(isScreenshotLikeFilename("Screen Shot 2026-05-20 at 14.32.png")).toBe(true);
            expect(isScreenshotLikeFilename("screenshot_2026.png")).toBe(true);
            expect(isScreenshotLikeFilename("Screen_Capture.png")).toBe(true);
        });
        it("does not flag normal photos", () => {
            expect(isScreenshotLikeFilename("vacation.jpg")).toBe(false);
            expect(isScreenshotLikeFilename("IMG_3421.HEIC")).toBe(false);
        });
        it("handles paths (basename only)", () => {
            expect(isScreenshotLikeFilename("/Users/x/Pictures/Screen Shot 2026-05-20.png")).toBe(true);
            expect(isScreenshotLikeFilename("/Users/x/Pictures/vacation.jpg")).toBe(false);
        });
        it("handles empty input safely", () => {
            expect(isScreenshotLikeFilename("")).toBe(false);
        });
    });
    describe("computeClientServerGapSeconds", () => {
        it("returns null when either side is null/missing", () => {
            expect(computeClientServerGapSeconds(null, new Date())).toBeNull();
            expect(computeClientServerGapSeconds("2026-05-20T00:00:00Z", null)).toBeNull();
            expect(computeClientServerGapSeconds("not-a-date", new Date())).toBeNull();
        });
        it("returns absolute gap in seconds", () => {
            const client = "2026-05-20T12:00:00Z";
            const server = new Date("2026-05-20T13:30:00Z");
            expect(computeClientServerGapSeconds(client, server)).toBe(5400);
        });
        it("is order-independent (always positive)", () => {
            const t1 = "2026-05-20T12:00:00Z";
            const t2 = new Date("2026-05-20T10:00:00Z");
            expect(computeClientServerGapSeconds(t1, t2)).toBe(7200);
        });
    });
});
// =============================================================================
// PART 5 — Analyzer source contract
// =============================================================================
describe("Phase 31 — analyzer source contract", () => {
    const src = readSource("../../../packages/shared-runtime/src/media-intelligence/analyzer.service.ts");
    const noComments = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
    it("NEVER mutates Evidence rows (no .update / .delete on prisma.evidence)", () => {
        expect(noComments).not.toMatch(/client\.evidence\.update/);
        expect(noComments).not.toMatch(/client\.evidence\.delete/);
        expect(noComments).not.toMatch(/prisma\.evidence\.update/);
    });
    it("NEVER mutates EvidencePart rows", () => {
        expect(noComments).not.toMatch(/client\.evidencePart\.update/);
        expect(noComments).not.toMatch(/client\.evidencePart\.delete/);
    });
    it("NEVER creates custody events", () => {
        expect(noComments).not.toMatch(/appendCustody/);
        expect(noComments).not.toMatch(/CustodyEventType/);
    });
    it("NEVER throws — always returns AnalyzerResult", () => {
        // Look for the top-level try/catch that wraps the function body.
        expect(src).toMatch(/export async function runMediaIntelligenceAnalysis[\s\S]*?try\s*\{[\s\S]*?\}\s*catch\s*\{[\s\S]*?return\s*\{[\s\S]*?ok:\s*false,\s*reason:\s*"service_unavailable"/);
    });
    it("every Evidence/EvidencePart read is team-anchored (anti cross-workspace)", () => {
        // The analyzer guards on `evidence.teamId !== input.teamId`
        // and the DUPLICATE_HASH_MATCH query filters by team_id.
        expect(src).toMatch(/evidence\.teamId !== input\.teamId/);
        expect(src).toMatch(/e\."team_id" = \$1/);
    });
    it("NEVER projects raw GPS / private notes / legal notes into safe_summary or detailsJson", () => {
        for (const banned of [
            "rawGps",
            "raw_gps",
            "gpsCoordinates",
            "privateNote",
            "legalNote",
            "privateReviewerNote",
        ]) {
            expect(noComments, `analyzer leaks ${banned}`).not.toContain(banned);
        }
    });
    it("NEVER stores ETag / storage_key / multipart_upload_id", () => {
        for (const banned of [
            "storageKey",
            "storage_key",
            "multipartUploadId",
            "multipart_upload_id",
            "etag",
            "ETag",
        ]) {
            expect(noComments, `analyzer leaks ${banned}`).not.toContain(banned);
        }
    });
    it("CLIENT_SERVER_TIME_GAP threshold is ≥ 1 hour (not alarmist on normal drift)", () => {
        expect(src).toMatch(/gap >= 60 \* 60/);
    });
    it("upsert uses ON CONFLICT to preserve acknowledged status (idempotency)", () => {
        expect(src).toMatch(/ON CONFLICT\s*\([\s\S]*?\)\s*DO UPDATE SET/);
        // The upsert does NOT touch `status` or `acknowledged_by_user_id`
        // — reviewer state is preserved on re-run.
        const updateBlock = src.match(/DO UPDATE SET[\s\S]*?WHERE|DO UPDATE SET[\s\S]*?\)/)?.[0] ?? "";
        expect(updateBlock).not.toMatch(/"status"\s*=/);
        expect(updateBlock).not.toMatch(/"acknowledged_by_user_id"\s*=/);
    });
    it("NEVER uses forbidden wording verbs in source strings", () => {
        const forbidden = /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?\b)/i;
        const stringLiterals = src.match(/"[^"\n]+"/g) ?? [];
        for (const lit of stringLiterals) {
            expect(lit, `analyzer source string uses forbidden wording: ${lit}`).not.toMatch(forbidden);
        }
    });
});
// =============================================================================
// PART 6 — Route source contract
// =============================================================================
describe("Phase 31 — route source contract", () => {
    const src = readSource("../../../services/api/src/routes/media-intelligence.routes.ts");
    const noComments = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
    it("routes registered: GET signals + POST run + Phase 31.5 action", () => {
        expect(src).toMatch(/app\.get\(\s*"\/v1\/evidence\/:evidenceId\/media-intelligence"/);
        expect(src).toMatch(/app\.post\(\s*"\/v1\/evidence\/:evidenceId\/media-intelligence\/run"/);
        // Phase 31.5 added the ack/dismiss endpoint.
        expect(src).toMatch(/app\.post\(\s*"\/v1\/media-intelligence\/signals\/:signalId\/action"/);
    });
    it("every route uses authorizeOrFail with antiEnumeration: true", () => {
        const calls = src.match(/await authorizeOrFail\(\s*req,\s*reply,\s*\{[\s\S]*?\}\s*\)/g) ?? [];
        // Phase 31 original: GET media-intelligence + POST run.
        // Phase 31.5: POST action (acknowledge).
        // Phase 31.12: GET /v1/investigation/overview.
        // Phase 31.13: GET derived-assets + POST derived-assets/run = 2 more.
        // Phase 31.14: GET derived-assets/:assetId/bytes = 1 more.
        // Phase 31.18: GET /v1/investigation/reviewers = 1 more (total 8).
        expect(calls.length).toBe(8);
        for (const c of calls) {
            expect(c).toMatch(/antiEnumeration:\s*true/);
        }
    });
    it("GET uses evidence.read; POST run/action use evidence.update_metadata", () => {
        expect(src).toMatch(/permission:\s*"evidence\.read"/);
        const updateMetaCalls = src.match(/permission:\s*"evidence\.update_metadata"/g) ?? [];
        // Phase 31: POST run.
        // Phase 31.5: POST action.
        // Phase 31.13: POST derived-assets/run.
        expect(updateMetaCalls.length).toBe(3);
    });
    it("anti-enumeration: cross-team evidence returns 404 not_found", () => {
        expect(src).toMatch(/evidence\.teamId !== teamId[\s\S]*?reply\.code\(404\)\.send\(\{\s*error:\s*\{\s*code:\s*"not_found"\s*\}/);
    });
    it("projection NEVER includes technical_details_json on the public read", () => {
        // The projectSignal output type explicitly omits technicalDetailsJson.
        expect(noComments).toMatch(/type ProjectedSignal\s*=/);
        const projectedType = src.match(/type ProjectedSignal\s*=\s*\{[\s\S]*?\};/)?.[0];
        expect(projectedType).toBeTruthy();
        expect(projectedType).not.toContain("technicalDetailsJson");
        expect(projectedType).not.toContain("technical_details_json");
    });
    it("projection NEVER leaks storage / upload identifiers", () => {
        for (const banned of [
            "storageBucket",
            "storage_bucket",
            "storageKey",
            "storage_key",
            "multipartUploadId",
            "multipart_upload_id",
            "signedUrl",
        ]) {
            expect(noComments, `route leaks ${banned}`).not.toContain(banned);
        }
    });
    it("ORDER BY surfaces ATTENTION first (operator triage)", () => {
        expect(src).toMatch(/ORDER BY[\s\S]*?CASE\s*"severity"\s*WHEN 'ATTENTION' THEN 0/);
    });
    it("bounded result LIMIT to prevent unbounded payloads", () => {
        expect(src).toMatch(/LIMIT 200/);
    });
});
// =============================================================================
// PART 7 — Observability
// =============================================================================
describe("Phase 31 — observability", () => {
    it("metrics catalog registers analyzer + reserved counters", () => {
        const src = readSource("../../../packages/shared-runtime/src/ops/metrics.service.ts");
        for (const m of [
            // Active counters
            "media_intelligence_job_started_total",
            "media_intelligence_job_completed_total",
            "media_intelligence_job_failed_total",
            "media_signal_created_total",
            // Reserved (catalog-only) for future phases
            "derived_asset_created_total",
            "duplicate_candidate_created_total",
            "lineage_candidate_created_total",
            "graph_edge_created_total",
            "graph_edge_removed_total",
            "graph_query_total",
            "graph_query_denied_total",
            "timeline_query_total",
        ]) {
            expect(src, `counter ${m} missing`).toContain(`"${m}"`);
        }
    });
    it("runtime-readiness registers media_intelligence subsystem", () => {
        const src = readSource("../../../services/api/src/runtime/runtime-readiness.ts");
        expect(src).toMatch(/\| "media_intelligence"/);
        expect(src).toMatch(/checkMediaIntelligence/);
        expect(src).toMatch(/checkMediaIntelligence\(prisma\)/);
    });
    it("media_intelligence check status is HEALTHY (never CRITICAL — advisory layer only)", () => {
        const src = readSource("../../../services/api/src/runtime/runtime-readiness.ts");
        const fn = src.match(/async function checkMediaIntelligence\([\s\S]*?\n\}/)?.[0];
        expect(fn).toBeTruthy();
        expect(fn).not.toMatch(/status:\s*"CRITICAL"/);
        // HEALTHY on success, UNKNOWN on table-missing — those are the only
        // statuses this subsystem ever returns.
        expect(fn).toMatch(/status:\s*"HEALTHY"/);
        expect(fn).toMatch(/status:\s*"UNKNOWN"/);
    });
    it("schema-validation registers the new table + indices at IMPORTANT severity (not CRITICAL — never blocks boot)", () => {
        const src = readSource("../../../services/api/src/runtime/schema-validation.ts");
        expect(src).toMatch(/name:\s*"media_intelligence_signals",\s*severity:\s*"important"/);
        expect(src).toMatch(/indexName:\s*"media_intelligence_signals_evidence_material_type_uk"/);
    });
    it("server.ts mounts the media-intelligence routes", () => {
        const src = readSource("../../../services/api/src/server.ts");
        expect(src).toMatch(/mediaIntelligenceRoutes/);
        expect(src).toMatch(/app\.register\(mediaIntelligenceRoutes\)/);
    });
});
