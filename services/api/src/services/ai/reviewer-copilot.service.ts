/**
 * Phase D3 + D4 + D6 — Reviewer Copilot orchestrator.
 *
 * Same safety chain as Case Copilot but with ReviewerCopilotSchema + versioned
 * human-authored review criteria. AI produces observations only; it never
 * writes or infers the final reviewer decision (the schema has no decision
 * field), and no substantive observation is grounded without a valid citation.
 */
import {
  validateCitations,
  type AiCitation,
  type CitationResolver,
} from "./ai-citation.service.js";
import {
  validateCopilotOutput,
  COPILOT_SCHEMA_VERSION,
} from "./ai-copilot-schemas.js";
import {
  buildProhibitedClaimSafeSummary,
  scanTextsForProhibitedClaims,
} from "./prohibited-claims-engine.service.js";
import type { ReviewerContext, EvidenceContext } from "./ai-context-resolver.service.js";
import type { AiPolicyDecision } from "./workspace-ai-policy.service.js";

const ADVISORY_BOUNDARY =
  "AI assistance is advisory only and does not determine truth, authenticity, authorship, identity, intent, liability, fraud, or legal admissibility.";
const NON_PROSE = new Set(["advisoryBoundary", "citations"]);

export type ReviewerCopilotStatus =
  | "ok" | "no_selection" | "policy_denied" | "schema_error" | "blocked_prohibited_claim";

export type ReviewerCopilotResult = {
  status: ReviewerCopilotStatus;
  decision?: string;
  data?: unknown;
  droppedCitations?: number;
  advisoryBoundary: string;
  versionMeta: {
    outputSchemaVersion: string;
    criteriaVersion: string;
    /**
     * WHICH REVISION of each selected record this conclusion was drawn from.
     *
     * This recorded `{ id, version: number | null }` — the package version —
     * so the defensibility record claimed to pin the state behind a conclusion
     * while storing a counter that moved for one of the fourteen fields the
     * model was shown. An opaque revision pins all of them.
     */
    contextObjectRevisions: Array<{ id: string; revision: string }>;
  };
};

export type ReviewerCopilotProvider = (payload: {
  reviewerContext: ReviewerContext;
  selectedEvidence: EvidenceContext[];
  criteriaVersion: string;
}) => Promise<unknown>;

export type RunReviewerCopilotInput = {
  teamId: string;
  reviewerContext: ReviewerContext;
  selectedEvidence: EvidenceContext[];
  /** The analysis revision of each selected record, by id. */
  selectionRevisions: Readonly<Record<string, string>>;
  criteriaVersion: string;
  policyDecision: AiPolicyDecision;
  provider: ReviewerCopilotProvider;
  resolveCitation: CitationResolver;
};

function collectProse(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (NON_PROSE.has(k)) continue;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const i of v) if (typeof i === "string") out.push(i);
  }
  return out;
}

export async function runReviewerCopilot(
  input: RunReviewerCopilotInput,
): Promise<ReviewerCopilotResult> {
  const versionMeta = {
    outputSchemaVersion: COPILOT_SCHEMA_VERSION,
    criteriaVersion: input.criteriaVersion,
    contextObjectRevisions: input.selectedEvidence.map((e) => ({
      id: e.objectId ?? "",
      revision: input.selectionRevisions[e.objectId ?? ""] ?? "",
    })),
  };
  if (input.selectedEvidence.length === 0) {
    return { status: "no_selection", advisoryBoundary: ADVISORY_BOUNDARY, versionMeta };
  }
  if (!input.policyDecision.allowed) {
    return { status: "policy_denied", decision: input.policyDecision.decision, advisoryBoundary: ADVISORY_BOUNDARY, versionMeta };
  }
  const raw = await input.provider({
    reviewerContext: input.reviewerContext,
    selectedEvidence: input.selectedEvidence,
    criteriaVersion: input.criteriaVersion,
  });
  const validated = validateCopilotOutput("REVIEWER", raw);
  if (!validated.ok) return { status: "schema_error", advisoryBoundary: ADVISORY_BOUNDARY, versionMeta };
  const data = validated.data as Record<string, unknown>;

  const prohibited = scanTextsForProhibitedClaims(collectProse(data));
  if (prohibited.length > 0) {
    return {
      status: "blocked_prohibited_claim",
      data: { reviewBrief: buildProhibitedClaimSafeSummary(), blockedCategories: prohibited },
      advisoryBoundary: ADVISORY_BOUNDARY, versionMeta,
    };
  }

  const modelCitations = Array.isArray((data as { citations?: unknown }).citations)
    ? ((data as { citations: Array<Record<string, unknown>> }).citations) : [];
  const nowUtc = new Date().toISOString();
  const full: AiCitation[] = modelCitations.map((c) => ({
    type: c.type as AiCitation["type"], objectId: String(c.objectId ?? ""), displayLabel: String(c.displayLabel ?? ""),
    sourceField: null, objectVersion: typeof c.objectVersion === "number" ? c.objectVersion : null,
    timestampUtc: null, route: String(c.route ?? ""), workspaceId: input.teamId, analyzedAtUtc: nowUtc,
  }));
  const check = await validateCitations(full, { workspaceId: input.teamId }, input.resolveCitation);
  const validIds = new Set(check.valid.map((c) => c.objectId));
  const outputCitations = modelCitations.filter((c) => validIds.has(String(c.objectId)));

  return {
    status: "ok",
    data: { ...data, citations: outputCitations },
    droppedCitations: check.rejected.length,
    advisoryBoundary: ADVISORY_BOUNDARY, versionMeta,
  };
}
