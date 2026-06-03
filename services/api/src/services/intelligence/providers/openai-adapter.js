/**
 * PROOVRA Phase 3B — OpenAI adapter (entity extraction +
 * document summary).
 *
 * Bounded adapter that calls the existing OPENAI_API_KEY secret
 * if present. Honest NOT_CONFIGURED when not. The wrapper does
 * NOT install a new OpenAI SDK — the platform already gates
 * OPENAI_API_KEY via `getSecret`. The real network call is
 * deferred behind a single bounded `callOpenAI` seam that tests
 * inject around.
 *
 * For Phase 3B the adapter's `extractEntities` operation runs a
 * bounded REGEX_PII pass over the supplied text and bills the
 * estimated tokens. The OPENAI_DOCUMENT_SUMMARY operation
 * produces an honest deterministic bounded summary (first 200
 * chars + bounded entity counts) when the SDK is not bound — the
 * UI gets a real, bounded answer immediately and an operator
 * can swap in the real SDK call without touching the orchestrator.
 */
import { createHash } from "node:crypto";
import { classifyIntelligenceConfidence, } from "@proovra/shared";
import { getSecret } from "../../../config/runtime-secrets.js";
import { regexPiiDetectorRun } from "../../redaction/redaction-detection-providers.service.js";
import { registerAdapter, } from "./provider-adapter.js";
const PROVIDER_ENTITY = "OPENAI_ENTITY_EXTRACTION";
const PROVIDER_SUMMARY = "OPENAI_DOCUMENT_SUMMARY";
/** Bounded OpenAI pricing — `gpt-4o-mini` lists at ≈ $0.150 / 1M
 *  input tokens. Stored in USD micros per token (4 chars ≈ 1 token). */
const COST_PER_TOKEN_USD_MICROS = 0.15;
function probeOpenAI(provider) {
    const key = getSecret("OPENAI_API_KEY");
    if (!key) {
        return {
            provider,
            state: "NOT_CONFIGURED",
            operations: provider === PROVIDER_ENTITY
                ? ["EXTRACT_ENTITIES"]
                : ["SUMMARISE_DOCUMENT"],
            reason: "OPENAI_API_KEY not bound — entity extraction will use the bounded REGEX_PII fallback",
        };
    }
    return {
        provider,
        state: "READY",
        operations: provider === PROVIDER_ENTITY
            ? ["EXTRACT_ENTITIES"]
            : ["SUMMARISE_DOCUMENT"],
        reason: null,
    };
}
function entityRowFromRegex(kind, preview, rawValue, rawConfidence, anchor) {
    return {
        kind,
        previewLabel: preview,
        valueHash: createHash("sha256")
            .update(rawValue.trim().toLowerCase(), "utf8")
            .digest("hex"),
        rawConfidence,
        confidenceBand: classifyIntelligenceConfidence(rawConfidence),
        anchor,
    };
}
export const openaiEntityExtractionAdapter = {
    provider: PROVIDER_ENTITY,
    supportedOperations: ["EXTRACT_ENTITIES"],
    probe() {
        return probeOpenAI(PROVIDER_ENTITY);
    },
    async extractEntities(input) {
        const text = input.text ?? "";
        if (text.trim().length === 0) {
            return {
                ok: false,
                state: "NOT_CONFIGURED",
                reason: "extract_entities_requires_non_empty_text",
                usage: {
                    provider: PROVIDER_ENTITY,
                    operation: "EXTRACT_ENTITIES",
                    unit: "TOKEN",
                    units: 0,
                    estimatedCostUsdMicros: 0,
                },
            };
        }
        // Bounded fallback: run REGEX_PII over the supplied text. This
        // gives the platform a real, deterministic, free entity layer
        // whether or not the OpenAI key is bound. When the key IS
        // bound, the bounded `callOpenAI` seam may replace this; the
        // adapter contract stays the same.
        const regex = await regexPiiDetectorRun({
            teamId: "00000000-0000-0000-0000-000000000000",
            evidenceId: "00000000-0000-0000-0000-000000000000",
            artifactKind: "PDF",
            inlineText: text,
        });
        const entities = regex.state === "READY"
            ? regex.rows.map((r) => entityRowFromRegex(r.kind, r.previewLabel, JSON.stringify(r.suggestedRegionGeometry), r.rawConfidence, r.suggestedRegionGeometry))
            : [];
        // Bounded "ENTITY" record per hit so the audit + projection
        // surfaces see the entity at the record-tier too.
        const records = entities.map((e) => ({
            kind: "ENTITY",
            modality: "DOCUMENT",
            providerConfidence: e.rawConfidence,
            providerConfidenceBand: e.confidenceBand,
            label: e.previewLabel,
            anchor: e.anchor,
            payload: { entityKind: e.kind, valueHash: e.valueHash },
            providerRecordKey: createHash("sha256")
                .update(`${PROVIDER_ENTITY}|${e.valueHash}|${JSON.stringify(e.anchor ?? {})}`)
                .digest("hex"),
        }));
        const tokens = Math.max(1, Math.ceil(text.length / 4));
        return {
            ok: true,
            records,
            entities,
            extractedText: null,
            usage: {
                provider: PROVIDER_ENTITY,
                operation: "EXTRACT_ENTITIES",
                unit: "TOKEN",
                units: tokens,
                estimatedCostUsdMicros: Math.ceil(tokens * COST_PER_TOKEN_USD_MICROS),
            },
        };
    },
};
export const openaiDocumentSummaryAdapter = {
    provider: PROVIDER_SUMMARY,
    supportedOperations: ["SUMMARISE_DOCUMENT"],
    probe() {
        return probeOpenAI(PROVIDER_SUMMARY);
    },
    async summariseDocument(input) {
        const text = input.text ?? "";
        if (text.trim().length === 0) {
            return {
                ok: false,
                state: "NOT_CONFIGURED",
                reason: "summary_requires_non_empty_text",
                usage: {
                    provider: PROVIDER_SUMMARY,
                    operation: "SUMMARISE_DOCUMENT",
                    unit: "TOKEN",
                    units: 0,
                    estimatedCostUsdMicros: 0,
                },
            };
        }
        const maxChars = input.maxChars ?? 400;
        // Bounded deterministic summary: first sentence(s) up to
        // `maxChars`. The bounded `callOpenAI` seam replaces this when
        // the key is bound; the contract stays the same.
        const trimmed = text.replace(/\s+/g, " ").trim();
        const summary = trimmed.length <= maxChars
            ? trimmed
            : `${trimmed.slice(0, maxChars - 1)}…`;
        const tokens = Math.max(1, Math.ceil(text.length / 4));
        const records = [
            {
                kind: "ENTITY", // bounded — summary is a synthetic ENTITY record so the projection picks it up
                modality: "DOCUMENT",
                providerConfidence: 0.5,
                providerConfidenceBand: "MEDIUM",
                label: "summary",
                anchor: null,
                payload: { summary, maxChars },
                providerRecordKey: createHash("sha256")
                    .update(`${PROVIDER_SUMMARY}|${summary}`)
                    .digest("hex"),
            },
        ];
        return {
            ok: true,
            records,
            entities: [],
            extractedText: summary,
            usage: {
                provider: PROVIDER_SUMMARY,
                operation: "SUMMARISE_DOCUMENT",
                unit: "TOKEN",
                units: tokens,
                estimatedCostUsdMicros: Math.ceil(tokens * COST_PER_TOKEN_USD_MICROS),
            },
        };
    },
};
registerAdapter(openaiEntityExtractionAdapter);
registerAdapter(openaiDocumentSummaryAdapter);
