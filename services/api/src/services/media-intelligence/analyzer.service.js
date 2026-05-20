/**
 * Phase 31 — Deterministic media intelligence analyzer.
 *
 * Synchronous, read-only analyzer that examines EXISTING evidence
 * metadata (no S3 download, no AI, no image/video processing) and
 * emits bounded advisory signals.
 *
 * What this analyzer DOES this session:
 *   * MIME_EXTENSION_MISMATCH — compares originalFileName extension
 *     with mimeType.
 *   * EXIF_MISSING — checks EvidencePart.clientSignals for the
 *     existing capture-page heuristic.
 *   * SCREENSHOT_LIKE_FILENAME — regex on the filename.
 *   * CLIENT_SERVER_TIME_GAP — compares clientSignals.captureTimeUtc
 *     with Evidence.uploadedAtUtc (server clock).
 *   * DUPLICATE_HASH_MATCH — per-team SHA-256 lookup against other
 *     EvidenceParts.
 *
 * What this analyzer DOES NOT do (deferred to focused sessions):
 *   * Async worker queue / job lifecycle (analyzer here is sync;
 *     route handlers + reconcile cron can invoke it).
 *   * Derived asset generation (thumbnails, frames, waveforms).
 *   * Codec / container parsing (requires ffprobe).
 *   * Perceptual similarity / transcoding lineage detection.
 *   * Cross-workspace lookups (every read is team-anchored).
 *
 * Hard custody / safety rules:
 *   * Idempotent — re-running on the same evidence upserts existing
 *     signals (unique on `(evidence_id, COALESCE(material_id), signal_type)`)
 *     and preserves any operator-acknowledged status.
 *   * Read-only against Evidence + EvidencePart. Never mutates
 *     original evidence bytes, never rewrites canonical hashes,
 *     never touches custody chain.
 *   * Failures bump metrics + return — never throw. Evidence
 *     finalize / report / package flows are NEVER blocked by
 *     analyzer outcomes (non-negotiable rule 8).
 *   * Every signal's `safe_summary` comes from the bounded
 *     `safeSummary()` library — no free-text leak.
 *   * Raw GPS / private notes / legal notes are NEVER included in
 *     `safe_summary` or `technical_details_json`.
 */
import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { listExifSummariesForEvidence } from "./exif-summary.service.js";
import { computeExifVsServerGapSeconds } from "./exif-extractor.service.js";
import { safeSummary, SIGNAL_METADATA, } from "./signal-catalog.js";
/**
 * Run the deterministic analyzer for one evidence record. Read-only,
 * idempotent, never throws. Returns a bounded summary so callers
 * (the read API, a future cron) can surface progress.
 */
export async function runMediaIntelligenceAnalysis(input, client = defaultPrisma) {
    bump("media_intelligence_job_started_total");
    try {
        const evidence = await client.evidence.findUnique({
            where: { id: input.evidenceId },
            select: {
                id: true,
                teamId: true,
                uploadedAtUtc: true,
                capturedAtUtc: true,
                deviceTimeIso: true,
                mimeType: true,
                originalFileName: true,
                fileSha256: true,
            },
        });
        if (!evidence) {
            bump("media_intelligence_job_failed_total");
            return {
                ok: false,
                reason: "evidence_not_found",
                signalsEmitted: 0,
                signalsByType: {},
            };
        }
        if (evidence.teamId !== input.teamId) {
            bump("media_intelligence_job_failed_total");
            return {
                ok: false,
                reason: "team_mismatch",
                signalsEmitted: 0,
                signalsByType: {},
            };
        }
        const parts = await client.evidencePart.findMany({
            where: { evidenceId: input.evidenceId },
            orderBy: { partIndex: "asc" },
            select: {
                id: true,
                partIndex: true,
                originalFileName: true,
                mimeType: true,
                sha256: true,
                // Phase 31.5 — needed for SIMILAR_FILE_CANDIDATE same-size
                // heuristic and for future derived asset bytes accounting.
                sizeBytes: true,
                clientSignals: true,
            },
        });
        // Phase 31.8 — bounded EXIF summaries persisted by the
        // `extract_exif` worker job. The analyzer reads these (rather
        // than re-parsing bytes itself) so it stays DB-only + fast.
        // When the summary table doesn't exist yet (drift patch not
        // applied), the service returns an empty array — the analyzer
        // gracefully falls back to the legacy heuristic path.
        const exifSummaries = await listExifSummariesForEvidence(input.teamId, input.evidenceId, client);
        const exifByPart = new Map(exifSummaries.map((s) => [s.evidencePartId, s]));
        const emitted = [];
        // Per-part deterministic checks
        for (const part of parts) {
            const filename = part.originalFileName ?? "";
            const partMime = part.mimeType ?? evidence.mimeType ?? "";
            const partSignals = readClientSignals(part.clientSignals);
            // 1. MIME_EXTENSION_MISMATCH
            const mismatch = detectMimeExtensionMismatch(filename, partMime);
            if (mismatch) {
                const meta = SIGNAL_METADATA.MIME_EXTENSION_MISMATCH;
                emitted.push({
                    signalType: "MIME_EXTENSION_MISMATCH",
                    materialId: part.id,
                    severity: meta.defaultSeverity,
                    confidence: meta.defaultConfidence,
                    summary: safeSummary({
                        type: "MIME_EXTENSION_MISMATCH",
                        extension: mismatch.extension,
                        mimeType: mismatch.mimeType,
                    }),
                    // INTERNAL diagnostic only — never projected to public
                    // verify or external reviewer surfaces.
                    detailsJson: {
                        extension: mismatch.extension,
                        mimeType: mismatch.mimeType,
                    },
                });
            }
            // 2. EXIF_MISSING — Phase 31.8 prefers the real persisted
            // summary from the EXIF extractor job. Falls back to the
            // capture-page client-signal heuristic when no summary has
            // been persisted yet.
            const persistedExif = exifByPart.get(part.id);
            const observedExifPresent = persistedExif
                ? persistedExif.status === "OK" && persistedExif.exifPresent
                : null;
            const exifMissing = observedExifPresent === false ||
                (observedExifPresent === null && partSignals.exifPresent === false);
            if (exifMissing) {
                const meta = SIGNAL_METADATA.EXIF_MISSING;
                emitted.push({
                    signalType: "EXIF_MISSING",
                    materialId: part.id,
                    severity: meta.defaultSeverity,
                    confidence: meta.defaultConfidence,
                    summary: safeSummary({ type: "EXIF_MISSING" }),
                    detailsJson: {
                        source: persistedExif
                            ? "exif_summary"
                            : "client_signals",
                    },
                });
            }
            // 2b. EXIF_TIMESTAMP_MISMATCH — Phase 31.8. Real signal from
            // the persisted EXIF summary: when DateTimeOriginal (or
            // CreateDate as fallback) is at least 1 hour different from
            // the server upload time, emit a REVIEW_RECOMMENDED. We do
            // NOT emit this for sub-hour drift — typical device clock
            // skew is well under an hour and tripping the signal on
            // routine drift would cause review fatigue.
            if (persistedExif && persistedExif.status === "OK") {
                const exifIso = persistedExif.dateTimeOriginalUtc ??
                    persistedExif.createDateUtc ??
                    null;
                const gap = computeExifVsServerGapSeconds(exifIso, evidence.uploadedAtUtc);
                if (gap !== null && gap >= 60 * 60) {
                    const meta = SIGNAL_METADATA.EXIF_TIMESTAMP_MISMATCH;
                    emitted.push({
                        signalType: "EXIF_TIMESTAMP_MISMATCH",
                        materialId: part.id,
                        severity: meta.defaultSeverity,
                        confidence: meta.defaultConfidence,
                        summary: safeSummary({
                            type: "EXIF_TIMESTAMP_MISMATCH",
                            gapSeconds: gap,
                        }),
                        detailsJson: { gapSeconds: gap, source: "exif_summary" },
                    });
                }
            }
            // 2c. DEVICE_METADATA_OBSERVATION — Phase 31.8. Informational
            // signal when the EXIF extractor recorded at least one
            // bounded device field. NEVER classifies the device — only
            // reports which fields were observed. Privacy: never includes
            // the actual make/model/software values in the safe summary;
            // it only reports presence flags.
            if (persistedExif && persistedExif.status === "OK") {
                const hasMake = persistedExif.cameraMake != null;
                const hasModel = persistedExif.cameraModel != null;
                const hasSoftware = persistedExif.software != null;
                const hasDimensions = persistedExif.dimensions != null;
                if (hasMake || hasModel || hasSoftware || hasDimensions) {
                    const meta = SIGNAL_METADATA.DEVICE_METADATA_OBSERVATION;
                    emitted.push({
                        signalType: "DEVICE_METADATA_OBSERVATION",
                        materialId: part.id,
                        severity: meta.defaultSeverity,
                        confidence: meta.defaultConfidence,
                        summary: safeSummary({
                            type: "DEVICE_METADATA_OBSERVATION",
                            hasMake,
                            hasModel,
                            hasDimensions,
                            hasSoftware,
                        }),
                        // INTERNAL diagnostic only — bounded presence flags
                        // (no actual make/model strings leak through the
                        // signal projection). The summary table holds the
                        // bounded values for operators who have direct access.
                        detailsJson: {
                            hasMake,
                            hasModel,
                            hasDimensions,
                            hasSoftware,
                        },
                    });
                }
            }
            // 3. SCREENSHOT_LIKE_FILENAME
            if (partSignals.screenshotLike || isScreenshotLikeFilename(filename)) {
                const meta = SIGNAL_METADATA.SCREENSHOT_LIKE_FILENAME;
                emitted.push({
                    signalType: "SCREENSHOT_LIKE_FILENAME",
                    materialId: part.id,
                    severity: meta.defaultSeverity,
                    confidence: meta.defaultConfidence,
                    summary: safeSummary({ type: "SCREENSHOT_LIKE_FILENAME" }),
                    detailsJson: { matchedHeuristic: true },
                });
            }
            // 4. CLIENT_SERVER_TIME_GAP — capture-time vs upload server clock
            const gap = computeClientServerGapSeconds(partSignals.captureTimeUtc ?? evidence.deviceTimeIso ?? null, evidence.uploadedAtUtc);
            if (gap !== null && gap >= 60 * 60) {
                // ≥ 1h gap is the threshold worth surfacing. Below that
                // is normal phone/laptop drift.
                const meta = SIGNAL_METADATA.CLIENT_SERVER_TIME_GAP;
                emitted.push({
                    signalType: "CLIENT_SERVER_TIME_GAP",
                    materialId: part.id,
                    severity: meta.defaultSeverity,
                    confidence: meta.defaultConfidence,
                    summary: safeSummary({
                        type: "CLIENT_SERVER_TIME_GAP",
                        gapSeconds: gap,
                    }),
                    detailsJson: { gapSeconds: gap },
                });
            }
            // 5. DUPLICATE_HASH_MATCH — per-team SHA-256 lookup
            if (part.sha256) {
                const dupes = await findDuplicateHashCount(client, input.teamId, part.sha256, part.id);
                if (dupes > 0) {
                    const meta = SIGNAL_METADATA.DUPLICATE_HASH_MATCH;
                    emitted.push({
                        signalType: "DUPLICATE_HASH_MATCH",
                        materialId: part.id,
                        severity: meta.defaultSeverity,
                        confidence: meta.defaultConfidence,
                        summary: safeSummary({
                            type: "DUPLICATE_HASH_MATCH",
                            otherMaterialCount: dupes,
                        }),
                        detailsJson: { otherMaterialCount: dupes },
                    });
                    bump("duplicate_candidate_created_total");
                }
            }
            // 6. SIMILAR_FILE_CANDIDATE — same-filename + same-size
            //    deterministic heuristic. Bounded: only fires when both
            //    the filename AND the size match another EvidencePart in
            //    the team AND the SHA-256 differs (so we don't double-
            //    count exact duplicates from #5).
            if (filename && part.sizeBytes != null) {
                const candidates = await findSimilarFilenameSizeCount(client, input.teamId, filename, BigInt(part.sizeBytes), part.sha256, part.id);
                if (candidates > 0) {
                    const meta = SIGNAL_METADATA.SIMILAR_FILE_CANDIDATE;
                    emitted.push({
                        signalType: "SIMILAR_FILE_CANDIDATE",
                        materialId: part.id,
                        severity: meta.defaultSeverity,
                        confidence: meta.defaultConfidence,
                        summary: safeSummary({
                            type: "SIMILAR_FILE_CANDIDATE",
                            otherMaterialCount: candidates,
                        }),
                        detailsJson: { otherMaterialCount: candidates },
                    });
                    bump("lineage_candidate_created_total");
                }
            }
            // 7. VIDEO_DURATION_OBSERVATION — from clientSignals.durationMs.
            const family = mimeFamily(partMime);
            if (family === "video" &&
                partSignals.durationMs != null &&
                partSignals.durationMs > 0) {
                const durationSeconds = Math.floor(partSignals.durationMs / 1000);
                const meta = SIGNAL_METADATA.VIDEO_DURATION_OBSERVATION;
                emitted.push({
                    signalType: "VIDEO_DURATION_OBSERVATION",
                    materialId: part.id,
                    severity: meta.defaultSeverity,
                    confidence: meta.defaultConfidence,
                    summary: safeSummary({
                        type: "VIDEO_DURATION_OBSERVATION",
                        durationSeconds,
                    }),
                    detailsJson: { durationSeconds, source: "client_signals" },
                });
            }
            // 8. AUDIO_METADATA_OBSERVATION — fires on any audio MIME.
            if (family === "audio") {
                const meta = SIGNAL_METADATA.AUDIO_METADATA_OBSERVATION;
                emitted.push({
                    signalType: "AUDIO_METADATA_OBSERVATION",
                    materialId: part.id,
                    severity: meta.defaultSeverity,
                    confidence: meta.defaultConfidence,
                    summary: safeSummary({
                        type: "AUDIO_METADATA_OBSERVATION",
                        family: partMime,
                    }),
                    detailsJson: { mimeType: partMime },
                });
            }
        }
        // Evidence-level OCR / TRANSCRIPT availability via existing
        // EvidenceIntelligenceJob table. Per evidence (not per part)
        // because the existing intelligence pipeline operates at
        // evidence granularity.
        const ocrAvailable = await checkIntelligenceJobAvailability(client, input.evidenceId, "OCR");
        if (ocrAvailable) {
            const meta = SIGNAL_METADATA.OCR_AVAILABLE;
            emitted.push({
                signalType: "OCR_AVAILABLE",
                materialId: null,
                severity: meta.defaultSeverity,
                confidence: meta.defaultConfidence,
                summary: safeSummary({ type: "OCR_AVAILABLE" }),
                detailsJson: { source: "evidence_intelligence_jobs" },
            });
        }
        const transcriptAvailable = await checkIntelligenceJobAvailability(client, input.evidenceId, "TRANSCRIPT");
        if (transcriptAvailable) {
            const meta = SIGNAL_METADATA.TRANSCRIPT_AVAILABLE;
            emitted.push({
                signalType: "TRANSCRIPT_AVAILABLE",
                materialId: null,
                severity: meta.defaultSeverity,
                confidence: meta.defaultConfidence,
                summary: safeSummary({ type: "TRANSCRIPT_AVAILABLE" }),
                detailsJson: { source: "evidence_intelligence_jobs" },
            });
        }
        // Persist signals (upsert by unique key — preserve acknowledged
        // status on existing rows).
        for (const sig of emitted) {
            try {
                await client.$executeRawUnsafe(`INSERT INTO "media_intelligence_signals"
             ("team_id", "evidence_id", "material_id", "signal_type",
              "severity", "confidence", "safe_summary", "technical_details_json")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
           ON CONFLICT (
             "evidence_id",
             COALESCE("material_id", '00000000-0000-0000-0000-000000000000'::uuid),
             "signal_type"
           ) DO UPDATE SET
             "safe_summary" = EXCLUDED."safe_summary",
             "technical_details_json" = EXCLUDED."technical_details_json",
             "severity" = EXCLUDED."severity",
             "confidence" = EXCLUDED."confidence",
             "updated_at_utc" = NOW()`, input.teamId, input.evidenceId, sig.materialId, sig.signalType, sig.severity, sig.confidence, sig.summary, JSON.stringify(sig.detailsJson ?? null));
                bump("media_signal_created_total");
            }
            catch {
                // Persistence failure for a single signal — keep going.
                // The job is best-effort by design.
            }
        }
        bump("media_intelligence_job_completed_total");
        const signalsByType = {};
        for (const sig of emitted) {
            signalsByType[sig.signalType] = (signalsByType[sig.signalType] ?? 0) + 1;
        }
        return {
            ok: true,
            signalsEmitted: emitted.length,
            signalsByType,
        };
    }
    catch {
        bump("media_intelligence_job_failed_total");
        return {
            ok: false,
            reason: "service_unavailable",
            signalsEmitted: 0,
            signalsByType: {},
        };
    }
}
/**
 * Return the mismatch payload when the filename's extension does
 * not align with the observed MIME type. Bounded vocabulary: the
 * comparison is against a known-safe map. Unknown extensions /
 * MIME types return null (no signal — we can't say either way).
 */
export function detectMimeExtensionMismatch(filename, mimeType) {
    if (!filename || !mimeType)
        return null;
    const dot = filename.lastIndexOf(".");
    if (dot < 0 || dot === filename.length - 1)
        return null;
    const ext = filename.slice(dot + 1).toLowerCase();
    const normalizedMime = mimeType.toLowerCase().split(";")[0].trim();
    const expected = EXTENSION_TO_MIME_FAMILY[ext];
    if (!expected)
        return null; // unknown extension — no signal
    const actualFamily = mimeFamily(normalizedMime);
    if (!actualFamily)
        return null;
    if (expected !== actualFamily) {
        return { extension: ext, mimeType: normalizedMime };
    }
    return null;
}
/** Bounded family map. Keys are lowercase extensions. */
const EXTENSION_TO_MIME_FAMILY = {
    jpg: "image",
    jpeg: "image",
    png: "image",
    gif: "image",
    bmp: "image",
    webp: "image",
    heic: "image",
    mp4: "video",
    mov: "video",
    m4v: "video",
    avi: "video",
    webm: "video",
    mp3: "audio",
    m4a: "audio",
    wav: "audio",
    flac: "audio",
    ogg: "audio",
    pdf: "application",
    doc: "application",
    docx: "application",
    txt: "text",
    csv: "text",
};
export function mimeFamily(mime) {
    if (!mime)
        return null;
    const slash = mime.indexOf("/");
    if (slash < 0)
        return null;
    const family = mime.slice(0, slash).toLowerCase();
    if (family === "image" ||
        family === "video" ||
        family === "audio" ||
        family === "text" ||
        family === "application") {
        return family;
    }
    return null;
}
/** Bounded screenshot-like filename patterns. */
const SCREENSHOT_FILENAME_PATTERNS = [
    /^screen[\s_-]?shot/i,
    /^screenshot/i,
    /^screen[\s_-]?capture/i,
    /^Screen Shot \d{4}-\d{2}-\d{2}/i,
    /^IMG_\d{8}_\d{6}_screen/i,
];
export function isScreenshotLikeFilename(filename) {
    if (!filename)
        return false;
    const base = filename.split(/[\\/]/).pop() ?? filename;
    return SCREENSHOT_FILENAME_PATTERNS.some((re) => re.test(base));
}
/**
 * Compute the absolute gap in seconds between a client-observed
 * capture time and a server-authoritative timestamp. Returns null
 * when either side is missing or unparseable.
 */
export function computeClientServerGapSeconds(clientTimeIso, serverTime) {
    if (!clientTimeIso || !serverTime)
        return null;
    const client = new Date(clientTimeIso).getTime();
    if (!Number.isFinite(client))
        return null;
    const server = serverTime.getTime();
    if (!Number.isFinite(server))
        return null;
    return Math.abs(Math.floor((server - client) / 1000));
}
function readClientSignals(raw) {
    if (!raw || typeof raw !== "object")
        return {};
    const o = raw;
    return {
        captureTimeUtc: typeof o.captureTimeUtc === "string" ? o.captureTimeUtc : null,
        exifPresent: typeof o.exifPresent === "boolean" ? o.exifPresent : null,
        screenshotLike: typeof o.screenshotLike === "boolean" ? o.screenshotLike : null,
        durationMs: typeof o.durationMs === "number" && Number.isFinite(o.durationMs)
            ? o.durationMs
            : null,
    };
}
async function findDuplicateHashCount(client, teamId, sha256, excludePartId) {
    try {
        const rows = (await client.$queryRawUnsafe(`SELECT COUNT(*)::int AS "n"
         FROM "evidence_parts" ep
         JOIN "evidence" e ON e."id" = ep."evidence_id"
         WHERE e."team_id" = $1
           AND ep."sha256" = $2
           AND ep."id" <> $3`, teamId, sha256, excludePartId));
        return rows[0]?.n ?? 0;
    }
    catch {
        return 0;
    }
}
/**
 * Same-filename + same-size + DIFFERENT-hash count. Deliberately
 * excludes exact-hash duplicates (covered by `findDuplicateHashCount`)
 * so SIMILAR_FILE_CANDIDATE never double-counts.
 *
 * Team-anchored. Fails closed (returns 0 on error).
 */
async function findSimilarFilenameSizeCount(client, teamId, filename, sizeBytes, ownSha256, excludePartId) {
    try {
        const rows = (await client.$queryRawUnsafe(`SELECT COUNT(*)::int AS "n"
         FROM "evidence_parts" ep
         JOIN "evidence" e ON e."id" = ep."evidence_id"
         WHERE e."team_id" = $1
           AND ep."original_file_name" = $2
           AND ep."size_bytes" = $3
           AND ep."id" <> $4
           AND (ep."sha256" IS NULL OR ep."sha256" <> COALESCE($5, ''))`, teamId, filename, sizeBytes, excludePartId, ownSha256));
        return rows[0]?.n ?? 0;
    }
    catch {
        return 0;
    }
}
/**
 * Existence check for an OCR / TRANSCRIPT job on this evidence.
 * Returns true when a row exists in ANY non-failed state (PENDING /
 * PROCESSING / COMPLETED) — i.e. the platform knows about OCR /
 * transcript work for this evidence even if it's still in progress.
 *
 * Team scoping is enforced by the caller (evidence ownership was
 * already validated). Fails closed.
 */
async function checkIntelligenceJobAvailability(client, evidenceId, kind) {
    try {
        const rows = (await client.$queryRawUnsafe(`SELECT 1
         FROM "evidence_intelligence_jobs"
         WHERE "evidence_id" = $1
           AND "kind" = $2::"EvidenceIntelligenceJobKind"
           AND "status" IN ('PENDING', 'PROCESSING', 'COMPLETED')
         LIMIT 1`, evidenceId, kind));
        return rows.length > 0;
    }
    catch {
        return false;
    }
}
