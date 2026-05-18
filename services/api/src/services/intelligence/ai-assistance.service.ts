/**
 * Phase 15 — AI reviewer assistance wrapper.
 *
 * Thin governance-aware wrapper around the existing AI provider. Every
 * response:
 *   - MUST be a structured JSON object (string outputs are rejected)
 *   - MUST include the canonical AI advisory disclaimer
 *   - is REJECTED if the model text contains any forbidden phrase
 *     (authenticity / admissibility / "verified" / "fake" claims)
 *
 * Allowed assistance kinds (Phase 15 brief):
 *   - summarize_ocr_text
 *   - summarize_transcript
 *   - suggest_review_attention
 *   - identify_workflow_gaps
 *   - identify_duplicate_likelihood
 *   - generate_operational_summary
 *
 * Forbidden (rejected at output time): authenticity / admissibility /
 * "verified" / "fake" / "manipulated" / deepfake claims.
 */

import {
  AI_ADVISORY_DISCLAIMER,
  INTELLIGENCE_ADVISORY_DISCLAIMER,
  aiResponseContainsForbiddenPhrase,
} from "@proovra/shared";

export const AI_ASSISTANCE_KINDS = [
  "summarize_ocr_text",
  "summarize_transcript",
  "suggest_review_attention",
  "identify_workflow_gaps",
  "identify_duplicate_likelihood",
  "generate_operational_summary",
] as const;
export type AiAssistanceKind = (typeof AI_ASSISTANCE_KINDS)[number];

export type AiAssistanceInput = {
  kind: AiAssistanceKind;
  /** Operator-supplied text payload (OCR / transcript / summary). */
  text: string;
};

export type AiAssistanceResult = {
  kind: AiAssistanceKind;
  enabled: boolean;
  // Structured payload — always an object so the consumer code can
  // treat the response shape as stable.
  summary: string | null;
  highlights: string[];
  cautions: string[];
  disclaimer: string;
};

const SAFE_REFUSAL = (kind: AiAssistanceKind): AiAssistanceResult => ({
  kind,
  enabled: false,
  summary: null,
  highlights: [],
  cautions: [
    "AI assistance is not configured for this workspace.",
    AI_ADVISORY_DISCLAIMER,
  ],
  disclaimer: AI_ADVISORY_DISCLAIMER,
});

const FORBIDDEN_REFUSAL = (kind: AiAssistanceKind): AiAssistanceResult => ({
  kind,
  enabled: true,
  summary: null,
  highlights: [],
  cautions: [
    "The provider response contained wording that PROOVRA cannot present (authenticity, admissibility, or manipulation claims).",
    AI_ADVISORY_DISCLAIMER,
  ],
  disclaimer: AI_ADVISORY_DISCLAIMER,
});

const ENV_FLAG = "OPENAI_AI_ENABLED";

export function isAiAssistanceEnabled(): boolean {
  return process.env[ENV_FLAG] === "true";
}

// -----------------------------------------------------------------------------
// Provider hook — pluggable so tests can inject deterministic responses.
//
// In production, a real wiring would call the existing
// `services/api/src/services/ai/openai-provider.ts` with a system
// prompt that requires JSON-shaped output. For Phase 15 the default
// is a safe no-op that returns "not configured" so the contract
// remains visible without depending on the model.
// -----------------------------------------------------------------------------

export type AiAssistanceProvider = (
  input: AiAssistanceInput,
) => Promise<Pick<AiAssistanceResult, "summary" | "highlights" | "cautions">>;

let activeProvider: AiAssistanceProvider | null = null;

export function setAiAssistanceProvider(
  fn: AiAssistanceProvider | null,
): () => void {
  const prev = activeProvider;
  activeProvider = fn;
  return () => {
    activeProvider = prev;
  };
}

// -----------------------------------------------------------------------------
// Public surface
// -----------------------------------------------------------------------------

const MAX_INPUT_BYTES = 32 * 1024;

export async function requestAiAssistance(
  input: AiAssistanceInput,
): Promise<AiAssistanceResult> {
  if (!isAiAssistanceEnabled() || !activeProvider) {
    return SAFE_REFUSAL(input.kind);
  }
  const text =
    input.text.length > MAX_INPUT_BYTES
      ? input.text.slice(0, MAX_INPUT_BYTES)
      : input.text;

  let raw: Awaited<ReturnType<AiAssistanceProvider>>;
  try {
    raw = await activeProvider({ kind: input.kind, text });
  } catch {
    return {
      kind: input.kind,
      enabled: true,
      summary: null,
      highlights: [],
      cautions: ["AI provider call failed.", AI_ADVISORY_DISCLAIMER],
      disclaimer: AI_ADVISORY_DISCLAIMER,
    };
  }

  // Forbidden-phrase guard. We reject the ENTIRE response if ANY
  // forbidden phrase appears — no whitelist of "ok parts".
  const combined = [
    raw.summary ?? "",
    ...(raw.highlights ?? []),
    ...(raw.cautions ?? []),
  ].join("\n");
  if (aiResponseContainsForbiddenPhrase(combined)) {
    return FORBIDDEN_REFUSAL(input.kind);
  }

  return {
    kind: input.kind,
    enabled: true,
    summary: typeof raw.summary === "string" ? raw.summary : null,
    highlights: Array.isArray(raw.highlights) ? raw.highlights.slice(0, 20) : [],
    cautions: [
      // Always include the canonical disclaimer in the cautions list.
      AI_ADVISORY_DISCLAIMER,
      INTELLIGENCE_ADVISORY_DISCLAIMER,
      ...(Array.isArray(raw.cautions) ? raw.cautions.slice(0, 20) : []),
    ],
    disclaimer: AI_ADVISORY_DISCLAIMER,
  };
}
