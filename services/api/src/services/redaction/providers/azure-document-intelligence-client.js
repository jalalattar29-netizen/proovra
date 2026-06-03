/**
 * PROOVRA Phase 3A Closure — Azure Document Intelligence client wrapper.
 *
 * Real `@azure-rest/ai-document-intelligence` integration. Calls
 * the `prebuilt-layout` model to extract text + bounding regions
 * from PDF / image documents, then maps the result into bounded
 * `PDF_TEXT_RANGE` + `PDF_PAGE_RECT` detection candidates.
 *
 * Hard rules:
 *   * Bounded probe — READY only when endpoint + key are bound.
 *   * NEVER logs raw document bytes or extracted text.
 *   * Bounded preview labels — first 60 chars masked.
 *   * Sentry capture on UNEXPECTED errors; quota / auth mapped to
 *     bounded provider states.
 */
import DocumentIntelligenceClient, { getLongRunningPoller, isUnexpected, } from "@azure-rest/ai-document-intelligence";
import { classifyConfidence } from "@proovra/shared";
import { getSecret } from "../../../config/runtime-secrets.js";
import { captureException } from "../../../observability/sentry.js";
// ---------------------------------------------------------------------------
// Lazy client construction
// ---------------------------------------------------------------------------
let cachedClient = null;
function resolveEndpoint() {
    const fromSecret = getSecret("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT");
    if (fromSecret)
        return fromSecret;
    const fromEnv = (process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ?? "").trim();
    return fromEnv.length > 0 ? fromEnv : null;
}
function resolveKey() {
    const fromSecret = getSecret("AZURE_DOCUMENT_INTELLIGENCE_KEY");
    if (fromSecret)
        return fromSecret;
    const fromEnv = (process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY ?? "").trim();
    return fromEnv.length > 0 ? fromEnv : null;
}
export function probeAzureDocumentIntelligence() {
    const endpoint = resolveEndpoint();
    const key = resolveKey();
    if (!endpoint) {
        return {
            state: "NOT_CONFIGURED",
            reason: "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT is not bound",
            endpoint: null,
        };
    }
    if (!key) {
        return {
            state: "NOT_CONFIGURED",
            reason: "AZURE_DOCUMENT_INTELLIGENCE_KEY is not bound",
            endpoint,
        };
    }
    return { state: "READY", reason: null, endpoint };
}
function buildClient() {
    const probe = probeAzureDocumentIntelligence();
    if (probe.state !== "READY")
        return null;
    if (cachedClient)
        return cachedClient;
    const key = resolveKey();
    if (!probe.endpoint || !key)
        return null;
    cachedClient = DocumentIntelligenceClient(probe.endpoint, { key });
    return cachedClient;
}
// ---------------------------------------------------------------------------
// analyzeLayout
// ---------------------------------------------------------------------------
/**
 * Run the `prebuilt-layout` model and map the result into bounded
 * detection candidates. The platform consumes:
 *
 *   * `paragraphs` → PDF_TEXT_RANGE candidates with bounded preview.
 *   * `pages.{lines, words}` → PDF_PAGE_RECT candidates when the
 *     paragraph carries a bounding region polygon.
 *
 * Returns the bounded extracted plain text so the orchestrator can
 * additionally run the REGEX_PII provider against it without
 * re-fetching the document.
 */
export async function analyzeDocumentLayout(input, client = buildClient()) {
    if (!client) {
        return {
            state: "NOT_CONFIGURED",
            reason: probeAzureDocumentIntelligence().reason,
            rows: [],
            extractedText: null,
        };
    }
    if ((!input.documentBytes || input.documentBytes.length === 0) &&
        !input.documentUrl) {
        return {
            state: "NOT_CONFIGURED",
            reason: "azure_document_intelligence_requires_bytes_or_url",
            rows: [],
            extractedText: null,
        };
    }
    try {
        const body = input.documentUrl
            ? { urlSource: input.documentUrl }
            : { base64Source: bytesToBase64(input.documentBytes) };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const initial = await client
            .path("/documentModels/{modelId}:analyze", "prebuilt-layout")
            .post({
            contentType: "application/json",
            body,
        });
        if (isUnexpected(initial)) {
            return mapHttpError("analyze_layout", initial.status, initial.body);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const poller = getLongRunningPoller(client, initial);
        const result = (await poller.pollUntilDone()).body;
        const analyze = result.analyzeResult;
        if (!analyze) {
            return {
                state: "ERROR",
                reason: "azure_document_intelligence_empty_result",
                rows: [],
                extractedText: null,
            };
        }
        const pageSizes = new Map();
        for (const p of analyze.pages ?? []) {
            if (p.pageNumber !== undefined && p.width && p.height) {
                pageSizes.set(p.pageNumber, { width: p.width, height: p.height });
            }
        }
        const rows = [];
        for (const para of analyze.paragraphs ?? []) {
            const text = (para.content ?? "").trim();
            if (text.length === 0)
                continue;
            const span = (para.spans ?? [])[0];
            const region = (para.boundingRegions ?? [])[0];
            const pageIndex = (region?.pageNumber ?? 1) - 1;
            const raw = para.confidence ?? 0.9;
            const previewLabel = `azure_layout · ${text.slice(0, 60)}`.slice(0, 80);
            if (span && Number.isFinite(span.offset) && Number.isFinite(span.length)) {
                rows.push({
                    kind: "TEXT_BLOCK",
                    rawConfidence: raw,
                    confidenceBand: classifyConfidence(raw),
                    suggestedRegionKind: "PDF_TEXT_RANGE",
                    suggestedRegionGeometry: {
                        pageIndex,
                        charStart: span.offset,
                        charEnd: span.offset + span.length,
                    },
                    suggestedMethod: "REMOVE_CONTENT",
                    previewLabel,
                });
            }
            if (region?.polygon && region.polygon.length >= 8) {
                const size = pageSizes.get(region.pageNumber ?? 1) ?? null;
                const bbox = polygonToNormalizedBbox(region.polygon, size);
                if (bbox) {
                    rows.push({
                        kind: "TEXT_BLOCK",
                        rawConfidence: raw,
                        confidenceBand: classifyConfidence(raw),
                        suggestedRegionKind: "PDF_PAGE_RECT",
                        suggestedRegionGeometry: { pageIndex, rect: bbox },
                        suggestedMethod: "BLACKOUT",
                        previewLabel,
                    });
                }
            }
        }
        return {
            state: "READY",
            reason: null,
            rows,
            extractedText: analyze.content ?? null,
        };
    }
    catch (err) {
        return mapException("analyze_layout", err);
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function bytesToBase64(bytes) {
    // Node 20+ ships Buffer globally on the API runtime — use it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const B = globalThis.Buffer;
    if (B) {
        return B.from(bytes).toString("base64");
    }
    // Bounded fallback for non-Node runtimes (NEVER reached today).
    let binary = "";
    for (let i = 0; i < bytes.length; i++)
        binary += String.fromCharCode(bytes[i]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return globalThis.btoa(binary);
}
function polygonToNormalizedBbox(polygon, size) {
    if (!size || size.width <= 0 || size.height <= 0)
        return null;
    const xs = [];
    const ys = [];
    for (let i = 0; i + 1 < polygon.length; i += 2) {
        xs.push(polygon[i]);
        ys.push(polygon[i + 1]);
    }
    if (xs.length === 0)
        return null;
    const minX = Math.max(0, Math.min(...xs));
    const minY = Math.max(0, Math.min(...ys));
    const maxX = Math.min(size.width, Math.max(...xs));
    const maxY = Math.min(size.height, Math.max(...ys));
    const width = (maxX - minX) / size.width;
    const height = (maxY - minY) / size.height;
    if (width <= 0 || height <= 0)
        return null;
    return {
        x: minX / size.width,
        y: minY / size.height,
        width: Math.min(1 - minX / size.width, width),
        height: Math.min(1 - minY / size.height, height),
    };
}
function mapHttpError(operation, status, body) {
    void body;
    if (status === 429) {
        return {
            state: "RATE_LIMITED",
            reason: `azure_${operation}_rate_limited`,
            rows: [],
            extractedText: null,
        };
    }
    if (status === 401 || status === 403) {
        return {
            state: "NOT_CONFIGURED",
            reason: `azure_${operation}_credentials_rejected`,
            rows: [],
            extractedText: null,
        };
    }
    return {
        state: "ERROR",
        reason: `azure_${operation}_http_${status}`,
        rows: [],
        extractedText: null,
    };
}
function mapException(operation, err) {
    const name = err instanceof Error ? err.name : "UnknownError";
    if (/Throttl|TooManyRequests|429/i.test(name)) {
        return {
            state: "RATE_LIMITED",
            reason: `azure_${operation}_rate_limited`,
            rows: [],
            extractedText: null,
        };
    }
    if (/Unauthorized|Forbidden|401|403/i.test(name)) {
        return {
            state: "NOT_CONFIGURED",
            reason: `azure_${operation}_credentials_rejected`,
            rows: [],
            extractedText: null,
        };
    }
    captureException(err, { operation });
    return {
        state: "ERROR",
        reason: `azure_${operation}_unexpected`,
        rows: [],
        extractedText: null,
    };
}
// ---------------------------------------------------------------------------
// Test helpers — bounded dependency injection for closure tests.
// ---------------------------------------------------------------------------
export function __setTestClient(client) {
    cachedClient = client;
}
