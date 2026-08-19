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

/** Which bound a rejected response broke — for safe telemetry, never for the user. */
export type CopilotValidationCategory =
  | "MALFORMED_JSON"
  | "MISSING_FIELD"
  | "TOO_LONG"
  | "WRONG_TYPE"
  | "BOUNDARY_TEXT"
  | "OTHER";

/**
 * Classify a zod failure into a bounded category.
 *
 * A category is safe to log: it names the CONTRACT that broke, never the model
 * text, the prompt or any evidence field.
 */
export function classifyValidationFailure(issues: z.ZodIssue[]): CopilotValidationCategory {
  for (const i of issues) {
    if (i.path.join(".") === "advisoryBoundary") return "BOUNDARY_TEXT";
  }
  for (const i of issues) {
    if (i.code === "too_big") return "TOO_LONG";
    if (i.code === "invalid_type" && /required|undefined/i.test(i.message)) return "MISSING_FIELD";
  }
  for (const i of issues) {
    if (i.code === "invalid_type") return "WRONG_TYPE";
  }
  return "OTHER";
}

/**
 * THE OUTPUT BOUNDS — one definition, shared by the validator AND the JSON
 * schema handed to the provider.
 *
 * They used to exist only here. The provider schema declared
 * `{ type: "string" }` with no `maxLength` and `{ type: "array" }` with no
 * `maxItems`, so the model was told "any length" and then checked against
 * "at most 1000 characters". A thorough operational summary is longer than
 * that, so the response was valid against the schema the model was given and
 * invalid against the schema it was measured with — and every such run was
 * discarded as SCHEMA_MISMATCH. Exporting the numbers is what keeps the prompt,
 * the provider call and the validator on one contract.
 */
export const COPILOT_BOUNDS = {
  summaryMaxChars: 1000,
  listItemMaxChars: 600,
  listMaxItems: 50,
  citationsMaxItems: 100,
  citationTypeMaxChars: 40,
  citationObjectIdMaxChars: 80,
  citationLabelMaxChars: 200,
  citationRouteMaxChars: 200,
} as const;

const boundedStr = z.string().max(COPILOT_BOUNDS.summaryMaxChars);
const boundedList = z
  .array(z.string().max(COPILOT_BOUNDS.listItemMaxChars))
  .max(COPILOT_BOUNDS.listMaxItems);

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
  | {
      ok: false;
      /** Bounded, non-sensitive reason the response was rejected. */
      category: CopilotValidationCategory;
      /** True when a single re-ask could plausibly fix it (formatting/shape). */
      repairable: boolean;
      fallback: { advisoryBoundary: string; error: "SCHEMA_MISMATCH" };
    };

/** Strict parse with a safe, bounded fallback (never raw passthrough). */
export function validateCopilotOutput<S extends CopilotSurface>(
  surface: S,
  raw: unknown,
): CopilotValidation<z.infer<(typeof COPILOT_SCHEMAS)[S]>> {
  const parsed = COPILOT_SCHEMAS[surface].safeParse(raw);
  if (parsed.success) {
    return { ok: true, data: parsed.data as z.infer<(typeof COPILOT_SCHEMAS)[S]> };
  }
  const category =
    raw && typeof raw === "object" && (raw as { _malformed?: boolean })._malformed
      ? "MALFORMED_JSON"
      : classifyValidationFailure(parsed.error.issues);
  return {
    ok: false,
    category,
    // Formatting and shape failures are worth ONE re-ask. A prohibited claim is
    // not a formatting problem and never reaches here — it is caught after a
    // SUCCESSFUL parse and is never retried into acceptance.
    repairable: category !== "OTHER",
    fallback: {
      advisoryBoundary:
        "AI assistance is advisory only and does not determine truth, authenticity, authorship, identity, intent, liability, fraud, or legal admissibility.",
      error: "SCHEMA_MISMATCH",
    },
  };
}
