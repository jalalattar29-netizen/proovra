/**
 * Phase D1 + D2 — Case Copilot orchestrator.
 *
 * The real end-to-end Copilot flow, dependency-injected so the orchestration is
 * behaviourally testable without a live LLM/DB:
 *
 *   selected evidence (D2, explicit) → workspace AI policy (CASE_COPILOT) →
 *   C3 authorized context → structured provider call → C5 schema validation →
 *   A5 prohibited-claims filter → C4 citation validation (drop invalid) → result
 *
 * Never processes the whole case: at least one explicitly-selected, authorized
 * evidence record is required. Produces no legal/forensic conclusion (the C5
 * schema carries no verdict fields) and no observation is presented as grounded
 * without a server-validated citation.
 */
import type {
  CaseContext,
  EvidenceContext,
} from "./ai-context-resolver.service.js";
import {
  validateCitations,
  type AiCitation,
  type CitationResolver,
} from "./ai-citation.service.js";
import {
  validateCopilotOutput,
  COPILOT_SCHEMA_VERSION,
} from "./ai-copilot-schemas.js";
import { scanTextsForProhibitedClaims } from "./prohibited-claims-engine.service.js";
import { buildProhibitedClaimSafeSummary } from "./prohibited-claims-engine.service.js";
import type { AiPolicyDecision } from "./workspace-ai-policy.service.js";

export type CaseCopilotStatus =
  | "ok"
  | "no_selection"
  | "policy_denied"
  | "schema_error"
  | "blocked_prohibited_claim";

export type CaseCopilotResult = {
  status: CaseCopilotStatus;
  decision?: string;
  data?: unknown;
  droppedCitations?: number;
  advisoryBoundary: string;
  versionMeta: {
    outputSchemaVersion: string;
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

const ADVISORY_BOUNDARY =
  "AI assistance is advisory only and does not determine truth, authenticity, authorship, identity, intent, liability, fraud, or legal admissibility.";

/** Structured provider call: returns raw JSON to be schema-validated. */
export type CaseCopilotProvider = (payload: {
  caseContext: CaseContext;
  selectedEvidence: EvidenceContext[];
}) => Promise<unknown>;

export type RunCaseCopilotInput = {
  teamId: string;
  caseContext: CaseContext;
  /** D2 — explicitly selected, already-authorized evidence contexts. */
  selectedEvidence: EvidenceContext[];
  /**
   * The analysis revision of each selected record, by id.
   *
   * Supplied by the route from the FROZEN snapshot it validated, rather than
   * re-derived here from the context object: the run must record the exact
   * revision that was accepted, not one recomputed from a partial view.
   */
  selectionRevisions: Readonly<Record<string, string>>;
  policyDecision: AiPolicyDecision;
  provider: CaseCopilotProvider;
  resolveCitation: CitationResolver;
};

// Keys that are server-controlled fixed strings (the advisory disclaimer) or
// structured objects — NOT model prose — and must not be claim-scanned.
const NON_PROSE_KEYS = new Set(["advisoryBoundary", "citations"]);

function collectText(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, v] of Object.entries(data)) {
    if (NON_PROSE_KEYS.has(key)) continue;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const i of v) if (typeof i === "string") out.push(i);
  }
  return out;
}

export async function runCaseCopilot(
  input: RunCaseCopilotInput,
): Promise<CaseCopilotResult> {
  const versionMeta = {
    outputSchemaVersion: COPILOT_SCHEMA_VERSION,
    contextObjectRevisions: input.selectedEvidence.map((e) => ({
      id: e.objectId ?? "",
      revision: input.selectionRevisions[e.objectId ?? ""] ?? "",
    })),
  };

  // D2 — never process the whole case; require explicit selection.
  if (input.selectedEvidence.length === 0) {
    return { status: "no_selection", advisoryBoundary: ADVISORY_BOUNDARY, versionMeta };
  }

  // Workspace AI policy gate (CASE_COPILOT). Fail-closed, no provider call.
  if (!input.policyDecision.allowed) {
    return {
      status: "policy_denied",
      decision: input.policyDecision.decision,
      advisoryBoundary: ADVISORY_BOUNDARY,
      versionMeta,
    };
  }

  const raw = await input.provider({
    caseContext: input.caseContext,
    selectedEvidence: input.selectedEvidence,
  });

  // C5 — strict schema validation with safe fallback.
  const validated = validateCopilotOutput("CASE", raw);
  if (!validated.ok) {
    return { status: "schema_error", advisoryBoundary: ADVISORY_BOUNDARY, versionMeta };
  }
  const data = validated.data as Record<string, unknown>;

  // A5 — prohibited-claims filter over all output text.
  const prohibited = scanTextsForProhibitedClaims(collectText(data));
  if (prohibited.length > 0) {
    return {
      status: "blocked_prohibited_claim",
      data: { caseSummary: buildProhibitedClaimSafeSummary(), blockedCategories: prohibited },
      advisoryBoundary: ADVISORY_BOUNDARY,
      versionMeta,
    };
  }

  // C4 — server-validate citations; drop any that fail (fail-closed grounding).
  // The SERVER injects workspaceId + analyzedAt: the model may reference an
  // object id/version/route, but it can never assert which tenant it belongs
  // to — the resolver confirms the real workspace + authorization + version.
  const modelCitations = Array.isArray((data as { citations?: unknown }).citations)
    ? ((data as { citations: Array<Record<string, unknown>> }).citations)
    : [];
  const nowUtc = new Date().toISOString();
  const fullCitations: AiCitation[] = modelCitations.map((c) => ({
    type: c.type as AiCitation["type"],
    objectId: String(c.objectId ?? ""),
    displayLabel: String(c.displayLabel ?? ""),
    sourceField: null,
    objectVersion: typeof c.objectVersion === "number" ? c.objectVersion : null,
    timestampUtc: null,
    route: String(c.route ?? ""),
    workspaceId: input.teamId,
    analyzedAtUtc: nowUtc,
  }));
  const citationCheck = await validateCitations(
    fullCitations,
    { workspaceId: input.teamId },
    input.resolveCitation,
  );
  const validIds = new Set(citationCheck.valid.map((c) => c.objectId));
  const outputCitations = modelCitations.filter((c) => validIds.has(String(c.objectId)));
  const grounded = { ...data, citations: outputCitations };

  return {
    status: "ok",
    data: grounded,
    droppedCitations: citationCheck.rejected.length,
    advisoryBoundary: ADVISORY_BOUNDARY,
    versionMeta,
  };
}
