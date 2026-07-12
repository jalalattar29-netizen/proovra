/**
 * Phase P5 — Reviewer Copilot provider = thin wrapper over the ONE canonical
 * structured-copilot factory (no duplicate client/schema/privacy code).
 */
import type { ReviewerCopilotProvider } from "./reviewer-copilot.service.js";
import {
  buildCopilotJsonSchema,
  buildCopilotSystemPrompt,
  buildStructuredCopilotCall,
  CopilotProviderUnavailable,
} from "./structured-copilot-provider.js";

export { CopilotProviderUnavailable as ReviewerCopilotProviderUnavailable };

const REVIEWER_SCHEMA = buildCopilotJsonSchema("proovra_reviewer_copilot", "reviewBrief", [
  "criteriaObservations", "missingContext", "custodyObservations", "verificationSignalObservations",
  "unresolvedQuestions", "conflictingMetadata", "suggestedChecklist", "escalationPreparation",
]);

const REVIEWER_SYSTEM = buildCopilotSystemPrompt("Reviewer Copilot", [
  "You prepare a human reviewer; you never make or pre-fill the review decision.",
  "Ground every observation in the selected evidence contexts and the provided versioned, human-authored criteria.",
]);

export function buildReviewerCopilotProvider(): ReviewerCopilotProvider {
  const call = buildStructuredCopilotCall({
    modelEnvVar: "OPENAI_REVIEWER_COPILOT_MODEL",
    jsonSchema: REVIEWER_SCHEMA,
    system: REVIEWER_SYSTEM,
  });
  return async ({ reviewerContext, selectedEvidence, criteriaVersion }) =>
    call({ review: reviewerContext, selectedEvidence, criteriaVersion });
}
