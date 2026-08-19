/**
 * Phase P4 — ONE canonical structured-copilot provider factory.
 *
 * Kills the duplicated OpenAI client/setup between the Case, Reviewer, and
 * Evidence copilot providers: single place for store:false, project/org
 * binding, product-knowledge grounding, untrusted-data fencing, json_schema
 * strict output, and bounded token limits.
 */
import OpenAI from "openai";

import { getSecret } from "../../config/runtime-secrets.js";
import { COPILOT_BOUNDS } from "./ai-copilot-schemas.js";
import { openAiClientPrivacyOptions, openAiRequestStore } from "./provider-privacy.service.js";
import { buildProductKnowledgePromptSection } from "./proovra-product-knowledge.js";
import { UNTRUSTED_DATA_INSTRUCTION } from "./prompt-context-sanitizer.service.js";

export class CopilotProviderUnavailable extends Error {
  readonly code = "AI_PROVIDER_UNAVAILABLE";
}

export const ADVISORY_BOUNDARY_TEXT =
  "AI assistance is advisory only and does not determine truth, authenticity, authorship, identity, intent, liability, fraud, or legal admissibility.";

/**
 * The JSON schema handed to the provider carries the VALIDATOR's bounds.
 *
 * It previously declared unbounded strings and arrays, so the model was told
 * "any length" and then measured against the validator's limits — every
 * thorough answer was produced legally and discarded as SCHEMA_MISMATCH.
 * `objectVersion` was `number` here and `int` in the validator, so a decimal
 * version was another legal-then-rejected shape.
 */
const strArr = {
  type: "array",
  maxItems: COPILOT_BOUNDS.listMaxItems,
  items: { type: "string", maxLength: COPILOT_BOUNDS.listItemMaxChars },
} as const;

export const CITATION_JSON_ITEMS = {
  type: "array",
  maxItems: COPILOT_BOUNDS.citationsMaxItems,
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", maxLength: COPILOT_BOUNDS.citationTypeMaxChars },
      objectId: { type: "string", maxLength: COPILOT_BOUNDS.citationObjectIdMaxChars },
      displayLabel: { type: "string", maxLength: COPILOT_BOUNDS.citationLabelMaxChars },
      route: { type: "string", maxLength: COPILOT_BOUNDS.citationRouteMaxChars },
      objectVersion: { type: ["integer", "null"] },
    },
    required: ["type", "objectId", "displayLabel", "route", "objectVersion"],
  },
} as const;

/** Build a strict json_schema body from string fields + citations + boundary. */
export function buildCopilotJsonSchema(name: string, stringField: string, listFields: string[]) {
  const properties: Record<string, unknown> = {
    [stringField]: { type: "string", maxLength: COPILOT_BOUNDS.summaryMaxChars },
    citations: CITATION_JSON_ITEMS,
    // The validator requires this EXACT sentence; pinning it in the schema too
    // means the model cannot legally return anything else.
    advisoryBoundary: { type: "string", enum: [ADVISORY_BOUNDARY_TEXT] },
  };
  for (const f of listFields) properties[f] = strArr;
  return {
    type: "json_schema" as const,
    name,
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties,
      required: [stringField, ...listFields, "citations", "advisoryBoundary"],
    },
  };
}

export function buildCopilotSystemPrompt(role: string, extra: string[] = []): string {
  return [
    `You are PROOVRA's ${role} — advisory only.`,
    "You do NOT determine truth, authenticity, authorship, identity, intent, liability, fraud, credibility, or legal admissibility.",
    "Only use the bounded authorized context provided. Do not invent records, facts, or capabilities.",
    "Every substantive observation must cite a provided object by objectId, type, route, and objectVersion. Do not invent citations. Do not set workspaceId or tenant.",
    ...extra,
    buildProductKnowledgePromptSection(),
    UNTRUSTED_DATA_INSTRUCTION,
    `Set advisoryBoundary to exactly: "${ADVISORY_BOUNDARY_TEXT}"`,
  ].join(" ");
}

/** Bounded retry policy: ONE retry on 429/5xx transport errors only. NEVER on
 *  schema/policy failures (those are deterministic, retrying wastes budget). */
function isRetryableProviderError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

/** Canonical structured call: returns parsed JSON or { _malformed: true }. */
export function buildStructuredCopilotCall(config: {
  modelEnvVar: string;
  jsonSchema: ReturnType<typeof buildCopilotJsonSchema>;
  system: string;
}) {
  return async (untrustedPayload: unknown): Promise<unknown> => {
    const apiKey = getSecret("OPENAI_API_KEY")?.trim();
    if (!apiKey || process.env.OPENAI_AI_ENABLED !== "true") {
      throw new CopilotProviderUnavailable("OpenAI is not configured/enabled.");
    }
    const model =
      process.env[config.modelEnvVar]?.trim() ||
      process.env.OPENAI_MODEL?.trim() ||
      "gpt-4.1-mini";
    const client = new OpenAI({ apiKey, ...openAiClientPrivacyOptions() });
    const startedAt = Date.now();
    let attempt = 0;
    // Bounded structured telemetry: schema name + latency + attempt + outcome.
    // NEVER payload/prompt/response text.
    const logTelemetry = (outcome: string, extra: Record<string, unknown> = {}) => {
      try {
        // eslint-disable-next-line no-console
        console.info(JSON.stringify({
          kind: "ai.copilot_provider",
          schema: config.jsonSchema.name,
          outcome,
          attempt,
          latencyMs: Date.now() - startedAt,
          ...extra,
        }));
      } catch { /* telemetry best-effort */ }
    };
    for (;;) {
      attempt += 1;
      try {
        const response = await client.responses.create({
          model,
          store: openAiRequestStore(),
          input: [
            { role: "system", content: config.system },
            { role: "user", content: JSON.stringify({ untrusted_record_data: untrustedPayload }) },
          ],
          text: { format: config.jsonSchema },
          temperature: 0.15,
          max_output_tokens: 1500,
        });
        const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
        const text = (response as { output_text?: string }).output_text ?? "";
        try {
          const parsed = JSON.parse(text);
          logTelemetry("ok", { inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null });
          return parsed;
        } catch {
          // Malformed output is a MODEL failure, not transport — no retry.
          logTelemetry("malformed");
          return { _malformed: true };
        }
      } catch (err) {
        if (attempt === 1 && isRetryableProviderError(err)) {
          logTelemetry("retrying", { status: (err as { status?: number })?.status ?? null });
          continue;
        }
        logTelemetry("failed", { status: (err as { status?: number })?.status ?? null });
        throw err;
      }
    }
  };
}
