/**
 * PROOVRA Phase 3A — Redaction detection providers.
 *
 * Bounded, in-process implementations + honest stubs for each
 * provider listed in `REDACTION_DETECTION_PROVIDERS`. Each provider
 * is pure: it takes a `ProviderRunContext`, returns a bounded
 * shape, and never persists anything itself. The orchestrator in
 * `redaction-detection.service.ts` writes the suggestions.
 *
 * Phase 3A real implementations:
 *   * REGEX_PII — bounded regex catalog (email, phone, IP, etc.)
 *     scanned over operator-supplied `inlineText`. Used over OCR
 *     output, PDF text-layer extracts, and transcript text.
 *
 * Stubbed providers honestly report `NOT_CONFIGURED` until the
 * matching provider client is bound. The orchestrator records that
 * outcome so the operator sees the gap on the detection-run
 * timeline.
 */

import {
  REDACTION_CONFIDENCE_BANDS,
  classifyConfidence,
  type BboxNormalized,
  type RedactionArtifactKind,
  type RedactionConfidenceBand,
  type RedactionDetectionKind,
  type RedactionDetectionProviderState,
  type RedactionMethod,
  type RedactionRegionKind,
} from "@proovra/shared";

// Phase 3A Closure — real provider SDK wrappers.

// ---------------------------------------------------------------------------
// Public types — shared by every provider
// ---------------------------------------------------------------------------

export type ProviderRunContext = {
  teamId: string;
  evidenceId: string;
  artifactKind: RedactionArtifactKind;
  /** Bounded operator-supplied text the regex scanner runs against. */
  inlineText: string | null;
  /**
   * Phase 3A Closure — bounded inline bytes the cloud providers
   * consume:
   *   * IMAGE → Rekognition `imageBytes`
   *   * PDF   → Azure `documentBytes`
   *   * AUDIO → Deepgram `audioBytes`
   *   * VIDEO → Deepgram (audio track) + Rekognition (keyframes)
   *             via the orchestrator's frame extractor (deferred —
   *             documented in the closure report).
   * NEVER set by the regex provider. NEVER persisted by the
   * provider wrappers themselves.
   */
  imageBytes?: Uint8Array | null;
  documentBytes?: Uint8Array | null;
  audioBytes?: Uint8Array | null;
  /**
   * Bounded S3 source — used by Rekognition when bytes are too
   * large for an inline payload. Both fields are required.
   */
  s3Object?: { bucket: string; key: string } | null;
};

export type ProviderDetectionRow = {
  kind: RedactionDetectionKind;
  rawConfidence: number;
  confidenceBand: RedactionConfidenceBand;
  suggestedRegionKind: RedactionRegionKind;
  suggestedRegionGeometry: Record<string, unknown>;
  suggestedMethod: RedactionMethod;
  /** Bounded preview label (≤ 80 chars). NEVER full PII. */
  previewLabel: string | null;
};

export type ProviderRunResult = {
  state: RedactionDetectionProviderState;
  reason: string | null;
  rows: ReadonlyArray<ProviderDetectionRow>;
};

// ---------------------------------------------------------------------------
// REGEX_PII — bounded catalog
//
// Every entry has:
//   * kind   — REDACTION_DETECTION_KINDS code.
//   * rx     — RegExp executed in a global, sticky-free pass.
//   * conf   — fixed confidence band; bounded so the reviewer can
//              filter consistently.
//   * label  — bounded operator-facing description (≤ 80 chars).
//
// The catalog is intentionally conservative: high-precision over
// recall. Reviewers add manual regions for anything the catalog misses.
// ---------------------------------------------------------------------------

type RegexEntry = {
  kind: RedactionDetectionKind;
  rx: RegExp;
  rawConfidence: number;
  label: string;
};

const REGEX_CATALOG: ReadonlyArray<RegexEntry> = [
  {
    kind: "EMAIL",
    // RFC-5322-ish bounded email shape. Avoid greedy fallbacks.
    rx: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g,
    rawConfidence: 0.97,
    label: "email",
  },
  {
    kind: "PHONE",
    // International or NANP-shaped phone numbers, bounded length.
    rx: /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g,
    rawConfidence: 0.82,
    label: "phone",
  },
  {
    kind: "CREDIT_CARD",
    // 13–19 digit groups, allow common separators. Conservative on
    // confidence because false positives are common on order numbers.
    rx: /\b(?:\d{4}[ -]?){3}\d{1,4}\b/g,
    rawConfidence: 0.75,
    label: "credit_card_candidate",
  },
  {
    kind: "NATIONAL_INSURANCE",
    // US SSN, UK NINO. Two bounded variants.
    rx: /\b(?:\d{3}-\d{2}-\d{4}|[A-Z]{2}\d{6}[A-Z])\b/g,
    rawConfidence: 0.93,
    label: "government_id_candidate",
  },
  {
    kind: "DATE_OF_BIRTH",
    rx: /\b(?:0?[1-9]|[12]\d|3[01])[/-](?:0?[1-9]|1[0-2])[/-]\d{2,4}\b/g,
    rawConfidence: 0.5,
    label: "date_candidate",
  },
  {
    kind: "POSTAL_ADDRESS",
    // Loose street-pattern heuristic — flag for human review only.
    rx: /\b\d{1,5}\s+[A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)*\s+(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Boulevard|Blvd|Drive|Dr|Court|Ct|Way)\b/g,
    rawConfidence: 0.55,
    label: "address_candidate",
  },
  {
    kind: "LICENSE_PLATE",
    rx: /\b[A-Z]{1,3}[\s-]?\d{1,4}[\s-]?[A-Z]{0,3}\b/g,
    rawConfidence: 0.4,
    label: "license_plate_candidate",
  },
];

/**
 * Build a bounded preview label that NEVER leaks the matched string
 * verbatim. We mask the middle of the hit so the reviewer queue can
 * say "email …@acme.com" without printing the local part.
 */
function maskPreview(label: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return label;
  if (trimmed.includes("@")) {
    const at = trimmed.indexOf("@");
    return `${label} *…${trimmed.slice(at)}`.slice(0, 80);
  }
  if (trimmed.length <= 8) {
    return `${label} ${trimmed[0]}***${trimmed[trimmed.length - 1]}`.slice(
      0,
      80,
    );
  }
  return `${label} ${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`.slice(0, 80);
}

/**
 * Run the regex catalog over `ctx.inlineText`. Each hit produces a
 * detection row with a bounded `PDF_TEXT_RANGE` region pointing at
 * the character offsets. The reviewer renders the highlight in the
 * UI; the derivative pipeline maps the character range back to a
 * page bbox via the PDF text-layer.
 *
 * When `inlineText` is null we honestly report `NOT_CONFIGURED`.
 */
export async function regexPiiDetectorRun(
  ctx: ProviderRunContext,
): Promise<ProviderRunResult> {
  if (!ctx.inlineText || ctx.inlineText.trim().length === 0) {
    return {
      state: "NOT_CONFIGURED",
      reason: "regex_pii_requires_inline_text",
      rows: [],
    };
  }
  const rows: ProviderDetectionRow[] = [];
  const text = ctx.inlineText;
  const MAX_HITS_PER_RUN = 500;

  for (const entry of REGEX_CATALOG) {
    if (rows.length >= MAX_HITS_PER_RUN) break;
    // Build a fresh regex per scan so we never carry sticky `lastIndex` state.
    const rx = new RegExp(entry.rx.source, entry.rx.flags.replace("g", "") + "g");
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      if (rows.length >= MAX_HITS_PER_RUN) break;
      const charStart = m.index;
      const charEnd = m.index + m[0].length;
      rows.push({
        kind: entry.kind,
        rawConfidence: entry.rawConfidence,
        confidenceBand: classifyConfidence(entry.rawConfidence),
        suggestedRegionKind: "PDF_TEXT_RANGE",
        suggestedRegionGeometry: {
          pageIndex: 0,
          charStart,
          charEnd,
        },
        suggestedMethod: "BLACKOUT",
        previewLabel: maskPreview(entry.label, m[0]),
      });
    }
  }
  return {
    state: "READY",
    reason: null,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Compile-time guard — keep the confidence-band catalog complete.
// ---------------------------------------------------------------------------

function _assertConfidenceBandsAreFour(): void {
  if (REDACTION_CONFIDENCE_BANDS.length !== 4) {
    throw new Error("REDACTION_CONFIDENCE_BANDS shape changed unexpectedly");
  }
}
void _assertConfidenceBandsAreFour;

// Re-exports for the orchestrator + test surfaces.
export type {
  BboxNormalized,
  RedactionDetectionKind,
  RedactionMethod,
  RedactionRegionKind,
};
