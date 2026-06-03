/**
 * PROOVRA Phase 3B — Azure Document Intelligence adapter.
 *
 * Bounded adapter on top of the existing Phase 3A Closure
 * `azure-document-intelligence-client.ts`. Maps Azure's bounded
 * `prebuilt-layout` output into `AdapterRecordRow` rows the
 * media-intelligence ingest pipeline persists. Bills usage in
 * pages (1 page = bounded pricing unit).
 */
import { classifyIntelligenceConfidence, } from "@proovra/shared";
import { createHash } from "node:crypto";
import { analyzeDocumentLayout, probeAzureDocumentIntelligence, } from "../../redaction/providers/azure-document-intelligence-client.js";
import { registerAdapter, } from "./provider-adapter.js";
const PROVIDER = "AZURE_DOCUMENT_INTELLIGENCE";
const SUPPORTED = [
    "OCR_DOCUMENT",
    "OCR_IMAGE",
];
/**
 * Bounded Azure DI pricing — `prebuilt-layout` lists at $1.50 per
 * 1000 pages at retail. Stored in USD micros to keep budget
 * arithmetic in integers.
 */
const COST_PER_PAGE_USD_MICROS = 1500;
export const azureDocumentIntelligenceAdapter = {
    provider: PROVIDER,
    supportedOperations: SUPPORTED,
    probe() {
        const p = probeAzureDocumentIntelligence();
        return {
            provider: PROVIDER,
            state: p.state,
            operations: SUPPORTED,
            reason: p.reason,
        };
    },
    async ocrDocument(input) {
        return runAzure({
            documentBytes: input.bytes ?? null,
            documentUrl: input.url ?? null,
        });
    },
    async ocrImage(input) {
        return runAzure({
            documentBytes: input.bytes ?? null,
            documentUrl: input.url ?? null,
        });
    },
};
registerAdapter(azureDocumentIntelligenceAdapter);
// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------
async function runAzure(input) {
    const result = await analyzeDocumentLayout(input);
    if (result.state !== "READY") {
        return {
            ok: false,
            state: result.state,
            reason: result.reason,
            usage: {
                provider: PROVIDER,
                operation: "OCR_DOCUMENT",
                unit: "PAGE",
                units: 0,
                estimatedCostUsdMicros: 0,
            },
        };
    }
    const records = [];
    const text = result.extractedText ?? "";
    // Each Azure detection row becomes one OCR record. We collapse
    // the per-paragraph + per-page-rect entries Azure produces into
    // the bounded `DOCUMENT_OCR_TEXT` / `DOCUMENT_LAYOUT` shape so
    // the reviewer queue stays clean.
    for (const r of result.rows) {
        const labelHint = typeof r.previewLabel === "string"
            ? r.previewLabel.slice(0, 80)
            : null;
        const kind = r.suggestedRegionKind === "PDF_PAGE_RECT"
            ? "DOCUMENT_LAYOUT"
            : "DOCUMENT_OCR_TEXT";
        const anchor = r.suggestedRegionGeometry;
        const providerRecordKey = hashKey([
            PROVIDER,
            kind,
            JSON.stringify(anchor ?? {}),
        ]);
        records.push({
            kind: kind,
            modality: "DOCUMENT",
            providerConfidence: r.rawConfidence,
            providerConfidenceBand: classifyIntelligenceConfidence(r.rawConfidence),
            label: labelHint,
            anchor,
            payload: {
                suggestedMethod: r.suggestedMethod,
                previewLabel: labelHint,
            },
            providerRecordKey,
        });
    }
    // Bounded usage — bill one page per 5000 characters of extracted
    // text as a conservative heuristic when Azure does not report
    // page count directly in `analyzeDocumentLayout`'s bounded result.
    const pages = Math.max(1, Math.ceil(text.length / 5000));
    return {
        ok: true,
        records,
        entities: [],
        extractedText: text,
        usage: {
            provider: PROVIDER,
            operation: "OCR_DOCUMENT",
            unit: "PAGE",
            units: pages,
            estimatedCostUsdMicros: pages * COST_PER_PAGE_USD_MICROS,
        },
    };
}
function hashKey(parts) {
    return createHash("sha256")
        .update(parts.join("|"), "utf8")
        .digest("hex")
        .slice(0, 64);
}
