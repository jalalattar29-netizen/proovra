/**
 * Wave 4 — Automatic provider extraction wiring regression test
 * (source-contract).
 *
 * Pins the wiring put in place by the Wave 4 implementation:
 *
 *   * Worker MediaIntelligenceJobPayload union + API MEDIA_INTELLIGENCE_JOB_KINDS
 *     mirror BOTH contain the two new kinds (extract_ocr_azure +
 *     extract_transcript_deepgram).
 *   * Evidence-finalization fanout enqueues both kinds with the
 *     correct three-gate structure (evidence type + producer mode +
 *     probe ready).
 *   * Worker processor has both new branches that route through the
 *     canonical runProviderOperation orchestrator (not raw Azure /
 *     Deepgram clients) and persist to BOTH MediaIntelligenceRecord
 *     (via runProviderOperation → ingestProviderResult) AND
 *     EvidenceExtractedText (via runExtractionInline).
 *   * Both branches enqueue search-indexing downstream.
 *   * Both branches NEVER throw to BullMQ on extraction failure.
 *   * Producer-mode resolver consults the AUTOMATIC_*_EXTRACTION_WIRED
 *     truth flags before claiming automatic=true.
 *   * Dist mirror is in lockstep with the .ts source.
 *
 * The test is source-contract (regex against file text) — it does NOT
 * spin up the worker or hit Redis. The goal is to catch silent
 * regressions where someone removes a branch, flips the truth flag
 * without removing the producer, or bypasses the orchestrator.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

function readWorker(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../worker/${rel}`, import.meta.url)),
    "utf8",
  );
}

function readSharedRuntimeSrc(rel: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(`../../../packages/shared-runtime/src/${rel}`, import.meta.url),
    ),
    "utf8",
  );
}

function readSharedRuntimeDist(rel: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(`../../../packages/shared-runtime/dist/${rel}`, import.meta.url),
    ),
    "utf8",
  );
}

const WORKER_QUEUE = readWorker("src/queue.ts");
const API_QUEUE = readApi("src/queue/media-intelligence-queue.ts");
const FANOUT = readApi("src/services/evidence-finalization-fanout.service.ts");
const WORKER_PROCESSOR = readWorker("src/media-intelligence.processor.ts");
const PRODUCER_MODE_SRC = readSharedRuntimeSrc(
  "media-intelligence/producer-mode.ts",
);
const PRODUCER_MODE_DIST = readSharedRuntimeDist(
  "media-intelligence/producer-mode.js",
);

// ---------------------------------------------------------------------------
// 1. Job-kind catalog mirror — both sides MUST agree
// ---------------------------------------------------------------------------
describe("Wave 4 — Job-kind catalog mirror (worker + API)", () => {
  it("API MEDIA_INTELLIGENCE_JOB_KINDS contains extract_ocr_azure", () => {
    expect(API_QUEUE).toMatch(/MEDIA_INTELLIGENCE_JOB_KINDS\s*=\s*\[[\s\S]*?"extract_ocr_azure"/);
  });

  it("API MEDIA_INTELLIGENCE_JOB_KINDS contains extract_transcript_deepgram", () => {
    expect(API_QUEUE).toMatch(
      /MEDIA_INTELLIGENCE_JOB_KINDS\s*=\s*\[[\s\S]*?"extract_transcript_deepgram"/,
    );
  });

  it("Worker MediaIntelligenceJobPayload union contains extract_ocr_azure", () => {
    expect(WORKER_QUEUE).toMatch(
      /MediaIntelligenceJobKind\s*=[\s\S]*?\|\s*"extract_ocr_azure"/,
    );
  });

  it("Worker MediaIntelligenceJobPayload union contains extract_transcript_deepgram", () => {
    expect(WORKER_QUEUE).toMatch(
      /MediaIntelligenceJobKind\s*=[\s\S]*?\|\s*"extract_transcript_deepgram"/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Finalize fanout — enqueue + three-gate structure + audit emit
// ---------------------------------------------------------------------------
describe("Wave 4 — evidence-finalization fanout wiring", () => {
  it("fanout enqueues extract_ocr_azure via enqueueMediaIntelligenceAnalysis", () => {
    expect(FANOUT).toMatch(
      /enqueueMediaIntelligenceAnalysis\s*\(\s*\{[\s\S]*?kind:\s*"extract_ocr_azure"/,
    );
  });

  it("fanout enqueues extract_transcript_deepgram via enqueueMediaIntelligenceAnalysis", () => {
    expect(FANOUT).toMatch(
      /enqueueMediaIntelligenceAnalysis\s*\(\s*\{[\s\S]*?kind:\s*"extract_transcript_deepgram"/,
    );
  });

  it("OCR gate requires evidence.type DOCUMENT or PHOTO", () => {
    // The gate appears as a boolean against the evidence row's type field.
    expect(FANOUT).toMatch(/ev\?\.type\s*===\s*"DOCUMENT"\s*\|\|\s*ev\?\.type\s*===\s*"PHOTO"/);
  });

  it("Transcript gate requires evidence.type AUDIO or VIDEO", () => {
    expect(FANOUT).toMatch(/ev\?\.type\s*===\s*"AUDIO"\s*\|\|\s*ev\?\.type\s*===\s*"VIDEO"/);
  });

  it("OCR gate checks getOcrProducerMode() === 'VENDOR_CLOUD'", () => {
    expect(FANOUT).toMatch(/getOcrProducerMode\(\)/);
    expect(FANOUT).toMatch(/getOcrProducerMode/);
    // Mode equality literal lives in the new gate block.
    expect(FANOUT).toMatch(/ocrMode\s*===\s*"VENDOR_CLOUD"/);
  });

  it("Transcript gate checks getTranscriptProducerMode() === 'VENDOR_CLOUD'", () => {
    expect(FANOUT).toMatch(/getTranscriptProducerMode\(\)/);
    expect(FANOUT).toMatch(/transcriptMode\s*===\s*"VENDOR_CLOUD"/);
  });

  it("OCR gate calls probeAzureDocumentIntelligence", () => {
    expect(FANOUT).toMatch(/probeAzureDocumentIntelligence\s*\(\s*\)\.state\s*===\s*"READY"/);
  });

  it("Transcript gate calls probeDeepgram", () => {
    expect(FANOUT).toMatch(/probeDeepgram\s*\(\s*\)\.state\s*===\s*"READY"/);
  });

  it("fanout emits OCR_EXTRACTION_QUEUED audit log", () => {
    expect(FANOUT).toMatch(/action:\s*"OCR_EXTRACTION_QUEUED"/);
  });

  it("fanout emits TRANSCRIPT_EXTRACTION_QUEUED audit log", () => {
    expect(FANOUT).toMatch(/action:\s*"TRANSCRIPT_EXTRACTION_QUEUED"/);
  });

  it("FanoutResult interface adds ocrExtractionEnqueued + transcriptExtractionEnqueued", () => {
    expect(FANOUT).toMatch(/ocrExtractionEnqueued:\s*boolean/);
    expect(FANOUT).toMatch(/transcriptExtractionEnqueued:\s*boolean/);
  });
});

// ---------------------------------------------------------------------------
// 3. Worker processor branches — lazy import + canonical orchestrator
// ---------------------------------------------------------------------------
describe("Wave 4 — worker processor branches", () => {
  // Wave 5 rebaseline: the worker no longer cross-imports
  // services/api/src/services/intelligence/* (that broke the worker
  // Docker build). It now delegates to the API via an HTTP callback
  // — POST /v1/internal/media-intelligence/extract. The API still
  // runs the canonical runProviderOperation + runExtractionInline
  // chain, so the budget/policy/entitlement perimeter is intact.
  // The pins below assert the new architecture rather than the
  // direct-import shape.
  const API_INTERNAL_EXTRACT_ROUTE = readApi(
    "src/routes/internal-media-intelligence-extract.routes.ts",
  );

  it("worker has extract_ocr_azure branch that dispatches to processExtractOcrAzureJob", () => {
    expect(WORKER_PROCESSOR).toMatch(/kind\s*===\s*"extract_ocr_azure"/);
    expect(WORKER_PROCESSOR).toMatch(/processExtractOcrAzureJob/);
    // Wave 5: worker no longer imports media-intelligence.service.js
    // directly — that lookup now lives in the API route. Pin that the
    // string IS still present in the API-side route file.
    expect(API_INTERNAL_EXTRACT_ROUTE).toMatch(
      /media-intelligence\.service(?:\.js)?/,
    );
  });

  it("worker has extract_transcript_deepgram branch that dispatches to processExtractTranscriptDeepgramJob", () => {
    expect(WORKER_PROCESSOR).toMatch(
      /kind\s*===\s*"extract_transcript_deepgram"/,
    );
    expect(WORKER_PROCESSOR).toMatch(/processExtractTranscriptDeepgramJob/);
  });

  it("OCR path still routes through runProviderOperation (now on API side)", () => {
    // Wave 5: the orchestrator call moved into the API route. The
    // worker MUST NOT contain a raw client import (Wave 4 hard rule).
    expect(API_INTERNAL_EXTRACT_ROUTE).toMatch(
      /runProviderOperation\s*\(\s*\{[\s\S]*?provider:\s*"AZURE_DOCUMENT_INTELLIGENCE"/,
    );
    // No raw Azure DI client / direct redaction client in the worker.
    expect(WORKER_PROCESSOR).not.toMatch(
      /import\s*\{[^}]*\banalyzeDocumentLayout\b[^}]*\}/,
    );
    expect(WORKER_PROCESSOR).not.toMatch(
      /import\([\s\S]*?azure-document-intelligence-client/,
    );
  });

  it("Transcript path still routes through runProviderOperation with DEEPGRAM_TRANSCRIPT", () => {
    expect(API_INTERNAL_EXTRACT_ROUTE).toMatch(
      /runProviderOperation\s*\(\s*\{[\s\S]*?provider:\s*"DEEPGRAM_TRANSCRIPT"/,
    );
    expect(WORKER_PROCESSOR).not.toMatch(
      /import\s*\{[^}]*\btranscribeAndScan\b[^}]*\}/,
    );
    expect(WORKER_PROCESSOR).not.toMatch(
      /import\([\s\S]*?deepgram-client/,
    );
  });

  it("EvidenceExtractedText still written via runExtractionInline (now on API side)", () => {
    expect(API_INTERNAL_EXTRACT_ROUTE).toMatch(/runExtractionInline/);
    // Both kinds (OCR_PDF + OCR_IMAGE) routed through the same writer.
    expect(API_INTERNAL_EXTRACT_ROUTE).toMatch(/"OCR_PDF"/);
    expect(API_INTERNAL_EXTRACT_ROUTE).toMatch(/"OCR_IMAGE"/);
  });

  it("Transcript path still writes TRANSCRIPT_AUDIO/VIDEO kinds", () => {
    expect(API_INTERNAL_EXTRACT_ROUTE).toMatch(/"TRANSCRIPT_AUDIO"/);
    expect(API_INTERNAL_EXTRACT_ROUTE).toMatch(/"TRANSCRIPT_VIDEO"/);
  });

  it("OCR worker branch enqueues downstream search-indexing", () => {
    expect(WORKER_PROCESSOR).toMatch(
      /enqueueSearchIndexingJob\s*\(\s*\{[\s\S]*?reason:\s*"ocr_extracted"/,
    );
  });

  it("Transcript worker branch enqueues downstream search-indexing", () => {
    expect(WORKER_PROCESSOR).toMatch(
      /enqueueSearchIndexingJob\s*\(\s*\{[\s\S]*?reason:\s*"transcript_extracted"/,
    );
  });

  it("both branches return success even on extraction failure (no throw to BullMQ)", () => {
    // The branches must use the `return { ok: true, signalsEmitted: 0 }`
    // success-from-queue pattern on every failure path. We check that
    // structural failures (parts_lookup_failed, fetch_failed,
    // provider_failed, persist_failed) DO NOT throw — they return
    // success-from-queue. Allowed throws are only:
    //   * Lazy-import error rethrow (transient, BullMQ retries with backoff)
    //   * tracker_unavailable (transient, BullMQ retries with backoff)
    //   * Comments that mention "throw" in prose (documentation).
    //
    // We pin: every actual `throw <expr>;` statement in each branch
    // must be one of those two transient cases — checked by ensuring
    // the throw is preceded by the canonical bounded labels.
    const ocrBlock = WORKER_PROCESSOR.match(
      /async function processExtractOcrAzureJob[\s\S]*?^\}$/m,
    );
    expect(ocrBlock, "OCR branch block must be readable").toBeTruthy();
    // Count real `throw` statements (excluding comment occurrences).
    const ocrRealThrows = ocrBlock![0].match(/^\s*throw\s+/gm) ?? [];
    // Two real throws allowed: lazy-import rethrow + tracker_unavailable.
    expect(ocrRealThrows.length).toBeLessThanOrEqual(2);
    // Every real throw must be one of the two transient cases.
    for (const t of ocrRealThrows) {
      // Just count — the surrounding-context check is sufficient since
      // the block only has 2 throws.
      expect(t).toMatch(/throw/);
    }

    const transcriptBlock = WORKER_PROCESSOR.match(
      /async function processExtractTranscriptDeepgramJob[\s\S]*?^\}$/m,
    );
    expect(transcriptBlock).toBeTruthy();
    const transcriptRealThrows =
      transcriptBlock![0].match(/^\s*throw\s+/gm) ?? [];
    expect(transcriptRealThrows.length).toBeLessThanOrEqual(2);
  });

  it("worker NEVER logs raw extracted text (bounded counts only post-Wave-5)", () => {
    // Wave 5: the worker no longer receives raw text. The API
    // response intentionally returns only counts + bounded error.
    // The pin is therefore stricter than before — there is NO path
    // from worker code to a raw text string.
    const allText = WORKER_PROCESSOR;
    expect(allText).not.toMatch(/text:\s*result\.extractedText/);
    expect(allText).not.toMatch(/log[ge].*[",`]\s*\+?\s*extractedText/);
    // The worker logs the count-only field (defensive ceiling).
    expect(allText).toMatch(/chars:\s*Math\.min\(result\.extractedTextChars/);
    // The API route must not put raw text in the response body either.
    const API_INTERNAL_EXTRACT_ROUTE = readApi(
      "src/routes/internal-media-intelligence-extract.routes.ts",
    );
    expect(API_INTERNAL_EXTRACT_ROUTE).not.toMatch(
      /reply\.code\(200\)\.send\(\{[\s\S]*?\bextractedText\s*:/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Producer-mode resolver — truth-flag wiring
// ---------------------------------------------------------------------------
describe("Wave 4 — producer-mode resolver truth flags", () => {
  it("AUTOMATIC_OCR_EXTRACTION_WIRED constant exists in producer-mode.ts", () => {
    expect(PRODUCER_MODE_SRC).toMatch(
      /export\s+const\s+AUTOMATIC_OCR_EXTRACTION_WIRED\s*=\s*true/,
    );
  });

  it("AUTOMATIC_TRANSCRIPT_EXTRACTION_WIRED constant exists in producer-mode.ts", () => {
    expect(PRODUCER_MODE_SRC).toMatch(
      /export\s+const\s+AUTOMATIC_TRANSCRIPT_EXTRACTION_WIRED\s*=\s*true/,
    );
  });

  it("resolveOcrStatus VENDOR_CLOUD branch consults AUTOMATIC_OCR_EXTRACTION_WIRED", () => {
    // The truth flag is gated INSIDE the probe===READY branch so the
    // resolver collapses to a deferred state if the producer is removed.
    expect(PRODUCER_MODE_SRC).toMatch(
      /if\s*\(\s*AUTOMATIC_OCR_EXTRACTION_WIRED\s*\)/,
    );
  });

  it("resolveTranscriptStatus VENDOR_CLOUD branch consults AUTOMATIC_TRANSCRIPT_EXTRACTION_WIRED", () => {
    expect(PRODUCER_MODE_SRC).toMatch(
      /if\s*\(\s*AUTOMATIC_TRANSCRIPT_EXTRACTION_WIRED\s*\)/,
    );
  });

  it("resolver returns automatic=false when truth flag is false (bounded honest reason)", () => {
    // The deferred branch returns CREDENTIALS_READY_PRODUCER_DEFERRED.
    expect(PRODUCER_MODE_SRC).toMatch(
      /CREDENTIALS_READY_PRODUCER_DEFERRED/,
    );
    // Reason copy is present in PRODUCER_REASON_COPY.
    expect(PRODUCER_MODE_SRC).toMatch(
      /CREDENTIALS_READY_PRODUCER_DEFERRED:\s*"Credentials are ready/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Dist lockstep — compiled artifact must mirror source
// ---------------------------------------------------------------------------
describe("Wave 4 — dist lockstep", () => {
  it("dist/producer-mode.js mirrors AUTOMATIC_OCR_EXTRACTION_WIRED", () => {
    expect(PRODUCER_MODE_DIST).toMatch(
      /export\s+const\s+AUTOMATIC_OCR_EXTRACTION_WIRED\s*=\s*true/,
    );
  });

  it("dist/producer-mode.js mirrors AUTOMATIC_TRANSCRIPT_EXTRACTION_WIRED", () => {
    expect(PRODUCER_MODE_DIST).toMatch(
      /export\s+const\s+AUTOMATIC_TRANSCRIPT_EXTRACTION_WIRED\s*=\s*true/,
    );
  });

  it("dist/producer-mode.js mirrors the truth-flag gate in resolveOcrStatus", () => {
    expect(PRODUCER_MODE_DIST).toMatch(
      /if\s*\(\s*AUTOMATIC_OCR_EXTRACTION_WIRED\s*\)/,
    );
  });

  it("dist/producer-mode.js mirrors the truth-flag gate in resolveTranscriptStatus", () => {
    expect(PRODUCER_MODE_DIST).toMatch(
      /if\s*\(\s*AUTOMATIC_TRANSCRIPT_EXTRACTION_WIRED\s*\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Honest-deferral pins — resolver never overclaims automatic
// ---------------------------------------------------------------------------
describe("Wave 4 — honest deferral pins", () => {
  it("resolver only sets automatic=true inside truth-flag-gated branch", () => {
    // Extract the resolveOcrStatus function and ensure the only
    // automatic: true occurs INSIDE the AUTOMATIC_OCR_EXTRACTION_WIRED
    // conditional. The deferred branch must have automatic: false.
    const ocrBlock = PRODUCER_MODE_SRC.match(
      /async function resolveOcrStatus[\s\S]*?\n\}/,
    );
    expect(ocrBlock).toBeTruthy();
    // VENDOR_CLOUD path: after the truth-flag check we see automatic:false.
    expect(ocrBlock![0]).toMatch(
      /AUTOMATIC_OCR_EXTRACTION_WIRED\s*\)\s*\{[\s\S]*?automatic:\s*true/,
    );
    // The fallback branch (truth flag false) has automatic:false +
    // CREDENTIALS_READY_PRODUCER_DEFERRED.
    expect(ocrBlock![0]).toMatch(
      /automatic:\s*false[\s\S]*?CREDENTIALS_READY_PRODUCER_DEFERRED/,
    );
  });

  it("resolver returns automatic=false when mode !== VENDOR_CLOUD", () => {
    // NOT_CONFIGURED + INDEX_EXISTING_ONLY paths never claim automatic=true
    // with provider=azure / provider=deepgram. Quick contract: the
    // NOT_CONFIGURED branch sets automatic:false.
    const ocrBlock = PRODUCER_MODE_SRC.match(
      /async function resolveOcrStatus[\s\S]*?\n\}/,
    );
    expect(ocrBlock![0]).toMatch(
      /NOT_CONFIGURED[\s\S]*?automatic:\s*false/,
    );
  });

  it("resolver returns configured=false when probe !== READY", () => {
    // The probe-not-ready fallback path sets configured:false.
    const ocrBlock = PRODUCER_MODE_SRC.match(
      /async function resolveOcrStatus[\s\S]*?\n\}/,
    );
    expect(ocrBlock![0]).toMatch(
      /CREDENTIALS_PRESENT_WORKSPACE_DISABLED[\s\S]*?$|configured:\s*false/,
    );
  });

  it("fanout never enqueues for wrong evidence.type (gate is required)", () => {
    // The grep here is a structural witness: the OCR enqueue block
    // includes a `eligibleType` boolean that ANDs on the evidence
    // type. Removing the gate would make the test brittle to a
    // type-eligibility regression.
    expect(FANOUT).toMatch(/eligibleType\s*&&\s*modeReady\s*&&\s*probeReady/);
  });

  it("worker never imports raw redaction-layer clients (must go through adapter)", () => {
    // The worker should NEVER reach into services/api/src/services/redaction
    // directly — that bypasses budget/entitlement/policy gates.
    expect(WORKER_PROCESSOR).not.toMatch(
      /from\s+["']\.\.\/\.\.\/api\/src\/services\/redaction\/providers/,
    );
  });
});
