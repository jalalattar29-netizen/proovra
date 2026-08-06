/**
 * PROOVRA Phase 3B — "OpenAI" entity-extraction / document-summary
 * adapters.
 *
 * TRUTHFUL STATUS (corrected Phase A1 — AI disclosure truthfulness):
 * these two adapters do NOT make any live OpenAI network call. There
 * is no `callOpenAI` seam in the codebase. `extractEntities` ALWAYS
 * runs a bounded LOCAL REGEX_PII pass and `summariseDocument` ALWAYS
 * returns a bounded LOCAL deterministic truncation — regardless of
 * whether OPENAI_API_KEY is bound. Binding the key does NOT change
 * behaviour. Because no OpenAI capability is operationally wired here,
 * `probeOpenAI` reports NOT_CONFIGURED (never READY) so the Provider
 * Status surface and the AI Disclosure Center do not present a stub as
 * an operational OpenAI binding.
 *
 * The ONLY real, opt-in OpenAI path in the platform is text embeddings,
 * owned separately by
 * services/api/src/services/search/embedding-provider.ts (gated behind
 * SEMANTIC_SEARCH_ENABLED + SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND,
 * both default false). A future phase (B-series) will either wire a
 * real OpenAI call here or rename these to local-fallback adapters.
 */

import { createHash } from "node:crypto";
import {
  classifyIntelligenceConfidence,
  type MediaIntelligenceProvider,
  type ProviderAdapterProbe,
} from "@proovra/shared";

import { regexPiiDetectorRun } from "../../redaction/redaction-detection-providers.service.js";
import {
  registerAdapter,
  type AdapterEntityRow,
  type AdapterRecordRow,
  type IntelligenceProviderResult,
  type ProviderAdapter,
} from "./provider-adapter.js";

// Phase F-8 — new records are labeled with the HONEST local-provider values
// (these operations run a bounded LOCAL fallback, never an OpenAI call).
// Legacy OPENAI_* rows stay read-compatible until the value-rename migration
// (mi_provider_local_value_rename) executes against the real database.
const PROVIDER_ENTITY: MediaIntelligenceProvider = "LOCAL_ENTITY_EXTRACTION";
const PROVIDER_SUMMARY: MediaIntelligenceProvider = "LOCAL_DOCUMENT_SUMMARY";

/** Bounded OpenAI pricing — `gpt-4o-mini` lists at ≈ $0.150 / 1M
 *  input tokens. Stored in USD micros per token (4 chars ≈ 1 token). */
const COST_PER_TOKEN_USD_MICROS = 0.15;

function probeOpenAI(provider: MediaIntelligenceProvider): ProviderAdapterProbe {
  // TRUTHFUL STATUS (Phase A1): no live OpenAI call is wired for these
  // operations — `extractEntities` / `summariseDocument` always run the
  // bounded LOCAL fallback. Binding OPENAI_API_KEY does not change that,
  // so we never report READY (which would falsely imply an operational
  // OpenAI binding). NOT_CONFIGURED is the honest verdict here; OpenAI
  // embeddings are a separate, real, opt-in path in embedding-provider.ts.
  return {
    provider,
    state: "NOT_CONFIGURED",
    operations:
      provider === PROVIDER_ENTITY
        ? ["EXTRACT_ENTITIES"]
        : ["SUMMARISE_DOCUMENT"],
    reason:
      "No live OpenAI call is wired for this operation — output is produced by the bounded local REGEX_PII / deterministic-summary fallback; OpenAI is used only for opt-in text embeddings elsewhere.",
  };
}

function entityRowFromRegex(
  kind: string,
  preview: string | null,
  rawValue: string,
  rawConfidence: number,
  anchor: Record<string, unknown> | null,
): AdapterEntityRow {
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

export const openaiEntityExtractionAdapter: ProviderAdapter = {
  provider: PROVIDER_ENTITY,
  supportedOperations: ["EXTRACT_ENTITIES"],
  probe(): ProviderAdapterProbe {
    return probeOpenAI(PROVIDER_ENTITY);
  },
  async extractEntities(input): Promise<IntelligenceProviderResult> {
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
    const entities: AdapterEntityRow[] =
      regex.state === "READY"
        ? regex.rows.map((r) =>
            entityRowFromRegex(
              r.kind,
              r.previewLabel,
              JSON.stringify(r.suggestedRegionGeometry),
              r.rawConfidence,
              r.suggestedRegionGeometry as Record<string, unknown>,
            ),
          )
        : [];
    // Bounded "ENTITY" record per hit so the audit + projection
    // surfaces see the entity at the record-tier too.
    const records: AdapterRecordRow[] = entities.map((e) => ({
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

export const openaiDocumentSummaryAdapter: ProviderAdapter = {
  provider: PROVIDER_SUMMARY,
  supportedOperations: ["SUMMARISE_DOCUMENT"],
  probe(): ProviderAdapterProbe {
    return probeOpenAI(PROVIDER_SUMMARY);
  },
  async summariseDocument(input): Promise<IntelligenceProviderResult> {
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
    const records: AdapterRecordRow[] = [
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
