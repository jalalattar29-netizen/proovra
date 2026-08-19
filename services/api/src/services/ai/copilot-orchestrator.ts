/**
 * Phase P4 — ONE generic grounded-copilot orchestration (zero-duplication).
 *
 * The shared safety chain used by the Case, Reviewer, and Evidence copilots:
 *   explicit selection → workspace policy gate → structured provider →
 *   strict schema (C5) → prohibited-claims filter (A5) → server-tenant
 *   citation validation (C4, drop invalid) → bounded result.
 */
import {
  validateCitations,
  type AiCitation,
  type CitationResolver,
} from "./ai-citation.service.js";
import {
  validateCopilotOutput,
  COPILOT_SCHEMA_VERSION,
  type CopilotSurface,
} from "./ai-copilot-schemas.js";
import {
  buildProhibitedClaimSafeSummary,
  scanTextsForProhibitedClaims,
} from "./prohibited-claims-engine.service.js";
import { ADVISORY_BOUNDARY_TEXT } from "./structured-copilot-provider.js";
import type { AiPolicyDecision } from "./workspace-ai-policy.service.js";

const NON_PROSE = new Set(["advisoryBoundary", "citations"]);

/**
 * Bounded validation telemetry: WHICH contract broke, on which surface, at
 * which attempt. Never the prompt, the evidence, or the discarded output.
 */
function logCopilotValidation(surface: string, category: string, attempt: number): void {
  try {
    // eslint-disable-next-line no-console
    console.info(
      JSON.stringify({ kind: "ai.copilot_validation", surface, category, attempt }),
    );
  } catch {
    /* telemetry is best-effort */
  }
}

export type GroundedCopilotStatus =
  | "ok"
  | "no_selection"
  | "policy_denied"
  | "schema_error"
  | "blocked_prohibited_claim";

export type GroundedCopilotResult = {
  status: GroundedCopilotStatus;
  decision?: string;
  data?: unknown;
  /** Bounded reason a response was rejected. Safe to log; never model text. */
  validationCategory?: string;
  droppedCitations?: number;
  advisoryBoundary: string;
  versionMeta: {
    outputSchemaVersion: string;
    criteriaVersion?: string;
    contextObjectVersions: Array<{ id: string; version: number | null }>;
  };
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

export async function runGroundedCopilot(input: {
  surface: CopilotSurface;
  teamId: string;
  /** Explicitly selected object contexts (D2 — never the whole case). */
  selectionVersions: Array<{ id: string; version: number | null }>;
  requireSelection: boolean;
  criteriaVersion?: string;
  policyDecision: AiPolicyDecision;
  callProvider: () => Promise<unknown>;
  resolveCitation: CitationResolver;
  /** Safe-rewrite field name used when a prohibited claim is blocked. */
  summaryField: string;
}): Promise<GroundedCopilotResult> {
  const versionMeta = {
    outputSchemaVersion: COPILOT_SCHEMA_VERSION,
    ...(input.criteriaVersion ? { criteriaVersion: input.criteriaVersion } : {}),
    contextObjectVersions: input.selectionVersions,
  };
  if (input.requireSelection && input.selectionVersions.length === 0) {
    return { status: "no_selection", advisoryBoundary: ADVISORY_BOUNDARY_TEXT, versionMeta };
  }
  if (!input.policyDecision.allowed) {
    return {
      status: "policy_denied",
      decision: input.policyDecision.decision,
      advisoryBoundary: ADVISORY_BOUNDARY_TEXT,
      versionMeta,
    };
  }
  let raw = await input.callProvider();
  let validated = validateCopilotOutput(input.surface, raw);

  // ONE bounded repair attempt, for FORMATTING and SHAPE failures only.
  //
  // A prohibited claim never reaches here — it is detected after a SUCCESSFUL
  // parse, below, and is never retried into acceptance. The repair carries no
  // model text and no evidence: it is the same request again, and the second
  // answer is validated by exactly the same schema.
  if (!validated.ok && validated.repairable) {
    logCopilotValidation(input.surface, validated.category, 1);
    raw = await input.callProvider();
    validated = validateCopilotOutput(input.surface, raw);
  }

  if (!validated.ok) {
    logCopilotValidation(input.surface, validated.category, 2);
    return {
      status: "schema_error",
      // The CATEGORY only — never the discarded model output.
      validationCategory: validated.category,
      advisoryBoundary: ADVISORY_BOUNDARY_TEXT,
      versionMeta,
    };
  }
  const data = validated.data as Record<string, unknown>;

  const prohibited = scanTextsForProhibitedClaims(collectProse(data));
  if (prohibited.length > 0) {
    return {
      status: "blocked_prohibited_claim",
      data: { [input.summaryField]: buildProhibitedClaimSafeSummary(), blockedCategories: prohibited },
      advisoryBoundary: ADVISORY_BOUNDARY_TEXT,
      versionMeta,
    };
  }

  // C4 — server injects tenant; validate; drop invalid; keep model shape.
  const modelCitations = Array.isArray((data as { citations?: unknown }).citations)
    ? ((data as { citations: Array<Record<string, unknown>> }).citations)
    : [];
  const nowUtc = new Date().toISOString();
  const full: AiCitation[] = modelCitations.map((c) => ({
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
  const check = await validateCitations(full, { workspaceId: input.teamId }, input.resolveCitation);
  const validIds = new Set(check.valid.map((c) => c.objectId));
  const outputCitations = modelCitations.filter((c) => validIds.has(String(c.objectId)));

  return {
    status: "ok",
    data: { ...data, citations: outputCitations },
    droppedCitations: check.rejected.length,
    advisoryBoundary: ADVISORY_BOUNDARY_TEXT,
    versionMeta,
  };
}
