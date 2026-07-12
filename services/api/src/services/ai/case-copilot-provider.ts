/**
 * Phase D1 — Structured OpenAI provider for Case Copilot (json_schema, store:false).
 */
import OpenAI from "openai";

import { getSecret } from "../../config/runtime-secrets.js";
import {
  openAiClientPrivacyOptions,
  openAiRequestStore,
} from "./provider-privacy.service.js";
import { buildProductKnowledgePromptSection } from "./proovra-product-knowledge.js";
import { UNTRUSTED_DATA_INSTRUCTION } from "./prompt-context-sanitizer.service.js";
import type { CaseCopilotProvider } from "./case-copilot.service.js";

const CASE_MODEL =
  process.env.OPENAI_CASE_COPILOT_MODEL?.trim() ||
  process.env.OPENAI_MODEL?.trim() ||
  "gpt-4.1-mini";

const strArr = { type: "array", items: { type: "string" } } as const;
const CASE_JSON_SCHEMA = {
  type: "json_schema" as const,
  name: "proovra_case_copilot",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      caseSummary: { type: "string" },
      timelineHighlights: strArr,
      missingEvidenceCategories: strArr,
      workflowGaps: strArr,
      conflictingMetadata: strArr,
      reviewerPreparation: strArr,
      disclosureChecklist: strArr,
      unresolvedQuestions: strArr,
      citations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string" },
            objectId: { type: "string" },
            displayLabel: { type: "string" },
            route: { type: "string" },
            objectVersion: { type: ["number", "null"] },
          },
          required: ["type", "objectId", "displayLabel", "route", "objectVersion"],
        },
      },
      advisoryBoundary: { type: "string" },
    },
    required: [
      "caseSummary", "timelineHighlights", "missingEvidenceCategories", "workflowGaps",
      "conflictingMetadata", "reviewerPreparation", "disclosureChecklist",
      "unresolvedQuestions", "citations", "advisoryBoundary",
    ],
  },
};

const SYSTEM = [
  "You are PROOVRA's Case Copilot — advisory only.",
  "You do NOT determine truth, authenticity, authorship, identity, intent, liability, fraud, or legal admissibility.",
  "Only use the bounded authorized context provided. Do not invent records, facts, or capabilities.",
  "Every substantive observation must cite an object from the provided context by its objectId, type, route, and objectVersion. Do not invent citations. Do not set workspaceId or tenant.",
  buildProductKnowledgePromptSection(),
  UNTRUSTED_DATA_INSTRUCTION,
  'Set advisoryBoundary to exactly: "AI assistance is advisory only and does not determine truth, authenticity, authorship, identity, intent, liability, fraud, or legal admissibility."',
].join(" ");

export class CaseCopilotProviderUnavailable extends Error {
  readonly code = "AI_PROVIDER_UNAVAILABLE";
}

/** Real structured provider. Throws CaseCopilotProviderUnavailable if unconfigured. */
export function buildCaseCopilotProvider(): CaseCopilotProvider {
  return async ({ caseContext, selectedEvidence }) => {
    const apiKey = getSecret("OPENAI_API_KEY")?.trim();
    if (!apiKey || process.env.OPENAI_AI_ENABLED !== "true") {
      throw new CaseCopilotProviderUnavailable("OpenAI is not configured/enabled.");
    }
    const client = new OpenAI({ apiKey, ...openAiClientPrivacyOptions() });
    const user = JSON.stringify({
      untrusted_record_data: { case: caseContext, selectedEvidence },
    });
    const response = await client.responses.create({
      model: CASE_MODEL,
      store: openAiRequestStore(),
      input: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      text: { format: CASE_JSON_SCHEMA },
      temperature: 0.15,
      max_output_tokens: 1500,
    });
    const text = (response as { output_text?: string }).output_text ?? "";
    try {
      return JSON.parse(text);
    } catch {
      return { _malformed: true };
    }
  };
}
