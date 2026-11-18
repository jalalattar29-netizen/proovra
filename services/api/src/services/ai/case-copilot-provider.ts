/**
 * Phase P5 — Case Copilot provider = thin wrapper over the ONE canonical
 * structured-copilot factory (no duplicate OpenAI client / schema builder /
 * privacy config; all of that lives in structured-copilot-provider.ts).
 */
import type { CaseCopilotProvider } from "./case-copilot.service.js";
import {
  buildCopilotJsonSchema,
  buildCopilotSystemPrompt,
  buildStructuredCopilotCall,
  CopilotProviderUnavailable,
  type CopilotSpendTracker,
} from "./structured-copilot-provider.js";

export { CopilotProviderUnavailable as CaseCopilotProviderUnavailable };

const CASE_SCHEMA = buildCopilotJsonSchema("proovra_case_copilot", "caseSummary", [
  "timelineHighlights", "missingEvidenceCategories", "workflowGaps", "conflictingMetadata",
  "reviewerPreparation", "disclosureChecklist", "unresolvedQuestions",
]);

const CASE_SYSTEM = buildCopilotSystemPrompt("Case Copilot", [
  "You help prepare ONE case for review using the explicitly selected evidence records provided: timeline highlights, missing evidence categories, workflow gaps, metadata conflicts, reviewer preparation, and disclosure checklists.",
]);

export function buildCaseCopilotProvider(): CaseCopilotProvider & { readonly spend: CopilotSpendTracker } {
  const call = buildStructuredCopilotCall({
    modelEnvVar: "OPENAI_CASE_COPILOT_MODEL",
    jsonSchema: CASE_SCHEMA,
    system: CASE_SYSTEM,
  });
  const provider: CaseCopilotProvider = async ({ caseContext, selectedEvidence }) => call({ case: caseContext, selectedEvidence });
  // RG-05 — the route settles spend from what the provider actually did.
  return Object.assign(provider, { spend: call.spend });
}
