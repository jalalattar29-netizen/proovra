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
