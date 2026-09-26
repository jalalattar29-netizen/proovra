/**
 * AI COPILOTS (T-15) — shared reading of the evidence and case copilot runs:
 * the native port of `EvidenceCopilotPanel.tsx`, `CaseCopilotPanel.tsx` and
 * `CopilotCitation.tsx` (apps/web/components/ai-copilot).
 *
 *   POST /v1/ai/evidence/:id/copilot { evidenceRevision, processingMode:"METADATA_ONLY", idempotencyKey }
 *        → { data: RunResult, serverActions[] }
 *
 * ADVISORY ONLY. The run is refused client-side (not sent) without the
 * server-computed analysis revision. Only server-validated citations render,
 * each linked only through a SAFE server route mapped to a native screen.
 * A schema-invalid answer is discarded and never shown. Suggested actions run
 * only after an explicit confirmation, through the existing audited endpoint.
 */
export function buildEvidenceCopilotPath(evidenceId: string): string {
  return `/v1/ai/evidence/${encodeURIComponent(evidenceId)}/copilot`;
}

export interface CopilotCitation {
  type: string;
  typeLabel: string;
  label: string;
  /** Native destination, or null when the server route has no native screen. */
  nativeRoute: string | null;
}
export interface ServerAction {
  suggestionId: string;
  actionType: string;
  displayLabel: string;
  reason: string;
  /** The intent the proposed change carries (GENERATE / RETRY / RECOVER), when it carries one. */
  intent: "GENERATE" | "RETRY" | "RECOVER" | null;
}
export type CopilotOutcome =
  | { kind: "result"; summary: string; sections: Array<{ label: string; items: string[] }>; citations: CopilotCitation[]; droppedCitations: number; advisoryBoundary: string }
  | { kind: "provider_unavailable" }
  | { kind: "policy_denied"; decision: string }
  | { kind: "schema_error" }
  | { kind: "no_selection" }
  | { kind: "blocked" };

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

const CITATION_TYPE_LABEL: Record<string, string> = {
  EVIDENCE_RECORD: "Evidence",
  CASE: "Case",
  CUSTODY_EVENT: "Custody",
  VERIFICATION_SIGNAL: "Signal",
  REVIEW_ASSIGNMENT: "Assignment",
  REVIEW_DECISION: "Decision",
  REPORT: "Report",
  VERIFICATION_PACKAGE: "Package",
  POLICY: "Policy",
  WORKFLOW_STATUS: "Workflow",
};
const SAFE_ROUTE = /^\/[a-z0-9/_:.[\]-]*$/i;

/** The web's server route mapped onto a native screen; anything else is shown unlinked. */
export function citationNativeRoute(route: string | null): string | null {
  if (!route || !SAFE_ROUTE.test(route)) return null;
  const ev = /^\/evidence\/([0-9a-f-]{8,})(?:[/?#].*)?$/i.exec(route);
  if (ev) return `/evidence/${ev[1]}`;
  const cs = /^\/cases\/([0-9a-f-]{8,})(?:[/?#].*)?$/i.exec(route);
  if (cs) return `/case/${cs[1]}`;
  return null;
}

export function parseCitations(v: unknown): CopilotCitation[] {
  const out: CopilotCitation[] = [];
  for (const raw of Array.isArray(v) ? v : []) {
    const c = o(raw);
    const type = s(c["type"]) ?? "";
    const version = typeof c["objectVersion"] === "number" ? (c["objectVersion"] as number) : null;
    out.push({
      type,
      typeLabel: CITATION_TYPE_LABEL[type] ?? "Source",
      label: `${s(c["displayLabel"]) ?? ""}${version != null ? ` · v${version}` : ""}`,
      nativeRoute: citationNativeRoute(s(c["route"])),
    });
  }
  return out;
}

export const EVIDENCE_COPILOT_SECTIONS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "missingContext", label: "Missing context" },
  { key: "integritySignalExplanations", label: "Integrity signals (explained)" },
  { key: "custodyObservations", label: "Custody observations" },
  { key: "timestampingObservations", label: "Timestamping (TSA / OTS)" },
  { key: "reportReadiness", label: "Report readiness" },
  { key: "packageReadiness", label: "Verification Package readiness" },
  { key: "reviewerPreparation", label: "Reviewer preparation" },
  { key: "workflowGaps", label: "Workflow gaps" },
  { key: "suggestedNavigation", label: "Where to look next" },
  { key: "suggestedActions", label: "Operational guidance" },
];

export function parseCopilotRun(
  payload: unknown,
  sections: ReadonlyArray<{ key: string; label: string }>,
  summaryKey: string,
): { outcome: CopilotOutcome; serverActions: ServerAction[] } {
  const envelope = o(payload);
  const run = o(envelope["data"] ?? envelope);
  const status = s(run["status"]) ?? "";
  const serverActions: ServerAction[] = [];
  for (const raw of Array.isArray(envelope["serverActions"]) ? (envelope["serverActions"] as unknown[]) : []) {
    const a = o(raw);
    const suggestionId = s(a["suggestionId"]);
    const actionType = s(a["actionType"]);
    if (!suggestionId || !actionType) continue;
    const intent = s(o(a["proposedChange"])["intent"]);
    serverActions.push({
      suggestionId,
      actionType,
      displayLabel: s(a["displayLabel"]) ?? actionType,
      reason: s(a["reason"]) ?? "",
      intent: intent === "GENERATE" || intent === "RETRY" || intent === "RECOVER" ? intent : null,
    });
  }
  if (status === "provider_unavailable") return { outcome: { kind: "provider_unavailable" }, serverActions };
  if (status === "policy_denied") return { outcome: { kind: "policy_denied", decision: s(run["decision"]) ?? "" }, serverActions };
  if (status === "schema_error") return { outcome: { kind: "schema_error" }, serverActions };
  if (status === "no_selection") return { outcome: { kind: "no_selection" }, serverActions };
  const data = run["data"];
  if (status === "blocked_prohibited_claim" || !data || typeof data !== "object") return { outcome: { kind: "blocked" }, serverActions };
  const d = o(data);
  return {
    outcome: {
      kind: "result",
      summary: s(d[summaryKey]) ?? "",
      sections: sections.map((sec) => ({ label: sec.label, items: strings(d[sec.key]) })).filter((sec) => sec.items.length > 0),
      citations: parseCitations(d["citations"]),
      droppedCitations: typeof run["droppedCitations"] === "number" ? (run["droppedCitations"] as number) : 0,
      advisoryBoundary: s(d["advisoryBoundary"]) ?? "",
    },
    serverActions,
  };
}

export function copilotFailure(status: number | null, subject: "evidence" | "case"): string {
  const unaffected = subject === "evidence" ? "Evidence workflows are unaffected." : "Case workflows are unaffected.";
  switch (status) {
    case 401:
      return "Please sign in again.";
    case 403:
      return subject === "evidence"
        ? "You are not permitted to run AI on this record, or it is disabled by policy."
        : "You are not permitted to run AI on this case, or it is disabled by policy.";
    case 404:
      return subject === "evidence" ? "This evidence record is no longer accessible." : "This case is no longer accessible.";
    case 409:
      return "The record changed since this page loaded. Refresh and try again.";
    case 429:
      return "Too many AI requests. Please wait a moment.";
    case null:
      return `Could not reach the AI service. ${unaffected}`;
    default:
      return `The AI request could not be completed. ${unaffected}`;
  }
}

/** The report-generation offer exists only when the SERVER made one. */
export function generationOffer(actions: ServerAction[]): ServerAction | null {
  return actions.find((a) => a.actionType === "GENERATE_REPORT" || a.actionType === "RETRY_ELIGIBLE_REPORT") ?? null;
}

/** Why a confirmed output request did not run — the web panel's words. */
export function outputRequestFailure(status: number | null): string {
  if (status === 403) return "You are not permitted to generate or recover outputs for this record.";
  if (status === 409) return "This action is not available for the record right now.";
  return "The action could not be completed. The standard evidence workflow is unaffected.";
}

/**
 * What confirming does, per intent — stated from what the server will run. A
 * package recovery reuses the stored report and creates no report version.
 */
export function suggestionConsequence(intent: ServerAction["intent"]): string {
  switch (intent) {
    case "RECOVER":
      return "Rebuilds this record's verification package from its existing report. The report is not changed and no new version is created; evidence bytes, hashes, custody and timestamps are untouched.";
    case "RETRY":
      return "Retries the failed attempt through the standard endpoint. It does not alter evidence bytes, hashes, custody, or verification state.";
    default:
      return "Generates this record's report and verification package through the standard endpoint. It does not alter evidence bytes, hashes, custody, or verification state.";
  }
}

export const EVIDENCE_COPILOT_COPY = {
  title: "Evidence Copilot",
  chips: ["AI-generated", "Advisory only", "Metadata only"],
  intro:
    "Explains this record's operational state — missing context, deterministic integrity/custody/timestamping signals, and report/package readiness. It never determines truth, authenticity, or admissibility.",
  run: "Run Evidence Copilot",
  rerun: "Re-run",
  running: "Analyzing…",
  noRevision: "This record's analysis revision is not available, so the copilot cannot be run on it right now.",
  providerUnavailable: "AI is currently unavailable. Evidence workflows are unaffected.",
  schemaError: "The AI response did not meet PROOVRA's output contract and was discarded. Nothing from it was saved or shown.",
  blocked: "The AI output contained language PROOVRA cannot present and was blocked.",
  tryAgain: "Try again",
  summary: "Operational summary",
  sources: "Validated sources",
  noSources: "No validated sources.",
  actionsTitle: "Suggested actions",
  actionsIntro: "Actions run through the standard PROOVRA workflow with your normal permissions and audit logging. Nothing runs without your confirmation.",
  confirm: "Confirm and run",
  queuing: "Queuing…",
  cancel: "Cancel",
} as const;

// ---------------------------------------------------------------------------
// CASE COPILOT — POST /v1/ai/case/:id/copilot
//   { selectedEvidenceIds, selectedEvidenceRevisions, processingMode, idempotencyKey }
// The linked records (and their OPAQUE, case-bound analysis revisions) come
// from GET /v1/cases/:id/matter-workspace → sections.evidence.items.
// ---------------------------------------------------------------------------
export function buildCaseCopilotPath(caseId: string): string {
  return `/v1/ai/case/${encodeURIComponent(caseId)}/copilot`;
}

export interface CaseCopilotEvidence {
  id: string;
  title: string;
  type: string;
  status: string;
  lifecycleState: string | null;
  /** Opaque; carried back verbatim, never read. Absent = the record is ineligible. */
  analysisRevision: string | undefined;
  packageVersion: number | null | undefined;
}

export function parseCaseCopilotEvidence(envelope: unknown): CaseCopilotEvidence[] {
  const items = o(o(o(envelope)["sections"])["evidence"])["items"];
  const out: CaseCopilotEvidence[] = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const e = o(raw);
    const id = s(e["id"]);
    if (!id) continue;
    const pv = e["verificationPackageVersion"];
    out.push({
      id,
      title: (s(e["title"]) ?? s(e["displayFileName"]) ?? s(e["originalFileName"]) ?? "Untitled evidence").trim(),
      type: s(e["type"]) ?? "EVIDENCE",
      status: s(e["status"]) ?? "",
      lifecycleState: s(e["lifecycleState"]),
      analysisRevision: s(e["analysisRevision"]) ?? undefined,
      packageVersion: typeof pv === "number" ? pv : pv === null ? null : undefined,
    });
  }
  return out;
}

export const CASE_COPILOT_SECTIONS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "timelineHighlights", label: "Timeline highlights" },
  { key: "missingEvidenceCategories", label: "Missing evidence categories" },
  { key: "workflowGaps", label: "Workflow gaps" },
  { key: "conflictingMetadata", label: "Conflicting metadata" },
  { key: "reviewerPreparation", label: "Reviewer preparation" },
  { key: "disclosureChecklist", label: "Disclosure checklist" },
  { key: "unresolvedQuestions", label: "Unresolved questions" },
];

/** describeFailure (CaseCopilotPanel); 409/422 also ask the caller to re-read the list. */
export function caseCopilotFailure(status: number | null): { message: string; retryable: boolean; refresh: boolean } {
  switch (status) {
    case null:
      return { message: "Could not reach the AI service. Evidence workflows are unaffected.", retryable: true, refresh: false };
    case 422:
      return {
        message: "Some selected records are no longer available for analysis. The list has been refreshed — review the selection and try again.",
        retryable: false,
        refresh: true,
      };
    case 409:
      return {
        message: "A selected record changed while you were choosing. The list has been refreshed — review the selection and try again.",
        retryable: false,
        refresh: true,
      };
    case 400:
      return { message: "That selection could not be sent. Clear the selection and choose the records again.", retryable: false, refresh: false };
    case 401:
      return { message: "Please sign in again.", retryable: false, refresh: false };
    case 403:
      return { message: "You do not have permission to run AI analysis on this case, or it is disabled by workspace policy.", retryable: false, refresh: false };
    case 404:
      return { message: "The case or a selected record is no longer accessible.", retryable: false, refresh: false };
    case 429:
      return { message: "The workspace AI limit has been reached, or requests are arriving too quickly. Try again shortly.", retryable: true, refresh: false };
    case 502:
    case 503:
      return { message: "AI is temporarily unavailable. Case workflows are unaffected.", retryable: true, refresh: false };
    default:
      return { message: "The AI request could not be completed. Case workflows are unaffected.", retryable: true, refresh: false };
  }
}

export function caseEvidenceStatusLabel(status: string): string {
  if (!status) return "Unknown";
  const u = status.toUpperCase();
  if (u === "FAILED_HASH_MISMATCH") return "Integrity failed";
  return u.charAt(0) + u.slice(1).toLowerCase().replace(/_/g, " ");
}

export const CASE_COPILOT_COPY = {
  title: "Evidence Operations Copilot",
  purpose: "Compare selected evidence metadata to surface cross-record patterns and review gaps.",
  disclosures: ["AI-generated", "Advisory only", "Metadata only"],
  selectTitle: "Select evidence",
  selectAll: "Select all",
  clear: "Clear",
  none: "No evidence is linked to this case yet.",
  beforeRun: "Before you run",
  facts: [
    ["Data shared", "Metadata only"],
    ["Raw content", "Not sent"],
    ["Processing", "External AI provider"],
    ["Estimated usage", "1 AI operation"],
    ["Training", "Never used to train models"],
    ["Retention", "Bounded advisory record, per workspace policy"],
  ] as ReadonlyArray<readonly [string, string]>,
  run: "Run Case Copilot",
  rerun: "Re-run Case Copilot",
  running: "Analyzing…",
  needOne: "Select at least one eligible evidence record to run the Copilot.",
  advisoryHint: "Advisory only — this does not change any record.",
  retry: "Retry",
  providerUnavailable: "AI is currently unavailable. Case workflows are unaffected.",
  policyDenied: "Case Copilot is disabled for this workspace.",
  noSelection: "Select at least one evidence record to analyze.",
  schemaError: "The AI response could not be validated and was discarded. Nothing from it is shown. Try again.",
  blocked: "The AI output contained language PROOVRA cannot present and was blocked. AI cannot determine truth, authenticity, or admissibility.",
  summary: "Advisory summary",
  sources: "Validated sources",
} as const;
