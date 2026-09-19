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
  return `/v1/search?${params.toString()}`;
}

/** Normalize the API envelope (defensive against missing fields). */
export function parseSearchResponse(data: unknown): SearchResponse {
  const obj = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const rows = Array.isArray(obj["rows"]) ? (obj["rows"] as SearchRow[]) : [];
  const nextCursor = typeof obj["nextCursor"] === "string" ? (obj["nextCursor"] as string) : null;
  return { rows, nextCursor };
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
