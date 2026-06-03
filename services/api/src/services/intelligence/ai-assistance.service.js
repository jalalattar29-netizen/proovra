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
import { AI_ADVISORY_DISCLAIMER, INTELLIGENCE_ADVISORY_DISCLAIMER, aiResponseContainsForbiddenPhrase, } from "@proovra/shared";
export const AI_ASSISTANCE_KINDS = [
    "summarize_ocr_text",
    "summarize_transcript",
    "suggest_review_attention",
    "identify_workflow_gaps",
    "identify_duplicate_likelihood",
    "generate_operational_summary",
];
const SAFE_REFUSAL = (kind) => ({
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
const FORBIDDEN_REFUSAL = (kind) => ({
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
export function isAiAssistanceEnabled() {
    return process.env[ENV_FLAG] === "true";
}
let activeProvider = null;
export function setAiAssistanceProvider(fn) {
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
export async function requestAiAssistance(input) {
    if (!isAiAssistanceEnabled() || !activeProvider) {
        return SAFE_REFUSAL(input.kind);
    }
    const text = input.text.length > MAX_INPUT_BYTES
        ? input.text.slice(0, MAX_INPUT_BYTES)
        : input.text;
    let raw;
    try {
        raw = await activeProvider({ kind: input.kind, text });
    }
    catch {
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
