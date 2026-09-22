/**
 * CANONICAL NATIVE GLOBAL SEARCH (Master Program §10, N1) — pure logic.
 *
 * Global Search is a REQUIRED native product surface. It is NOT global in the
 * literal sense: GET /v1/search is workspace-scoped and REQUIRES a `teamId`
 * (400 without it), so the screen resolves teamId from the canonical platform
 * context and this module builds the request + maps results to native routes.
 *
 * Pure (no React/RN) so query-building and result→route resolution are unit
 * tested without a device. The RN screen (app/(stack)/search.tsx) is a thin shell.
 */
import type { ProovraStatusTone } from "@proovra/ui";
import { humanizeEnum } from "./domain-display";

/** Document types GET /v1/search can return (packages/shared SEARCH_DOCUMENT_TYPES). */
export const SEARCH_DOCUMENT_TYPES = [
  "EVIDENCE",
  "CASE",
  "REPORT",
  "PACKAGE",
  "NOTE",
  "INTAKE_LINK",
  "WORKFLOW",
  "WORKFLOW_STEP",
  "REVIEW_EVENT",
  "AUDIT_EVENT",
  "COMMUNICATION",
  "CASE_TIMELINE",
  "INCIDENT",
] as const;
export type SearchDocumentType = (typeof SEARCH_DOCUMENT_TYPES)[number];

/** A row of GET /v1/search (SearchResultRow — the fields the native UI reads). */
export interface SearchRow {
  documentId: string;
  documentType: string;
  sourceId?: string | null;
  title?: string | null;
  subtitle?: string | null;
  summary?: string | null;
  evidenceId?: string | null;
  caseId?: string | null;
  updatedAtUtc?: string | null;
  badges?: string[] | null;
}

export interface SearchResponse {
  /** Workspace total when the server reports one; null means "page only". */
  total?: number | null;
  rows: SearchRow[];
  nextCursor: string | null;
  /**
   * SEMANTIC RUNTIME — the mode the server ACTUALLY used, whether semantic is
   * available at all, and why it fell back if it did.
   *
   * These matter because semantic search can be unavailable while the control
   * offering it is not. A surface that asks for SEMANTIC, silently receives
   * KEYWORD, and says nothing has told the user their query was answered a way
   * it was not — and semantic and keyword answer differently enough that the
   * difference changes what they conclude from an empty result.
   *
   * Older API builds omit them; absent means "semantic is not available here".
   */
  modeUsed?: string | null;
  semanticAvailable?: boolean;
  fallbackReason?: string | null;
}

const TYPE_DISPLAY: Partial<Record<SearchDocumentType, { label: string; tone: ProovraStatusTone }>> = {
  EVIDENCE: { label: "Evidence", tone: "info" },
  CASE: { label: "Case", tone: "governance" },
  REPORT: { label: "Report", tone: "neutral" },
  PACKAGE: { label: "Package", tone: "neutral" },
  NOTE: { label: "Note", tone: "neutral" },
  INTAKE_LINK: { label: "Intake link", tone: "pending" },
  WORKFLOW: { label: "Workflow", tone: "neutral" },
  INCIDENT: { label: "Incident", tone: "risk" },
  COMMUNICATION: { label: "Message", tone: "neutral" },
};

/** Human { label, tone } for a result's document type; unknown → humanized/neutral. */
export function documentTypeDisplay(type: string): { label: string; tone: ProovraStatusTone } {
  return TYPE_DISPLAY[type as SearchDocumentType] ?? { label: humanizeEnum(type), tone: "neutral" };
}

export const SEARCH_PAGE_SIZE = 25;

export interface SearchQueryInput {
  teamId: string | null;
  q: string;
  cursor?: string | null;
  limit?: number;
  mode?: "KEYWORD" | "SEMANTIC" | "HYBRID";
  /**
   * Narrow the result families, as the web filter bar does. Empty or omitted
   * means every family — the same default the web applies when no chip is on.
   */
  documentTypes?: readonly SearchDocumentType[];
  /** ISO instant; results older than this are excluded. */
  updatedSinceUtc?: string | null;
}

/**
 * Build the GET /v1/search path, or null when a fetch would be pointless/invalid:
 * no active workspace (teamId) or a blank query. Returning null is the signal the
 * screen uses to render the "type to search" idle state instead of calling the API.
 */
export function buildSearchPath(input: SearchQueryInput): string | null {
  const q = input.q.trim();
  if (!input.teamId || q.length === 0) return null;
  const params = new URLSearchParams();
  params.set("teamId", input.teamId);
  params.set("q", q);
  params.set("limit", String(input.limit ?? SEARCH_PAGE_SIZE));
  params.set("mode", input.mode ?? "KEYWORD");
  if (input.cursor) params.set("cursor", input.cursor);
  // The web sends one repeated param per selected family; an empty selection
  // sends none, which the server reads as "all".
  for (const t of input.documentTypes ?? []) params.append("documentType", t);
  if (input.updatedSinceUtc) params.set("updatedSinceUtc", input.updatedSinceUtc);
  return `/v1/search?${params.toString()}`;
}

/**
 * The families a native user can actually ACT on, in the order the web lists
 * them. The full SEARCH_DOCUMENT_TYPES union includes operator families
 * (audit events, workflow steps, incidents) whose results native can show but
 * not open — offering them as a filter would promise a destination that does
 * not exist.
 */
export const NATIVE_SEARCH_FILTERS: ReadonlyArray<{
  value: "ALL" | SearchDocumentType;
  label: string;
}> = [
  { value: "ALL", label: "All" },
  { value: "EVIDENCE", label: "Evidence" },
  { value: "CASE", label: "Cases" },
  { value: "REPORT", label: "Reports" },
  { value: "INTAKE_LINK", label: "Intake links" },
];

/** Translate the single-select chip into the query's family list. */
export function filterToDocumentTypes(
  filter: "ALL" | SearchDocumentType,
): readonly SearchDocumentType[] | undefined {
  return filter === "ALL" ? undefined : [filter];
}

/**
 * GET /v1/search/suggest — the typeahead the web offers above the field.
 * Returns at most `limit` suggestion strings; a failure yields none rather
 * than surfacing an error over a convenience feature.
 */
export function buildSuggestPath(input: {
  teamId: string | null;
  q: string;
  limit?: number;
}): string | null {
  const q = input.q.trim();
  if (!input.teamId || q.length < 2) return null;
  const params = new URLSearchParams();
  params.set("teamId", input.teamId);
  params.set("q", q);
  params.set("limit", String(input.limit ?? 8));
  return `/v1/search/suggest?${params.toString()}`;
}

/** Normalise the suggest envelope; anything unexpected yields no suggestions. */
export function parseSuggestions(data: unknown): string[] {
  const o = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const raw = Array.isArray(o["suggestions"]) ? o["suggestions"] : Array.isArray(o["items"]) ? o["items"] : [];
  return raw
    .map((r) => (typeof r === "string" ? r : typeof (r as { text?: unknown })?.text === "string" ? (r as { text: string }).text : null))
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .slice(0, 8);
}

/** Normalize the API envelope (defensive against missing fields). */
export function parseSearchResponse(data: unknown): SearchResponse {
  const obj = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const rows = Array.isArray(obj["rows"]) ? (obj["rows"] as SearchRow[]) : [];
  const nextCursor = typeof obj["nextCursor"] === "string" ? (obj["nextCursor"] as string) : null;
  const total = typeof obj["total"] === "number" ? (obj["total"] as number) : null;
  return { rows, nextCursor, total };
}

/**
 * Resolve the native destination for a result row, or null when native has no
 * surface for that document type yet (the row is shown but not tappable — never a
 * dead link to a missing screen). Evidence/Case are the reachable native detail
 * surfaces today.
 */
export function resolveSearchResultRoute(row: SearchRow): string | null {
  switch (row.documentType) {
    case "EVIDENCE": {
      const id = row.evidenceId ?? row.sourceId;
      return id ? `/evidence/${id}` : null;
    }
    case "CASE": {
      const id = row.caseId ?? row.sourceId;
      return id ? `/case/${id}` : null;
    }
    default:
      return null;
  }
}

/** A stable de-dupe/react key for a row. */
export function searchRowKey(row: SearchRow): string {
  return `${row.documentType}:${row.documentId}`;
}

// ---------------------------------------------------------------------------
// Search modes, and telling the truth about which one answered
// ---------------------------------------------------------------------------

export type SearchMode = "KEYWORD" | "SEMANTIC" | "HYBRID";

export const SEARCH_MODES: ReadonlyArray<{ value: SearchMode; label: string }> = [
  { value: "KEYWORD", label: "Keyword" },
  { value: "HYBRID", label: "Blended" },
  { value: "SEMANTIC", label: "Meaning" },
];

/**
 * Read the semantic-runtime envelope.
 *
 * Absent fields mean the API build does not report them, which is treated as
 * "semantic is not available here" rather than as "it is" — the safe direction
 * for a capability the client cannot otherwise observe.
 */
export function parseSearchRuntime(payload: unknown): {
  modeUsed: SearchMode | null;
  semanticAvailable: boolean;
  fallbackReason: string | null;
} {
  const d = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const raw = typeof d.modeUsed === "string" ? d.modeUsed.toUpperCase() : null;
  const modeUsed =
    raw === "KEYWORD" || raw === "SEMANTIC" || raw === "HYBRID" ? (raw as SearchMode) : null;

  return {
    modeUsed,
    semanticAvailable: d.semanticAvailable === true,
    fallbackReason: typeof d.fallbackReason === "string" && d.fallbackReason.length > 0
      ? d.fallbackReason
      : null,
  };
}

/**
 * The modes a user may actually choose here.
 *
 * Keyword always. The other two only when the server says semantic is
 * available — a control that asks for meaning-based search and silently gets
 * keyword is worse than no control, because the user reads the empty result as
 * "nothing matches" rather than "that was not the search I asked for".
 */
export function availableSearchModes(semanticAvailable: boolean): SearchMode[] {
  return semanticAvailable ? ["KEYWORD", "HYBRID", "SEMANTIC"] : ["KEYWORD"];
}

/**
 * What to tell the user when the server answered with a different mode than
 * the one they picked, or null when it did not.
 */
export function searchFallbackNotice(
  requested: SearchMode,
  runtime: { modeUsed: SearchMode | null; fallbackReason: string | null },
): string | null {
  if (!runtime.modeUsed || runtime.modeUsed === requested) return null;
  const used = SEARCH_MODES.find((m) => m.value === runtime.modeUsed)?.label ?? runtime.modeUsed;
  return runtime.fallbackReason
    ? `Answered with ${used.toLowerCase()} search instead: ${runtime.fallbackReason}`
    : `Answered with ${used.toLowerCase()} search instead.`;
}

/** The "updated since" windows a phone user actually picks. */
export const SEARCH_RECENCY_WINDOWS: ReadonlyArray<{
  value: string;
  label: string;
  days: number | null;
}> = [
  { value: "any", label: "Any time", days: null },
  { value: "7d", label: "Last 7 days", days: 7 },
  { value: "30d", label: "Last 30 days", days: 30 },
  { value: "90d", label: "Last 90 days", days: 90 },
];

export function recencyToIso(value: string, nowMs: number = Date.now()): string | null {
  const window = SEARCH_RECENCY_WINDOWS.find((w) => w.value === value);
  if (!window || window.days === null) return null;
  return new Date(nowMs - window.days * 86_400_000).toISOString();
}
