/**
 * PV-LANG-003 — product words for stored identifiers that more than one
 * workspace operations surface renders (Budget Center, Intelligence Quality,
 * the intelligence records panel). A value this build does not know still
 * reads as words through `identifierLabel`, never as the raw key.
 */

import { identifierLabel } from "@proovra/shared";

/**
 * MediaIntelligenceProvider → the name an operator recognises.
 *
 * The OPENAI_* values are legacy spellings of the LOCAL_* paths: those
 * operations never called OpenAI (see the Phase F-8 note on
 * MEDIA_INTELLIGENCE_PROVIDERS), so they must not read as an OpenAI provider.
 */
const INTELLIGENCE_PROVIDER_LABEL: Readonly<Record<string, string>> = {
  AZURE_DOCUMENT_INTELLIGENCE: "Azure Document Intelligence",
  AWS_REKOGNITION_FACES: "Amazon Rekognition (faces)",
  AWS_REKOGNITION_TEXT: "Amazon Rekognition (text)",
  AWS_REKOGNITION_LABELS: "Amazon Rekognition (labels)",
  DEEPGRAM_TRANSCRIPT: "Deepgram transcription",
  LOCAL_ENTITY_EXTRACTION: "Built-in entity extraction",
  LOCAL_DOCUMENT_SUMMARY: "Built-in document summary",
  OPENAI_ENTITY_EXTRACTION: "Built-in entity extraction (legacy record)",
  OPENAI_DOCUMENT_SUMMARY: "Built-in document summary (legacy record)",
  MANUAL_OPERATOR: "Entered by an operator",
};

export function intelligenceProviderLabel(provider: string): string {
  return INTELLIGENCE_PROVIDER_LABEL[provider] ?? identifierLabel(provider);
}
