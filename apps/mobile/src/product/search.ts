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
 * The web reference is apps/web/app/(app)/search/page.tsx.
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
  // Inspector fields (SearchResultRow).
  workflowInstanceId?: string | null;
  workflowStepInstanceId?: string | null;
  reviewState?: string | null;
  workflowState?: string | null;
  exportState?: string | null;
  retentionState?: string | null;
  legalHoldState?: string | null;
  semanticScore?: number | null;
  /** Why the backend says this row matched (Phase 15; omitted by older builds). */
  matchReasons?: string[] | null;
}

/**
 * GET /v1/search reply (search.routes.ts `reply.code(200).send({ rows,
 * nextCursor, totalReturned, filteredByGovernance, filteredByVisibility,
 * modeUsed, semanticAvailable, fallbackReason })`).
 *
 * There is NO workspace `total`: `totalReturned` is what this page returned.
 * This parser used to read a `total` the route never sends.
 */
export interface SearchResponse {
  rows: SearchRow[];
  nextCursor: string | null;
  totalReturned: number;
  /** Records the workspace withheld — counted, never listed. */
  filteredByGovernance: number;
  filteredByVisibility: number;
}

/**
 * The type classification, in the web's words and tones
 * (search/page.tsx DOCUMENT_TYPE_LABEL + searchTones.ts searchTypeTone:
 * blue → info, orange → pending, indigo → governance, slate/silver → neutral).
 */
const TYPE_DISPLAY: Record<SearchDocumentType, { label: string; tone: ProovraStatusTone }> = {
  EVIDENCE: { label: "Evidence", tone: "info" },
  CASE: { label: "Case", tone: "info" },
  REPORT: { label: "Report", tone: "pending" },
  PACKAGE: { label: "Package", tone: "governance" },
  NOTE: { label: "Note", tone: "neutral" },
  INTAKE_LINK: { label: "Intake request", tone: "neutral" },
  WORKFLOW: { label: "Workflow", tone: "neutral" },
  WORKFLOW_STEP: { label: "Workflow step", tone: "neutral" },
  REVIEW_EVENT: { label: "Review event", tone: "neutral" },
  AUDIT_EVENT: { label: "Audit event", tone: "neutral" },
  COMMUNICATION: { label: "Communication", tone: "neutral" },
  CASE_TIMELINE: { label: "Case timeline", tone: "neutral" },
  INCIDENT: { label: "Incident", tone: "neutral" },
};

/** Human { label, tone } for a result's document type; unknown → humanized/neutral. */
export function documentTypeDisplay(type: string): { label: string; tone: ProovraStatusTone } {
  return TYPE_DISPLAY[type as SearchDocumentType] ?? { label: humanizeEnum(type), tone: "neutral" };
}

export const SEARCH_PAGE_SIZE = 25;
/** SearchFilterSchema `q: z.string().min(1).max(200)` — the web input's maxLength. */
export const SEARCH_QUERY_MAX = 200;

export type SearchEvidenceKind = "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT";

export interface SearchQueryInput {
  teamId: string | null;
  /** Optional: the web runs the workspace listing with no query at all. */
  q?: string | null;
  cursor?: string | null;
  limit?: number;
  /** Sent only when it is not the server default (KEYWORD), as the web does. */
  mode?: "KEYWORD" | "SEMANTIC" | "HYBRID";
  /** Empty or omitted means every family — the same default the web applies. */
  documentTypes?: readonly SearchDocumentType[];
  /** The web's "Evidence kind" chips (search/page.tsx:2018). */
  evidenceTypes?: readonly SearchEvidenceKind[];
  /** ISO instant; results older than this are excluded. */
  updatedSinceUtc?: string | null;
  /** The web's "Sort results" (search/page.tsx:1986). Omitted = server default. */
  sort?: SearchSortMode | null;
  /** The web's "Until" (search/page.tsx:2097): an ISO upper bound. */
  updatedUntilUtc?: string | null;
  /** The web's Lifecycle toggles (search/page.tsx:2042). Only `true` is sent. */
  lifecycle?: Partial<Record<SearchLifecycleFlag, boolean>>;
}

/** The five Lifecycle toggles, in the web's order and words; each is a `parseBool` param. */
export type SearchLifecycleFlag = "workflowLinked" | "onLegalHold" | "exportRestricted" | "incidentLinked" | "contributorScoped";
export const SEARCH_LIFECYCLE_TOGGLES: ReadonlyArray<{ flag: SearchLifecycleFlag; label: string; summary: string }> = [
  { flag: "workflowLinked", label: "Workflow-linked only", summary: "workflow-linked" },
  { flag: "onLegalHold", label: "On legal hold", summary: "legal hold" },
  { flag: "exportRestricted", label: "Export-restricted", summary: "export-restricted" },
  { flag: "incidentLinked", label: "Incident-linked", summary: "incident-linked" },
  { flag: "contributorScoped", label: "Contributor-scoped", summary: "contributor-scoped" },
];

/** search/page.tsx:394-400, verbatim; values are `SEARCH_SORT_MODES` (packages/shared/src/search.ts:78). */
export type SearchSortMode = "UPDATED_DESC" | "UPDATED_ASC" | "CREATED_DESC" | "CREATED_ASC" | "RELEVANCE_DESC";
export const SEARCH_SORT_OPTIONS: ReadonlyArray<{ value: SearchSortMode; label: string }> = [
  { value: "UPDATED_DESC", label: "Most recent first" },
  { value: "UPDATED_ASC", label: "Oldest first" },
  { value: "CREATED_DESC", label: "Newest by creation" },
  { value: "CREATED_ASC", label: "Earliest by creation" },
  { value: "RELEVANCE_DESC", label: "Relevance" },
];

/** A search query as the server accepts it: trimmed, bounded, or absent. */
export function normalizeSearchQuery(q: string | null | undefined): string {
  return (q ?? "").trim().slice(0, SEARCH_QUERY_MAX).trim();
}

/**
 * Build the GET /v1/search path, or null when there is no active workspace
 * (teamId — the route 400s without it).
 *
 * A blank query is NOT idle: the web runs the workspace listing with no `q`
 * (search/page.tsx runSearch: `if (filter.q) qs.set("q", …)`) and lists the
 * most recent records; the pristine state is only what an empty listing says.
 */
export function buildSearchPath(input: SearchQueryInput): string | null {
  if (!input.teamId) return null;
  const q = normalizeSearchQuery(input.q);
  const params = new URLSearchParams();
  params.set("teamId", input.teamId);
  if (q) params.set("q", q);
  params.set("limit", String(input.limit ?? SEARCH_PAGE_SIZE));
  if (input.mode && input.mode !== "KEYWORD") params.set("mode", input.mode);
  if (input.cursor) params.set("cursor", input.cursor);
  // THE PARAMETER IS `documentTypes` — a comma list or an array, read by
  // `parseStringList(raw.documentTypes)` (search.routes.ts:320).
  const types = input.documentTypes ?? [];
  if (types.length > 0) params.set("documentTypes", types.join(","));
  const kinds = input.evidenceTypes ?? [];
  if (kinds.length > 0) params.set("evidenceTypes", kinds.join(","));
  if (input.updatedSinceUtc) params.set("updatedSinceUtc", input.updatedSinceUtc);
  if (input.updatedUntilUtc) params.set("updatedUntilUtc", input.updatedUntilUtc);
  // An unset toggle sends nothing — the web writes `undefined`, never `false`.
  for (const { flag } of SEARCH_LIFECYCLE_TOGGLES) {
    if (input.lifecycle?.[flag] === true) params.set(flag, "true");
  }
  if (input.sort) params.set("sort", input.sort);
  return `/v1/search?${params.toString()}`;
}

/**
 * The web's "Document type" chips (search/page.tsx DOCUMENT_TYPES), in its
 * order and words. Multi-select: none on means every family. Every one of
 * them has a native destination via `searchOpenAction`.
 */
export const SEARCH_DOCUMENT_TYPE_FILTERS: ReadonlyArray<{ value: SearchDocumentType; label: string }> = (
  ["EVIDENCE", "CASE", "REPORT", "PACKAGE", "NOTE", "INTAKE_LINK"] as const
).map((value) => ({ value, label: TYPE_DISPLAY[value].label }));

/** The web's "Evidence kind" chips (search/page.tsx EVIDENCE_TYPES / EVIDENCE_TYPE_LABEL). */
export const SEARCH_EVIDENCE_KIND_FILTERS: ReadonlyArray<{ value: SearchEvidenceKind; label: string }> = [
  { value: "PHOTO", label: "Photo" },
  { value: "VIDEO", label: "Video" },
  { value: "AUDIO", label: "Audio" },
  { value: "DOCUMENT", label: "Document" },
];

/** The web's toggleArray: add or remove one value; an emptied set is "none". */
export function toggleSearchValue<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** The narrowing dimensions a filter state carries (everything but q + sort). */
export interface SearchNarrowing {
  documentTypes: readonly SearchDocumentType[];
  evidenceTypes: readonly SearchEvidenceKind[];
  lifecycle: Partial<Record<SearchLifecycleFlag, boolean>>;
  updatedSinceUtc: string | null;
  updatedUntilUtc: string | null;
}

/** hasNarrowingFilters (search/page.tsx:3310). The query itself never counts. */
export function hasNarrowingFilters(f: SearchNarrowing): boolean {
  return (
    f.documentTypes.length > 0 ||
    f.evidenceTypes.length > 0 ||
    SEARCH_LIFECYCLE_TOGGLES.some(({ flag }) => f.lifecycle[flag] === true) ||
    !!f.updatedSinceUtc ||
    !!f.updatedUntilUtc
  );
}

/**
 * filterSummary (search/page.tsx:1504) — what is narrowing the result set.
 * The query is deliberately absent: a search string is never echoed back
 * outside the input box.
 */
export function searchFilterSummary(f: SearchNarrowing): string {
  const parts: string[] = [];
  const types = f.documentTypes.length;
  if (types > 0) parts.push(`${types} record type${types === 1 ? "" : "s"}`);
  const kinds = f.evidenceTypes.length;
  if (kinds > 0) parts.push(`${kinds} evidence kind${kinds === 1 ? "" : "s"}`);
  for (const { flag, summary } of SEARCH_LIFECYCLE_TOGGLES) if (f.lifecycle[flag] === true) parts.push(summary);
  if (f.updatedSinceUtc || f.updatedUntilUtc) parts.push("an updated-date range");
  return parts.length > 0 ? `narrowed by ${parts.join(", ")}` : "no filters applied";
}

/** withheldSummary (search/page.tsx:1527) — counted, never listed; null when nothing was withheld. */
export function searchWithheldSummary(r: { filteredByVisibility: number; filteredByGovernance: number } | null): string | null {
  if (!r) return null;
  const parts: string[] = [];
  if (r.filteredByVisibility) parts.push(`${r.filteredByVisibility} withheld by visibility`);
  if (r.filteredByGovernance) parts.push(`${r.filteredByGovernance} withheld by governance`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The result head's count (search/page.tsx:2233). */
export function searchCountLabel(totalReturned: number): string {
  return `${totalReturned} result${totalReturned === 1 ? "" : "s"}`;
}

/**
 * describeFilterEmpty (search/page.tsx:3351). When the type filter is the
 * ONLY narrowing and the diagnostics probe for THIS query says other types
 * matched, name them; otherwise the generic copy.
 */
export function describeFilterEmpty(
  f: SearchNarrowing & { q: string | null },
  probe: SearchQueryProbe | null,
): { headline: string; detail: string } {
  const generic = {
    headline: "No matches with the current filters",
    detail: "Try clearing one or more filters, or broaden your query.",
  };
  const onlyTypeNarrowing =
    f.documentTypes.length > 0 &&
    !hasNarrowingFilters({ ...f, documentTypes: [] });
  const usable = probe && f.q && probe.q === f.q ? probe : null;
  if (!onlyTypeNarrowing || !usable) return generic;
  const others = Object.entries(usable.matchedByType)
    .filter(([type, count]) => count > 0 && !f.documentTypes.includes(type as SearchDocumentType))
    .map(([type]) => type);
  if (others.length === 0) return generic;
  const label = (t: string) => documentTypeDisplay(t).label;
  return {
    headline: `No ${f.documentTypes.map(label).join(" / ")} records match`,
    detail: `${others.map(label).join(" / ")} records DID match your search — clear the type filter to see them.`,
  };
}

/** `queryProbe` of GET /v1/search/diagnostics?q= (search.routes.ts diagnostics reply). */
export interface SearchQueryProbe {
  q: string;
  matchedTotal: number;
  matchedByType: Record<string, number>;
}

/** The non-readiness parts of the diagnostics reply the console reads. */
export function parseSearchDiagnosticsContext(payload: unknown): { workspaceName: string | null; queryProbe: SearchQueryProbe | null } {
  const d = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const ws = d["workspace"] && typeof d["workspace"] === "object" ? (d["workspace"] as Record<string, unknown>) : {};
  const p = d["queryProbe"] && typeof d["queryProbe"] === "object" ? (d["queryProbe"] as Record<string, unknown>) : null;
  let queryProbe: SearchQueryProbe | null = null;
  if (p && typeof p["q"] === "string") {
    const byType: Record<string, number> = {};
    const raw = p["matchedByType"] && typeof p["matchedByType"] === "object" ? (p["matchedByType"] as Record<string, unknown>) : {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "number") byType[k] = v;
    queryProbe = { q: p["q"] as string, matchedTotal: typeof p["matchedTotal"] === "number" ? (p["matchedTotal"] as number) : 0, matchedByType: byType };
  }
  return {
    workspaceName: typeof ws["name"] === "string" && (ws["name"] as string).length > 0 ? (ws["name"] as string) : null,
    queryProbe,
  };
}

/** `No matches in "<workspace>"` — named, so a wrong-workspace mistake is visible. */
export function inWorkspace(headline: string, workspaceName: string | null): string {
  return workspaceName ? `${headline} in "${workspaceName}"` : headline;
}

/**
 * Why the search request produced no answer (search/page.tsx
 * classifySearchFailure): 403/404 is the workspace declining (no retry, no
 * connection language); anything else is the service not answering.
 */
export function classifySearchFailure(err: unknown): "restricted" | "unavailable" {
  const e = (err && typeof err === "object" ? err : {}) as { statusCode?: unknown; code?: unknown };
  const status = typeof e.statusCode === "number" ? e.statusCode : null;
  const code = typeof e.code === "string" ? e.code : null;
  if (status === 403 || status === 404 || code === "permission_denied" || code === "not_found") return "restricted";
  return "unavailable";
}

/**
 * GET /v1/search/suggest — the typeahead. The route's zod schema bounds `q`
 * at 80 characters (search.routes.ts:811), so a longer draft is clipped
 * rather than turned into a 400. Server default limit (10), as the web.
 */
export const SUGGEST_QUERY_MAX = 80;
export function buildSuggestPath(input: { teamId: string | null; q: string }): string | null {
  const q = input.q.trim();
  if (!input.teamId || q.length < 2) return null;
  const params = new URLSearchParams();
  params.set("teamId", input.teamId);
  params.set("q", q.slice(0, SUGGEST_QUERY_MAX));
  return `/v1/search/suggest?${params.toString()}`;
}

/** One typeahead suggestion (the route's `suggestions[]` row). */
export interface SearchSuggestion {
  id: string;
  documentType: string;
  title: string;
}

/** `{ suggestions: [{ id, documentType, sourceId, title, … }] }`; anything unusable is dropped. */
export function parseSuggestionRows(data: unknown): SearchSuggestion[] {
  const o = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const raw = Array.isArray(o["suggestions"]) ? (o["suggestions"] as unknown[]) : [];
  const out: SearchSuggestion[] = [];
  raw.forEach((r, i) => {
    const row = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const title = typeof row["title"] === "string" ? (row["title"] as string) : "";
    if (!title) return;
    out.push({
      id: typeof row["id"] === "string" ? (row["id"] as string) : `s${i}`,
      documentType: typeof row["documentType"] === "string" ? (row["documentType"] as string) : "",
      title,
    });
  });
  return out.slice(0, 10);
}

/**
 * Normalize the GET /v1/search envelope, or null when it is MALFORMED (no
 * `rows` array). The web treats a malformed 200 as the service not answering
 * (search/page.tsx:1000) — landing it in "No results" told users their
 * records did not exist.
 */
export function parseSearchResponse(data: unknown): SearchResponse | null {
  if (!data || typeof data !== "object" || !Array.isArray((data as Record<string, unknown>)["rows"])) return null;
  const obj = data as Record<string, unknown>;
  const rows = obj["rows"] as SearchRow[];
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    rows,
    nextCursor: typeof obj["nextCursor"] === "string" ? (obj["nextCursor"] as string) : null,
    totalReturned: typeof obj["totalReturned"] === "number" ? (obj["totalReturned"] as number) : rows.length,
    filteredByGovernance: n(obj["filteredByGovernance"]),
    filteredByVisibility: n(obj["filteredByVisibility"]),
  };
}

/** Load more: append the page and ADD its counts, as the web's loadMore does. */
export function mergeSearchPages(prev: SearchResponse, next: SearchResponse): SearchResponse {
  return {
    rows: [...prev.rows, ...next.rows],
    nextCursor: next.nextCursor,
    totalReturned: prev.totalReturned + next.totalReturned,
    filteredByGovernance: prev.filteredByGovernance + next.filteredByGovernance,
    filteredByVisibility: prev.filteredByVisibility + next.filteredByVisibility,
  };
}

/**
 * Resolve the native destination for a result row, or null when native has no
 * surface for that document type yet (the row is shown but not tappable — never a
 * dead link to a missing screen).
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
// What ordered the result set
// ---------------------------------------------------------------------------

export type SearchMode = "KEYWORD" | "SEMANTIC" | "HYBRID";

/**
 * The mode the server ACTUALLY used. The web no longer lets a user pick an
 * algorithm (search/page.tsx:3099 — "the backend chooses"); what ran is
 * stated in the header instead. Absent/unknown → null.
 */
export function parseSearchModeUsed(payload: unknown): SearchMode | null {
  const d = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const raw = typeof d.modeUsed === "string" ? d.modeUsed.toUpperCase() : null;
  return raw === "KEYWORD" || raw === "SEMANTIC" || raw === "HYBRID" ? raw : null;
}

/** search/page.tsx:1642 — semantic similarity only re-ranks, so it is "advisory". */
export function searchRankingLabel(modeUsed: SearchMode | null): string {
  return modeUsed === "HYBRID" || modeUsed === "SEMANTIC" ? "Deterministic match · advisory ranking" : "Deterministic match";
}

// ---------------------------------------------------------------------------
// Result-row facts (search/page.tsx primaryStatusBadge / rowLifecycleState,
// searchTones.ts). Web tones map onto the native status tones:
// green → verified, amber/orange → pending, red → risk, blue → info,
// indigo → governance, slate/ink/silver → neutral.
// ---------------------------------------------------------------------------

const STATUS_BADGE_PRECEDENCE = [
  "legal-hold",
  "governance-restricted",
  "in_trash",
  "visibility-restricted",
  "export-restricted",
  "locked",
  "archived",
] as const;

/** The one lifecycle fact that leads a result row; null when none applies. */
export function primaryStatusBadge(badges: readonly string[]): string | null {
  for (const c of STATUS_BADGE_PRECEDENCE) if (badges.includes(c)) return c;
  return null;
}

const BADGE_TONE: Readonly<Record<string, ProovraStatusTone>> = {
  "legal-hold": "risk",
  "governance-restricted": "risk",
  "incident-linked": "risk",
  "export-restricted": "pending",
  "visibility-restricted": "pending",
  "review-linked": "pending",
  in_trash: "pending",
  locked: "pending",
  // lifecycleTone: archived → red.
  archived: "risk",
  "workflow-linked": "info",
  "communication-linked": "info",
  "integrity record": "info",
  "matched metadata": "info",
  "related evidence": "info",
  "contributor-scoped": "neutral",
};
export function searchBadgeTone(badge: string): ProovraStatusTone {
  return BADGE_TONE[badge] ?? "neutral";
}

const LIFECYCLE_TONE: Readonly<Record<string, ProovraStatusTone>> = {
  // lib/status-tone/lifecycleTone.ts
  open: "verified",
  active: "verified",
  live: "verified",
  in_progress: "verified",
  investigating: "governance",
  on_hold: "governance",
  resolved: "pending",
  archived: "risk",
  // searchTones.ts LIFECYCLE_KIND
  pending: "pending",
  queued: "pending",
  processing: "pending",
  in_review: "pending",
  under_review: "pending",
  review: "pending",
  awaiting_review: "pending",
  restricted: "pending",
  locked: "pending",
  in_trash: "pending",
  deleted: "risk",
  destroyed: "risk",
  purged: "risk",
  pending_destruction: "risk",
};
/** closed/complete/done/sealed are lifecycle values with a neutral (ink) tone. */
const NEUTRAL_LIFECYCLE = new Set(["closed", "complete", "completed", "done", "sealed"]);
const lifecycleKey = (v: string) => v.trim().toLowerCase().replace(/[\s-]+/g, "_");

/** isLifecycleValue (searchTones.ts): does this value name a state at all? */
export function isSearchLifecycleValue(value: string | null | undefined): boolean {
  if (value == null) return false;
  const k = lifecycleKey(value);
  return k in LIFECYCLE_TONE || NEUTRAL_LIFECYCLE.has(k);
}
export function searchLifecycleTone(value: string | null | undefined): ProovraStatusTone {
  if (value == null) return "neutral";
  return LIFECYCLE_TONE[lifecycleKey(value)] ?? "neutral";
}

/** rowLifecycleState: workflow state leads; review state answers otherwise. */
export function rowLifecycleState(row: SearchRow): string | null {
  const v = row.workflowState ?? row.reviewState ?? null;
  return v && isSearchLifecycleValue(v) ? v : null;
}

/** A CASE's subtitle IS its status label — dropped when it only repeats the lifecycle. */
export function rowSupportingSubtitle(row: SearchRow): string | null {
  const lifecycle = rowLifecycleState(row);
  if (!row.subtitle) return null;
  return lifecycle && searchLifecycleLabel(row.subtitle) === searchLifecycleLabel(lifecycle) ? null : row.subtitle;
}

// ---------------------------------------------------------------------------
// Recent searches (search/page.tsx:1136-1220) — this device's own history,
// per workspace, under the canonical tenant namespace the web uses
// (`proovra:tenant:<workspaceId>:search:recent`). Up to 10, most recent first.
// ---------------------------------------------------------------------------

export const SEARCH_RECENT_LIMIT = 10;
export function searchRecentKey(teamId: string): string {
  return `proovra:tenant:${teamId}:search:recent`;
}
export function parseRecentSearches(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]).slice(0, SEARCH_RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}
export function pushRecentSearch(list: readonly string[], q: string): string[] {
  const t = q.trim();
  if (!t) return [...list];
  return [t, ...list.filter((r) => r !== t)].slice(0, SEARCH_RECENT_LIMIT);
}

// ---------------------------------------------------------------------------
// T-15 / T-14 — the result INSPECTOR (apps/web/app/(app)/search/page.tsx
// Inspector + getOpenAction) and GET /v1/search/relationships/:evidenceId.
// ---------------------------------------------------------------------------

/**
 * The inspector's one way out, limited to destinations native HAS: a report or
 * package opens its evidence, a note its case, an intake link the intake list
 * with that link's delivery history. Workflow has no native screen, so no
 * action rather than a dead one. Trashed records keep the web's wording.
 */
export function searchOpenAction(row: SearchRow): { route: string | { pathname: string; params: Record<string, string> }; label: string } | null {
  const trash = (row.badges ?? []).includes("in_trash");
  const ev = row.evidenceId ?? (row.documentType === "EVIDENCE" ? row.sourceId : null);
  const cs = row.caseId ?? (row.documentType === "CASE" ? row.sourceId : null);
  const label = (normal: string) => (trash ? "Open in trash" : normal);
  switch (row.documentType) {
    case "EVIDENCE":
      return ev ? { route: `/evidence/${ev}`, label: label("Open evidence") } : null;
    case "CASE":
      return cs ? { route: `/case/${cs}`, label: label("Open case") } : null;
    case "REPORT":
      return ev ? { route: `/evidence/${ev}`, label: label("Open report") } : null;
    case "PACKAGE":
      return ev ? { route: `/evidence/${ev}`, label: label("Open package") } : null;
    case "NOTE":
      return cs ? { route: `/case/${cs}`, label: label("Open note") } : null;
    case "INTAKE_LINK":
      return row.sourceId ? { route: { pathname: "/intake-links", params: { linkId: row.sourceId } }, label: "Open request" } : null;
    default:
      return null;
  }
}

const BADGE_LABELS: Record<string, string> = {
  in_trash: "In trash",
  archived: "Archived",
  locked: "Locked",
  "legal-hold": "Legal hold",
  "export-restricted": "Export-restricted",
  "workflow-linked": "Workflow-linked",
  "review-linked": "Review-linked",
  "contributor-scoped": "Contributor-scoped",
  "visibility-restricted": "Visibility-restricted",
  "governance-restricted": "Governance-restricted",
  "incident-linked": "Incident-linked",
  "communication-linked": "Communication-linked",
  "integrity record": "Integrity record",
  "matched metadata": "Matched metadata",
  "related evidence": "Related evidence",
};
export function searchBadgeLabel(badge: string): string {
  return BADGE_LABELS[badge] ?? badge;
}

/** searchLifecycleLabel — "—" for absent, else sentence-cased words. */
export function searchLifecycleLabel(value: string | null | undefined): string {
  if (value == null || value.trim() === "") return "—";
  const words = value.trim().replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function buildSearchRelationshipsPath(evidenceId: string, teamId: string): string {
  return `/v1/search/relationships/${encodeURIComponent(evidenceId)}?teamId=${encodeURIComponent(teamId)}`;
}

export interface SearchRelationship {
  relationshipId: string;
  otherEvidenceId: string;
  relationshipType: string;
  note: string | null;
}

/** Each relationship as "the OTHER record", from this row's side. */
export function parseSearchRelationships(payload: unknown, evidenceId: string): SearchRelationship[] {
  const d = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const list = Array.isArray(d["relationships"]) ? (d["relationships"] as unknown[]) : [];
  const out: SearchRelationship[] = [];
  for (const raw of list) {
    const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const id = typeof r["relationshipId"] === "string" ? (r["relationshipId"] as string) : "";
    const src = typeof r["sourceEvidenceId"] === "string" ? (r["sourceEvidenceId"] as string) : "";
    const tgt = typeof r["targetEvidenceId"] === "string" ? (r["targetEvidenceId"] as string) : "";
    if (!id || !src || !tgt) continue;
    out.push({
      relationshipId: id,
      otherEvidenceId: src === evidenceId ? tgt : src,
      relationshipType: typeof r["relationshipType"] === "string" ? (r["relationshipType"] as string) : "",
      note: typeof r["note"] === "string" && (r["note"] as string).length > 0 ? (r["note"] as string) : null,
    });
  }
  return out;
}
