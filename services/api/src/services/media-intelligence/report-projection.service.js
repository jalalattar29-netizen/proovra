/**
 * Phase 31.11 — Media intelligence report projection.
 *
 * Reads the canonical per-evidence intelligence tables and projects
 * a bounded `MediaIntelligenceReportInput` shape suitable for the
 * report-v2 Media Intelligence Observations section.
 *
 * Hard custody / safety rules:
 *
 *   * NEVER throws. Every error path returns `null` — the caller
 *     (the worker's report processor) interprets `null` as "no
 *     intelligence available" and the report renders byte-identical
 *     to the pre-Phase-31.10 output.
 *   * NEVER blocks report generation. The caller wraps this in
 *     try/catch defence-in-depth, but this module itself is the
 *     primary guarantee: read failures, schema drift, governance
 *     denial — all return null without exception.
 *   * Bounded result. Signals capped at 100; the report renderer
 *     applies its own further cap at 200. The DB query LIMITs.
 *   * Anti-leak. The projection NEVER emits:
 *       - storage_key / storage_bucket / signed URLs
 *       - multipart_upload_id
 *       - raw GPS coordinates
 *       - private notes / legal notes / reviewer-private fields
 *       - internal acknowledged_by_user_id
 *     The bounded fields we DO emit are exactly the renderer's
 *     `MediaIntelligenceReportSignal` shape.
 *   * Materialed label is the EvidencePart.original_file_name
 *     (truncated to 120 chars) when the signal carries a
 *     material_id; otherwise null.
 *   * DISMISSED signals are FILTERED OUT — operators explicitly
 *     marked them as not actionable; they don't belong in a
 *     legally-distributed PDF.
 *   * Order: ATTENTION first, then REVIEW_RECOMMENDED, then INFO;
 *     newest first within a tier. The report renderer applies the
 *     same sort but we sort here too so a downstream consumer
 *     reading the bounded array directly gets a sensible order.
 *
 * Derived assets + OCR/transcript projections are reserved for
 * future phases — for now those branches return empty arrays so
 * the renderer's bounded shape is satisfied (the section only
 * emits a subsection if its corresponding input array is
 * non-empty, see `media-intelligence.ts` section file).
 */
import { prisma as defaultPrisma } from "../../db.js";
// =============================================================================
// Bounds + sort tables
// =============================================================================
const MAX_SIGNALS_PROJECTED = 100;
const MAX_MATERIAL_LABEL_CHARS = 120;
const MAX_SAFE_SUMMARY_CHARS = 240;
const SEVERITY_RANK = {
    ATTENTION: 0,
    REVIEW_RECOMMENDED: 1,
    INFO: 2,
};
const ALLOWED_SEVERITIES = new Set([
    "INFO",
    "REVIEW_RECOMMENDED",
    "ATTENTION",
]);
const ALLOWED_CONFIDENCES = new Set([
    "LOW",
    "MEDIUM",
    "HIGH",
]);
const ALLOWED_STATUSES = new Set([
    "PENDING",
    "ACKNOWLEDGED",
    "DISMISSED",
]);
// =============================================================================
// Entry point
// =============================================================================
/**
 * Project the bounded media intelligence input for one evidence id.
 *
 * Returns `null` when there's no intelligence to surface OR when any
 * step in the projection failed. The caller treats both cases
 * identically: skip the section in the report, log + continue.
 */
export async function projectMediaIntelligenceForReport(input, client = defaultPrisma) {
    if (!input.teamId || !input.evidenceId)
        return null;
    let signals = [];
    try {
        const rows = (await client.$queryRawUnsafe(`SELECT s."id",
              s."signal_type",
              s."material_id",
              s."severity",
              s."confidence",
              s."safe_summary",
              s."status",
              s."created_at_utc",
              p."original_file_name" AS "material_filename"
         FROM "media_intelligence_signals" s
         LEFT JOIN "evidence_parts" p
           ON p."id" = s."material_id"
        WHERE s."team_id" = $1
          AND s."evidence_id" = $2
          AND s."status" IN ('PENDING','ACKNOWLEDGED')
        ORDER BY
          CASE s."severity"
            WHEN 'ATTENTION' THEN 0
            WHEN 'REVIEW_RECOMMENDED' THEN 1
            ELSE 2
          END,
          s."created_at_utc" DESC
        LIMIT ${MAX_SIGNALS_PROJECTED}`, input.teamId, input.evidenceId));
        signals = rows
            .map(projectRow)
            .filter((s) => s != null);
    }
    catch {
        // Signal projection failed — fall through; the report still
        // generates (without intelligence) and the caller logs the
        // bounded failure.
        return null;
    }
    // Phase 31.14 — fetch bounded derived thumbnails (image_thumbnail
    // only this phase). Inline as data URLs since the PDF cannot make
    // HTTP calls during render. Bounded budget so the PDF footprint
    // stays controlled.
    const derivedThumbnails = await loadDerivedThumbnailsForReport(input.teamId, input.evidenceId, client);
    // The whole projection is null-shaped when EVERY subprojection
    // would be empty so the renderer can short-circuit to byte-
    // identical legacy output (see media-intelligence.ts section).
    if (signals.length === 0 && derivedThumbnails.length === 0) {
        return null;
    }
    return {
        signals,
        derivedThumbnails,
        // Phase 31.11 — OCR/transcript wiring is still a future phase.
        ocrTranscript: [],
    };
}
// =============================================================================
// Internals
// =============================================================================
function projectRow(raw) {
    if (!ALLOWED_SEVERITIES.has(raw.severity)) {
        return null;
    }
    if (!ALLOWED_CONFIDENCES.has(raw.confidence)) {
        return null;
    }
    if (!ALLOWED_STATUSES.has(raw.status)) {
        return null;
    }
    if (typeof raw.safe_summary !== "string" || raw.safe_summary.length === 0) {
        return null;
    }
    return {
        id: raw.id,
        signalType: raw.signal_type,
        materialId: raw.material_id,
        materialLabel: sanitizeMaterialLabel(raw.material_filename),
        severity: raw.severity,
        confidence: raw.confidence,
        safeSummary: raw.safe_summary.slice(0, MAX_SAFE_SUMMARY_CHARS),
        status: raw.status,
        createdAtUtc: raw.created_at_utc.toISOString(),
    };
}
/**
 * Trim + bound + reject prose-injection vectors. The filename is
 * what an end user originally named the file, so we cap length and
 * drop characters outside a safe set. NULL for missing.
 */
function sanitizeMaterialLabel(s) {
    if (s == null)
        return null;
    const trimmed = s.trim();
    if (trimmed.length === 0)
        return null;
    // Allow letters, digits, spaces, dot, dash, underscore, parens,
    // forward slash (for paths). Reject control codes + characters
    // that could otherwise inject HTML or shell content. The report
    // renderer also `escapeHtml`s the value as defense in depth.
    if (!/^[\w\s\-./()]+$/.test(trimmed))
        return null;
    return trimmed.slice(0, MAX_MATERIAL_LABEL_CHARS);
}
// Re-export the sort rank so tests can assert ordering without
// re-deriving the catalog.
export const REPORT_PROJECTION_SEVERITY_RANK = SEVERITY_RANK;
// =============================================================================
// Phase 31.14 — derived thumbnails (image_thumbnail only this phase)
// =============================================================================
/**
 * Bounded helper that fetches COMPLETED `image_thumbnail` derived
 * assets for the evidence and inlines their bytes as data URLs.
 *
 * Bounds:
 *   * At most 6 thumbnails per evidence (report PDF footprint).
 *   * Skips any single asset over `MAX_REPORT_THUMBNAIL_BYTES`
 *     (typically a generous safeguard — sharp output at 256px is
 *     ≪ 100KB, so the schema's 50MB cap is mostly a defensive
 *     ceiling rather than a real bound).
 *   * NEVER projects storage_bucket / storage_key — uses the
 *     internal `_getDerivedAssetStorageReference` helper to pull
 *     bytes then drops the reference.
 *   * NEVER throws. Failures yield an empty list — the report
 *     renders with NO thumbnails subsection.
 */
const MAX_REPORT_THUMBNAILS = 6;
const MAX_REPORT_THUMBNAIL_BYTES = 256 * 1024;
async function loadDerivedThumbnailsForReport(teamId, evidenceId, client) {
    try {
        const rows = (await client.$queryRawUnsafe(`SELECT "id", "evidence_part_id", "asset_kind"
         FROM "evidence_part_derived_assets"
        WHERE "team_id" = $1
          AND "evidence_id" = $2
          AND "asset_kind" = 'image_thumbnail'
          AND "status" = 'COMPLETED'
        ORDER BY "updated_at_utc" DESC
        LIMIT ${MAX_REPORT_THUMBNAILS}`, teamId, evidenceId));
        if (rows.length === 0)
            return [];
        const { _getDerivedAssetStorageReference } = await import("./derived-assets.service.js");
        const { getObjectStream } = await import("../../storage.js");
        const out = [];
        for (const row of rows) {
            try {
                const ref = await _getDerivedAssetStorageReference(teamId, row.id, client);
                if (!ref)
                    continue;
                const stream = await getObjectStream({
                    bucket: ref.bucket,
                    key: ref.key,
                });
                const chunks = [];
                let total = 0;
                for await (const chunk of stream) {
                    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
                    total += buf.byteLength;
                    // Skip oversized assets — PDF footprint protection.
                    if (total > MAX_REPORT_THUMBNAIL_BYTES) {
                        total = -1;
                        break;
                    }
                    chunks.push(buf);
                }
                if (total < 0)
                    continue;
                const body = Buffer.concat(chunks);
                const contentType = ref.contentType ?? "image/webp";
                out.push({
                    materialId: row.evidence_part_id,
                    assetKind: row.asset_kind,
                    dataUrl: `data:${contentType};base64,${body.toString("base64")}`,
                });
            }
            catch {
                // Single-asset failure is non-fatal. The other thumbnails
                // still ship.
                continue;
            }
        }
        return out;
    }
    catch {
        return [];
    }
}
