/**
 * Phase D3 — Structured OpenAI provider for Reviewer Copilot (json_schema, store:false).
 */
import OpenAI from "openai";

import { getSecret } from "../../config/runtime-secrets.js";
import { openAiClientPrivacyOptions, openAiRequestStore } from "./provider-privacy.service.js";
import { buildProductKnowledgePromptSection } from "./proovra-product-knowledge.js";
import { UNTRUSTED_DATA_INSTRUCTION } from "./prompt-context-sanitizer.service.js";
import type { ReviewerCopilotProvider } from "./reviewer-copilot.service.js";

const MODEL =
  process.env.OPENAI_REVIEWER_COPILOT_MODEL?.trim() ||
  process.env.OPENAI_MODEL?.trim() ||
  "gpt-4.1-mini";

const strArr = { type: "array", items: { type: "string" } } as const;
const SCHEMA = {
  type: "json_schema" as const,
  name: "proovra_reviewer_copilot",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      reviewBrief: { type: "string" },
      criteriaObservations: strArr,
      missingContext: strArr,
      custodyObservations: strArr,
      verificationSignalObservations: strArr,
      unresolvedQuestions: strArr,
      conflictingMetadata: strArr,
      suggestedChecklist: strArr,
      escalationPreparation: strArr,
      citations: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            type: { type: "string" }, objectId: { type: "string" }, displayLabel: { type: "string" },
            route: { type: "string" }, objectVersion: { type: ["number", "null"] },
          },
          required: ["type", "objectId", "displayLabel", "route", "objectVersion"],
        },
      },
      advisoryBoundary: { type: "string" },
    },
    required: [
      "reviewBrief", "criteriaObservations", "missingContext", "custodyObservations",
      "verificationSignalObservations", "unresolvedQuestions", "conflictingMetadata",
      "suggestedChecklist", "escalationPreparation", "citations", "advisoryBoundary",
    ],
  },
};

const SYSTEM = [
  "You are PROOVRA's Reviewer Copilot — advisory only. You prepare a reviewer; you never make the review decision.",
  "You do NOT determine truth, authenticity, authorship, identity, intent, liability, fraud, or admissibility.",
  "Only use the bounded authorized context + the provided versioned criteria. Do not invent records or capabilities.",
  "Every substantive observation must cite a provided object by objectId/type/route/objectVersion. Do not invent citations or set tenant.",
  buildProductKnowledgePromptSection(),
  UNTRUSTED_DATA_INSTRUCTION,
  'Set advisoryBoundary exactly to: "AI assistance is advisory only and does not determine truth, authenticity, authorship, identity, intent, liability, fraud, or legal admissibility."',
].join(" ");

export class ReviewerCopilotProviderUnavailable extends Error {
  readonly code = "AI_PROVIDER_UNAVAILABLE";
}

export function buildReviewerCopilotProvider(): ReviewerCopilotProvider {
  return async ({ reviewerContext, selectedEvidence, criteriaVersion }) => {
    const apiKey = getSecret("OPENAI_API_KEY")?.trim();
    if (!apiKey || process.env.OPENAI_AI_ENABLED !== "true") {
      throw new ReviewerCopilotProviderUnavailable("OpenAI is not configured/enabled.");
    }
    const client = new OpenAI({ apiKey, ...openAiClientPrivacyOptions() });
    const user = JSON.stringify({
      untrusted_record_data: { review: reviewerContext, selectedEvidence, criteriaVersion },
    });
    const response = await client.responses.create({
      model: MODEL,
      store: openAiRequestStore(),
      input: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
      text: { format: SCHEMA },
      temperature: 0.15,
      max_output_tokens: 1500,
    });
    const text = (response as { output_text?: string }).output_text ?? "";
    try { return JSON.parse(text); } catch { return { _malformed: true }; }
  };
}
