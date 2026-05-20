/**
 * Phase 31.19 — OCR / transcript producer mode.
 *
 * The platform recognises four runtime modes for OCR / transcript
 * extraction:
 *
 *   * `NOT_CONFIGURED` — no vendor configured. The extraction
 *     pipeline still RUNS its idempotent ingestion step: any
 *     pre-existing rows in `evidence_ocr_text` or
 *     `evidence_transcript_segments` (e.g. imported from a legacy
 *     system) are indexed into search. No new OCR / transcript
 *     content is produced. UI surfaces show NOT_CONFIGURED.
 *
 *   * `INDEX_EXISTING_ONLY` — explicit operator opt-in to the
 *     NOT_CONFIGURED behavior, with the operator confirming they
 *     understand no new content will be produced. Effective behavior
 *     identical to NOT_CONFIGURED; the distinction is intent-tracking
 *     for compliance.
 *
 *   * `LOCAL_TESSERACT` / `LOCAL_WHISPER` — placeholder modes for a
 *     future local-model integration. Producers gated on this mode
 *     check `ProducerModeFlag.local` to decide whether to spawn the
 *     local binary.
 *
 *   * `VENDOR_CLOUD` — placeholder for a future cloud-vendor
 *     integration. Producers gated on this mode include explicit
 *     privacy checks: every byte sent off-prem is logged in the
 *     custody journal, and only non-redacted rows are eligible.
 *
 * The mode is read from environment variables. Default is
 * NOT_CONFIGURED so the platform never silently transmits data
 * off-prem.
 *
 * Env vars:
 *   * `OCR_PRODUCER_MODE` — one of the four modes above. Default
 *     NOT_CONFIGURED.
 *   * `TRANSCRIPT_PRODUCER_MODE` — same shape. Default
 *     NOT_CONFIGURED.
 *
 * Hard rules enforced here:
 *   * Unknown / malformed env values collapse to NOT_CONFIGURED.
 *   * The mode getter NEVER throws.
 *   * No secret / token / API key is read from this module — the
 *     producer code paths (when added) own that.
 */

export const OCR_PRODUCER_MODES = [
  "NOT_CONFIGURED",
  "INDEX_EXISTING_ONLY",
  "LOCAL_TESSERACT",
  "VENDOR_CLOUD",
] as const;
export type OcrProducerMode = (typeof OCR_PRODUCER_MODES)[number];

export const TRANSCRIPT_PRODUCER_MODES = [
  "NOT_CONFIGURED",
  "INDEX_EXISTING_ONLY",
  "LOCAL_WHISPER",
  "VENDOR_CLOUD",
] as const;
export type TranscriptProducerMode =
  (typeof TRANSCRIPT_PRODUCER_MODES)[number];

const OCR_MODE_SET = new Set<string>(OCR_PRODUCER_MODES);
const TRANSCRIPT_MODE_SET = new Set<string>(TRANSCRIPT_PRODUCER_MODES);

export function getOcrProducerMode(
  env: NodeJS.ProcessEnv = process.env,
): OcrProducerMode {
  const raw = env.OCR_PRODUCER_MODE;
  if (typeof raw === "string" && OCR_MODE_SET.has(raw)) {
    return raw as OcrProducerMode;
  }
  return "NOT_CONFIGURED";
}

export function getTranscriptProducerMode(
  env: NodeJS.ProcessEnv = process.env,
): TranscriptProducerMode {
  const raw = env.TRANSCRIPT_PRODUCER_MODE;
  if (typeof raw === "string" && TRANSCRIPT_MODE_SET.has(raw)) {
    return raw as TranscriptProducerMode;
  }
  return "NOT_CONFIGURED";
}

/**
 * Combined mode summary suitable for the Ops Center / Reviewer
 * Intelligence Console capability tile.
 *
 * The summary is a flat object so it can be serialized to JSON
 * directly and stay backwards-compatible — adding a new mode
 * appends an enum value to the type union but doesn't break the
 * response shape.
 */
export type ProducerModeSummary = {
  ocr: OcrProducerMode;
  transcript: TranscriptProducerMode;
  /** True when both modes resolve to a producing state (i.e. NOT
   *  one of NOT_CONFIGURED / INDEX_EXISTING_ONLY). */
  producesNewContent: boolean;
};

export function summariseProducerModes(
  env: NodeJS.ProcessEnv = process.env,
): ProducerModeSummary {
  const ocr = getOcrProducerMode(env);
  const transcript = getTranscriptProducerMode(env);
  const producesNewContent =
    ocr !== "NOT_CONFIGURED" &&
    ocr !== "INDEX_EXISTING_ONLY" &&
    transcript !== "NOT_CONFIGURED" &&
    transcript !== "INDEX_EXISTING_ONLY";
  return { ocr, transcript, producesNewContent };
}
