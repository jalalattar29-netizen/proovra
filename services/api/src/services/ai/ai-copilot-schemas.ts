/**
 * Phase C5 — Structured, versioned Copilot response schemas.
 *
 * Distinct strict zod schemas per Copilot surface. NONE may contain a verdict
 * field (truth/authenticity/authorship/identity/intent/liability/fraud/
 * admissibility/final-decision). A runtime guard proves the forbidden keys are
 * absent from every schema shape. Strict parse → safe fallback on mismatch.
 */
import { z } from "zod";

export const COPILOT_SCHEMA_VERSION = "1.0.0";

const AdvisoryBoundary = z.literal(
  "AI assistance is advisory only and does not determine truth, authenticity, authorship, identity, intent, liability, fraud, or legal admissibility.",
);

const CitationRef = z.object({
  type: z.string().max(40),
  objectId: z.string().max(80),
  displayLabel: z.string().max(200),
  route: z.string().max(200),
  objectVersion: z.number().int().nullable(),
});

const boundedStr = z.string().max(1000);
const boundedList = z.array(z.string().max(600)).max(50);

// Phase P6 — the unused SupportChatSchema was REMOVED: the support chat's
// canonical bounded contract is AiResultSchema (ai-types.ts), enforced end to
// end. Do not reintroduce a parallel chat schema.

export const EvidenceCopilotSchema = z.object({
  operationalSummary: boundedStr,
  missingContext: boundedList,
  integritySignalExplanations: boundedList,
  custodyObservations: boundedList,
  timestampingObservations: boundedList,
  reportReadiness: boundedList,
  packageReadiness: boundedList,
  reviewerPreparation: boundedList,
  workflowGaps: boundedList,
  suggestedNavigation: boundedList,
  suggestedActions: boundedList,
  citations: z.array(CitationRef).max(100),
  advisoryBoundary: AdvisoryBoundary,
});

export const CaseCopilotSchema = z.object({
  caseSummary: boundedStr,
  timelineHighlights: boundedList,
  missingEvidenceCategories: boundedList,
  workflowGaps: boundedList,
  conflictingMetadata: boundedList,
  reviewerPreparation: boundedList,
  disclosureChecklist: boundedList,
  unresolvedQuestions: boundedList,
  citations: z.array(CitationRef).max(200),
  advisoryBoundary: AdvisoryBoundary,
});

export const ReviewerCopilotSchema = z.object({
  reviewBrief: boundedStr,
  criteriaObservations: boundedList,
  missingContext: boundedList,
  custodyObservations: boundedList,
  verificationSignalObservations: boundedList,
  unresolvedQuestions: boundedList,
  conflictingMetadata: boundedList,
  suggestedChecklist: boundedList,
  escalationPreparation: boundedList,
  citations: z.array(CitationRef).max(200),
  advisoryBoundary: AdvisoryBoundary,
});

export const OperationsCopilotSchema = z.object({
  operationalSummary: boundedStr,
  affectedWorkflows: boundedList,
  failureGroups: boundedList,
  queueOrSlaObservations: boundedList,
  configurationGaps: boundedList,
  suggestedActions: boundedList,
  citations: z.array(CitationRef).max(100),
  advisoryBoundary: AdvisoryBoundary,
});

export const COPILOT_SCHEMAS = {
  EVIDENCE: EvidenceCopilotSchema,
  CASE: CaseCopilotSchema,
  REVIEWER: ReviewerCopilotSchema,
  OPERATIONS: OperationsCopilotSchema,
} as const;
export type CopilotSurface = keyof typeof COPILOT_SCHEMAS;

/** Keys that must NEVER appear in any Copilot schema. */
export const FORBIDDEN_SCHEMA_KEYS = [
  "truthScore", "authenticityVerdict", "legalConclusion", "admissibilityDecision",
  "identityInference", "authorshipDecision", "liabilityAssessment", "intentAssessment",
  "fraudDecision", "finalReviewerDecision",
] as const;

/** Enumerate the top-level keys of a Copilot schema (for the forbidden-key guard). */
export function schemaKeys(surface: CopilotSurface): string[] {
  const shape = (COPILOT_SCHEMAS[surface] as z.ZodObject<z.ZodRawShape>).shape;
  return Object.keys(shape);
}

export type CopilotValidation<T> =
  | { ok: true; data: T }
  | { ok: false; fallback: { advisoryBoundary: string; error: "SCHEMA_MISMATCH" } };

/** Strict parse with a safe, bounded fallback (never raw passthrough). */
export function validateCopilotOutput<S extends CopilotSurface>(
  surface: S,
  raw: unknown,
): CopilotValidation<z.infer<(typeof COPILOT_SCHEMAS)[S]>> {
  const parsed = COPILOT_SCHEMAS[surface].safeParse(raw);
  if (parsed.success) {
    return { ok: true, data: parsed.data as z.infer<(typeof COPILOT_SCHEMAS)[S]> };
  }
  return {
    ok: false,
    fallback: {
      advisoryBoundary:
        "AI assistance is advisory only and does not determine truth, authenticity, authorship, identity, intent, liability, fraud, or legal admissibility.",
      error: "SCHEMA_MISMATCH",
    },
  };
}
