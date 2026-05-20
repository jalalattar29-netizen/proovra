/**
 * Phase 31.21 — capability probes for the two FUTURE local extractor
 * modes (LOCAL_TESSERACT for OCR, LOCAL_WHISPER for transcript).
 *
 * Production today runs INDEX_EXISTING_ONLY by design — neither
 * extractor is enabled. These probes exist so the Operations Center
 * and Reviewer Console can render an explicit NOT_ENABLED state
 * without the platform ever attempting to spawn a heavy local
 * binary.
 *
 * Behavior:
 *   * BOTH probes ALWAYS return `{ ok: false, reason: "not_enabled" }`
 *     today. The module is deliberately a stub; we do NOT load
 *     tesseract, we do NOT load whisper-cpp, we do NOT shell out
 *     to any binary, we do NOT touch the network.
 *   * A future session that activates either mode will replace the
 *     stub body with a real probe (e.g. `await import("tesseract.js")`
 *     for OCR, or a `which whisper-cpp` style check for Whisper).
 *
 * Hard rules:
 *   * NEVER throws.
 *   * NEVER spawns a subprocess.
 *   * NEVER reads evidence bytes.
 *   * NEVER transmits anything off-prem.
 *   * The reason string is bounded (< 80 chars).
 *
 * Deployment impact today:
 *   * Docker image impact: ZERO (no dependencies loaded).
 *   * CPU/GPU impact: ZERO (no extraction runs).
 *   * Privacy impact: ZERO (no external calls).
 */

export type LocalExtractorCapability =
  | { ok: true; engine: "tesseract" | "whisper" }
  | { ok: false; reason: string };

/**
 * Stub probe for LOCAL_TESSERACT OCR mode.
 *
 * To activate in a future session:
 *   1. Add `tesseract.js` (or system tesseract binary) to the worker
 *      deps + Dockerfile. Expect ~50 MB additional image size for
 *      tesseract.js + bundled English language data.
 *   2. Replace the stub body with a real probe (dynamic-import the
 *      package, run a 1x1 image probe, return `{ ok: true }` on
 *      success).
 *   3. Add the OCR producer that calls the engine + writes
 *      `evidence_ocr_text` rows.
 *   4. The existing INDEX_EXISTING_ONLY indexer in
 *      `ocr-transcript-indexer.service.ts` will then pick up those
 *      rows and emit OCR_AVAILABLE / OCR_INDEXED signals.
 */
export async function detectLocalTesseractCapability(): Promise<LocalExtractorCapability> {
  return {
    ok: false,
    reason: "not_enabled",
  };
}

/**
 * Stub probe for LOCAL_WHISPER transcript mode.
 *
 * To activate in a future session:
 *   1. Decide between `whisper-cpp` (system binary, ~50 MB + model
 *      weights ~75 MB for `tiny.en` up to ~3 GB for `large-v3`) or
 *      a smaller subset.
 *   2. Add Dockerfile/runtime steps to bundle the binary + a default
 *      model. CPU-only inference is slow (~10x realtime on small
 *      model); GPU is needed for production-scale workloads.
 *   3. Replace the stub body with a real probe (which-style binary
 *      lookup + version-string check).
 *   4. Add the transcript producer that calls the engine + writes
 *      `evidence_transcript_segments` rows.
 *   5. The existing INDEX_EXISTING_ONLY indexer will then pick up
 *      those rows and emit TRANSCRIPT_AVAILABLE / TRANSCRIPT_INDEXED
 *      signals.
 *
 * Privacy considerations for activation:
 *   * Local Whisper does NOT transmit audio off-prem — but the model
 *     binary itself is large. Operators may prefer to bundle it once
 *     in a base image rather than pull on first use.
 *   * Audio may include voice / PII / sensitive content. A real
 *     producer activation must include a policy that documents
 *     what's transcribed and stored.
 */
export async function detectLocalWhisperCapability(): Promise<LocalExtractorCapability> {
  return {
    ok: false,
    reason: "not_enabled",
  };
}
