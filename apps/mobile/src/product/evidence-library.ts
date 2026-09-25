/**
 * CANONICAL NATIVE EVIDENCE LIBRARY (Master Program §4/A, M1) — pure.
 *
 * The library list (GET /v1/evidence), summary (GET /v1/evidence/library-summary)
 * and bulk (POST /v1/evidence/bulk) are all requireAuth-only — Personal/PRO get
 * every filter, sort, metric and bulk action. These pure helpers model the
 * server-supported filters/sort, project the 12-field summary into a metric
 * strip, and describe the bulk actions applicable per scope. RN screen = shell.
 */
import type { ProovraStatusTone } from "@proovra/ui";
import type { EvidenceBulkActionName } from "@proovra/shared";

/** Server sort values (EvidenceListSortSchema). */
export const LIBRARY_SORTS = ["newest", "oldest", "priority"] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export function nextSort(current: LibrarySort): LibrarySort {
  const i = LIBRARY_SORTS.indexOf(current);
  return LIBRARY_SORTS[(i + 1) % LIBRARY_SORTS.length];
}
export function sortLabel(sort: LibrarySort): string {
  return sort === "newest" ? "Newest" : sort === "oldest" ? "Oldest" : "Reviewer priority";
}

export type LibraryScope = "active" | "archived" | "trash" | "locked";

/**
 * THE LIBRARY FILTER STATE — the web's `EvidenceFilterState`
 * (EvidenceFilters.tsx:6), value for value, so a saved view written by either
 * client restores identically on the other. "all" means "no refinement".
 *
 * `review` and `retention` are applied to the LOADED rows (page.tsx:633), as
 * the web applies them: the list route has no parameter for either.
 */
export interface LibraryFilters {
  search: string;
  scope: LibraryScope;
  status: string;
  type: string;
  review: string;
  exportReadiness: string;
  caseAssignment: string;
  retention: string;
  sort: LibrarySort;
  /** Trust-signal deep-link filters (page.tsx:155); set only from route params. */
  tsaStatus: string;
  otsStatus: string;
  publicVerifyState: string;
  verificationStatus: string;
  /** UC-0 acquisition category. */
  acquisition: string;
}

export const DEFAULT_LIBRARY_FILTERS: LibraryFilters = {
  search: "",
  scope: "active",
  status: "all",
  type: "all",
  review: "all",
  exportReadiness: "all",
  caseAssignment: "all",
  retention: "all",
  sort: "newest",
  tsaStatus: "all",
  otsStatus: "all",
  publicVerifyState: "all",
  verificationStatus: "all",
  acquisition: "all",
};

export interface LibraryFilterOption {
  value: string;
  label: string;
}

/** EvidenceFilters.tsx:117-236 — the web's options and labels, verbatim. */
export const SCOPE_OPTIONS: ReadonlyArray<LibraryFilterOption> = [
  { value: "active", label: "Active" },
  { value: "locked", label: "Locked" },
  { value: "archived", label: "Archived" },
  { value: "trash", label: "Trash" },
];
export const STATUS_OPTIONS: ReadonlyArray<LibraryFilterOption> = [
  { value: "all", label: "All" },
  { value: "created", label: "Created" },
  { value: "uploading", label: "Uploading" },
  { value: "uploaded", label: "Uploaded" },
  { value: "signed", label: "Signed" },
  { value: "reported", label: "Reported" },
];
export const TYPE_OPTIONS: ReadonlyArray<LibraryFilterOption> = [
  { value: "all", label: "All" },
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
  { value: "audio", label: "Audio" },
  { value: "document", label: "Document" },
  { value: "multipart", label: "Multipart" },
  { value: "other", label: "Other" },
];
export const SOURCE_OPTIONS: ReadonlyArray<LibraryFilterOption> = [
  { value: "all", label: "All" },
  { value: "UPLOAD", label: "Uploaded" },
  { value: "SECURE_INTAKE", label: "Secure intake" },
  { value: "MOBILE_APP", label: "Mobile app" },
  { value: "DIRECT_WEB_CAPTURE", label: "Web capture" },
  { value: "DIRECT_SCREEN_CAPTURE", label: "Screen capture" },
  { value: "NOT_RECORDED", label: "Not recorded" },
];
export const REVIEW_OPTIONS: ReadonlyArray<LibraryFilterOption> = [
  { value: "all", label: "All" },
  { value: "review-ready", label: "Review-ready marker recorded" },
  { value: "review-required", label: "Review required" },
  { value: "verification-failed", label: "Verification failed" },
];
export const EXPORT_OPTIONS: ReadonlyArray<LibraryFilterOption> = [
  { value: "all", label: "All" },
  { value: "report-available", label: "Report available" },
  { value: "report-missing", label: "Report not recorded" },
];
export const CASE_OPTIONS: ReadonlyArray<LibraryFilterOption> = [
  { value: "all", label: "All" },
  { value: "assigned", label: "Assigned" },
  { value: "unassigned", label: "Unassigned" },
];
export const RETENTION_OPTIONS: ReadonlyArray<LibraryFilterOption> = [
  { value: "all", label: "All" },
  { value: "protected", label: "Storage protection recorded" },
  { value: "unprotected", label: "Protection not recorded" },
];
export const SORT_OPTIONS: ReadonlyArray<{ value: LibrarySort; label: string }> = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "priority", label: "Reviewer priority" },
];

/** Legacy server-enum spellings kept for callers that still pass them. */
export const STATUS_FILTERS = ["CREATED", "UPLOADING", "UPLOADED", "SIGNED", "REPORTED"] as const;
export const SOURCE_FILTERS = ["UPLOAD", "SECURE_INTAKE", "MOBILE_APP", "DIRECT_WEB_CAPTURE", "DIRECT_SCREEN_CAPTURE", "NOT_RECORDED"] as const;
export const REPORT_FILTERS = ["ready", "missing"] as const;

export interface LibraryQueryInput {
  scope: string;
  search?: string;
  type?: string; // "all" or a type filter value
  status?: string; // "all" or an EvidenceStatus
  source?: string; // "all" or an acquisition category (sent as `acquisition`)
  reportReady?: string; // "all" | "ready" | "missing"
  caseAssignment?: string; // "all" | "assigned" | "unassigned"
  tsaStatus?: string;
  otsStatus?: string;
  publicVerifyState?: string;
  verificationStatus?: string;
  sort: LibrarySort;
  cursor?: string | null;
  limit?: number;
}

function refined(v: string | undefined | null): v is string {
  return typeof v === "string" && v.trim() !== "" && v !== "ALL" && v !== "all";
}

/** The filter params the list AND the summary share (page.tsx:80 / :111). */
function setFilterParams(p: URLSearchParams, input: LibraryQueryInput): void {
  if (input.search && input.search.trim()) p.set("search", input.search.trim());
  if (refined(input.status)) p.set("status", input.status);
  if (refined(input.type)) p.set("type", input.type);
  if (refined(input.caseAssignment)) p.set("caseAssignment", input.caseAssignment);
  if (refined(input.reportReady)) p.set("reportReady", input.reportReady);
  if (refined(input.tsaStatus)) p.set("tsaStatus", input.tsaStatus);
  if (refined(input.otsStatus)) p.set("otsStatus", input.otsStatus);
  if (refined(input.publicVerifyState)) p.set("publicVerifyState", input.publicVerifyState);
  if (refined(input.verificationStatus)) p.set("verificationStatus", input.verificationStatus);
  if (refined(input.source)) p.set("acquisition", input.source);
}

/** Build the GET /v1/evidence query string from the current filter state. */
export function buildLibraryQuery(input: LibraryQueryInput): string {
  const p = new URLSearchParams({ scope: input.scope, limit: String(input.limit ?? 50), sort: input.sort });
  setFilterParams(p, input);
  if (input.cursor) p.set("cursor", input.cursor);
  return `/v1/evidence?${p.toString()}`;
}

/** The library filter state → the list route's params (page.tsx:345). */
export function filtersToQuery(filters: LibraryFilters, cursor: string | null = null): LibraryQueryInput {
  return {
    scope: filters.scope,
    search: filters.search,
    status: filters.status,
    type: filters.type,
    source: filters.acquisition,
    caseAssignment: filters.caseAssignment,
    reportReady:
      filters.exportReadiness === "report-available"
        ? "ready"
        : filters.exportReadiness === "report-missing"
          ? "missing"
          : "all",
    tsaStatus: filters.tsaStatus,
    otsStatus: filters.otsStatus,
    publicVerifyState: filters.publicVerifyState,
    verificationStatus: filters.verificationStatus,
    sort: filters.sort,
    cursor,
    limit: 50,
  };
}

/**
 * GET /v1/evidence/library-summary — the SAME filters as the list, so the
 * workspace counts follow what is applied (page.tsx:80). It used to send the
 * scope alone, so a filtered library showed unfiltered totals.
 */
export function buildLibrarySummaryPath(filters: LibraryFilters): string {
  const p = new URLSearchParams({ scope: filters.scope });
  const q = filtersToQuery(filters);
  q.search = filters.search.trim() || undefined;
  setFilterParams(p, q);
  return `/v1/evidence/library-summary?${p.toString()}`;
}

/** True when any refinement is active (drives a "clear" affordance). */
export function hasActiveFilters(input: Partial<Record<string, string | undefined>>): boolean {
  return Object.values(input).some((v) => refined(v ?? undefined));
}

/** The refinements beyond scope/sort/search that the Filters panel carries. */
export function filterPanelActive(f: LibraryFilters): boolean {
  return hasActiveFilters({
    status: f.status,
    type: f.type,
    review: f.review,
    exportReadiness: f.exportReadiness,
    caseAssignment: f.caseAssignment,
    retention: f.retention,
    acquisition: f.acquisition,
  });
}

/** The web's "hasCustomFilters" (page.tsx:600): anything different from the defaults. */
export function filtersAreDefault(f: LibraryFilters): boolean {
  return (Object.keys(DEFAULT_LIBRARY_FILTERS) as Array<keyof LibraryFilters>).every(
    (k) => f[k] === DEFAULT_LIBRARY_FILTERS[k],
  );
}

/* ------------------------------------------------ Trust-signal deep links */

export type TrustChipKey = "tsaStatus" | "otsStatus" | "publicVerifyState" | "verificationStatus";

function humaniseTrustFilterValue(raw: string): string {
  return raw
    .split(",")
    .map((v) => v.trim().toUpperCase().replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()))
    .join(" / ");
}

/** ActiveTrustFilterChips (page.tsx:164) — the reason a deep-linked list is reduced. */
export function activeTrustChips(f: LibraryFilters): Array<{ key: TrustChipKey; label: string }> {
  const chips: Array<{ key: TrustChipKey; label: string }> = [];
  if (refined(f.tsaStatus)) chips.push({ key: "tsaStatus", label: `Trust timestamp: ${humaniseTrustFilterValue(f.tsaStatus)}` });
  if (refined(f.otsStatus)) chips.push({ key: "otsStatus", label: `Blockchain anchor: ${humaniseTrustFilterValue(f.otsStatus)}` });
  if (refined(f.publicVerifyState)) chips.push({ key: "publicVerifyState", label: `Public verification: ${humaniseTrustFilterValue(f.publicVerifyState)}` });
  if (refined(f.verificationStatus)) {
    chips.push({
      key: "verificationStatus",
      label: /REVIEW_REQUIRED.*FAILED|FAILED.*REVIEW_REQUIRED/i.test(f.verificationStatus)
        ? "Needs integrity review"
        : humaniseTrustFilterValue(f.verificationStatus),
    });
  }
  return chips;
}

/**
 * readUrlFilterOverrides (page.tsx:220) — a deep link such as
 * `/evidence?tsaStatus=FAILED` lands on a pre-filtered library.
 */
export function readFilterOverrides(params: Record<string, unknown>): Partial<LibraryFilters> {
  const one = (k: string): string | null => {
    const v = params[k];
    const s = Array.isArray(v) ? v[0] : v;
    return typeof s === "string" && s.trim() ? s.trim() : null;
  };
  const out: Partial<LibraryFilters> = {};
  const tsa = one("tsaStatus");
  if (tsa) out.tsaStatus = tsa.toUpperCase();
  const ots = one("otsStatus");
  if (ots) out.otsStatus = ots.toUpperCase();
  const pv = one("publicVerifyState");
  if (pv) out.publicVerifyState = pv.toUpperCase();
  const vs = one("verificationStatus");
  if (vs) out.verificationStatus = vs.toUpperCase();
  const acq = one("acquisition");
  if (acq) out.acquisition = acq.toUpperCase();
  const status = one("status");
  if (status) out.status = status.toLowerCase();
  const type = one("type");
  if (type) out.type = type.toLowerCase();
  return out;
}

/* ---------------------------------------------------- Loaded-row filters */

/** The fields of a list row (mapEvidenceListItem) the client-side rules read. */
export interface LibraryRowFacts {
  id: string;
  status?: string | null;
  verificationStatus?: string | null;
  reviewReadyAtUtc?: string | null;
  reportReady?: boolean | null;
  caseId?: string | null;
  itemCount?: number | null;
  storage?: { verified?: boolean } | null;
}

export type ReviewPriorityLevel = "critical" | "operational" | "informational" | "stable";

/**
 * buildReviewPriority (evidence-library-alerts.ts:96) over the facts a LIST
 * row carries. The route's `sort=priority` orders by creation time exactly as
 * `newest` does (getEvidenceListOrderBy), so "Reviewer priority" was a
 * relabelled "Newest" on the phone. The web re-orders the loaded rows by
 * this level; native now does the same.
 */
export function reviewPriorityLevel(item: LibraryRowFacts, scope: string): ReviewPriorityLevel {
  const vs = String(item.verificationStatus ?? "").trim().toUpperCase();
  if (vs === "FAILED") return "critical";
  const reportMissing = item.reportReady !== true && (item.status === "SIGNED" || item.status === "REPORTED");
  if (scope === "trash" || vs === "REVIEW_REQUIRED" || reportMissing) return "operational";
  if (!item.caseId) return "informational";
  return "stable";
}

const PRIORITY_ORDER: Record<ReviewPriorityLevel, number> = { critical: 3, operational: 2, informational: 1, stable: 0 };

/** The web's visibleItems (page.tsx:633): review + retention, then priority order. */
export function applyLoadedRowFilters<T extends LibraryRowFacts>(items: readonly T[], f: LibraryFilters): T[] {
  const next = items.filter((item) => {
    const vs = String(item.verificationStatus ?? "").toUpperCase();
    if (f.review === "review-ready" && !item.reviewReadyAtUtc) return false;
    if (f.review === "review-required" && vs !== "REVIEW_REQUIRED") return false;
    if (f.review === "verification-failed" && vs !== "FAILED") return false;
    if (f.retention === "protected" && !item.storage?.verified) return false;
    if (f.retention === "unprotected" && item.storage?.verified) return false;
    return true;
  });
  if (f.sort === "priority") {
    // Array.prototype.sort is stable, so equal levels keep the server order.
    next.sort((a, b) => PRIORITY_ORDER[reviewPriorityLevel(b, f.scope)] - PRIORITY_ORDER[reviewPriorityLevel(a, f.scope)]);
  }
  return next;
}

/* ------------------------------------------------------------- Row display */

/** web lib/short-id.ts — head 8, tail 6, at a 14-character threshold. */
export function shortId(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (!text) return "Not available";
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}…${text.slice(-6)}`;
}

/** getRecordStatusLabel (evidence-library-status.ts:168). */
export function recordStatusLabel(status: string | null | undefined): string {
  switch (String(status ?? "").trim().toUpperCase()) {
    case "REPORTED":
      return "Reported";
    case "SIGNED":
      return "Signed";
    case "UPLOADED":
      return "Uploaded";
    case "UPLOADING":
      return "Uploading";
    case "CREATED":
      return "Created";
    default:
      return "Status not recorded";
  }
}

/** getVerificationStatusLabel (evidence-library-status.ts:185). */
export function verificationStatusLabel(status: string | null | undefined): string {
  switch (String(status ?? "").trim().toUpperCase()) {
    case "RECORDED_INTEGRITY_VERIFIED":
      return "Recorded integrity state verified";
    case "MATERIALS_AVAILABLE":
      return "Technical materials available";
    case "REVIEW_REQUIRED":
      return "Review required";
    case "FAILED":
      return "Verification failed";
    default:
      return "Verification status not recorded";
  }
}

/**
 * EvidenceLibraryRow's activity line: "N items • Status", plus how the record
 * entered PROOVRA when it is not an ordinary upload.
 */
export function rowActivityLine(item: {
  itemCount?: number | null;
  status?: string | null;
  acquisition?: { category?: string | null; label?: string | null } | null;
}): string {
  const count = typeof item.itemCount === "number" && item.itemCount > 0 ? item.itemCount : 1;
  const parts = [`${count} item${count === 1 ? "" : "s"}`, recordStatusLabel(item.status)];
  const acq = item.acquisition;
  if (acq && acq.category && acq.category !== "UPLOAD" && acq.label) parts.push(acq.label);
  return parts.join(" • ");
}

/* ------------------------------------------------------------- Library summary */

export interface LibrarySummary {
  totalActiveRecords: number;
  reportsReadyCount: number;
  packagesReadyCount: number;
  packagesMissingCount: number;
  storageProtectedCount: number;
  multipartCount: number;
  unassignedCount: number;
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Parse GET /v1/evidence/library-summary. Null unless it is the real body —
 * the metric cards then fall back to honest page-derived labels.
 */
export function parseLibrarySummary(data: unknown): LibrarySummary | null {
  const d = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  if (!d || typeof d["totalActiveRecords"] !== "number") return null;
  return {
    totalActiveRecords: n(d["totalActiveRecords"]),
    reportsReadyCount: n(d["reportsReadyCount"]),
    packagesReadyCount: n(d["packagesReadyCount"]),
    packagesMissingCount: n(d["packagesMissingCount"]),
    storageProtectedCount: n(d["storageProtectedCount"]),
    multipartCount: n(d["multipartCount"]),
    unassignedCount: n(d["unassignedCount"]),
  };
}

export interface LibraryMetric {
  key: string;
  label: string;
  value: string;
  caption: string;
  tone?: ProovraStatusTone;
}

/**
 * The eight KPI cards (page.tsx:765), with the web's source captions so a
 * page-derived count is never read as a workspace total, and package
 * readiness is never proxied from the report version.
 */
export function buildLibraryMetrics(summary: LibrarySummary | null, visible: readonly LibraryRowFacts[]): LibraryMetric[] {
  const ws = "Workspace total";
  const page = "On this page";
  const count = (pred: (i: LibraryRowFacts) => boolean) => String(visible.filter(pred).length);
  return [
    { key: "active", label: "Active records", value: summary ? String(summary.totalActiveRecords) : String(visible.length), caption: summary ? ws : page },
    { key: "reports", label: "Reports ready", value: summary ? String(summary.reportsReadyCount) : count((i) => i.reportReady === true), caption: summary ? ws : page },
    { key: "packages-ready", label: "Verification packages ready", value: summary ? String(summary.packagesReadyCount) : "—", caption: summary ? ws : "Package readiness unavailable" },
    summary
      ? { key: "packages-missing", label: "Verification packages missing", value: String(summary.packagesMissingCount), caption: "Requires attention", ...(summary.packagesMissingCount > 0 ? { tone: "risk" as const } : {}) }
      : { key: "packages-missing", label: "Verification packages missing", value: "—", caption: "Package readiness unavailable" },
    { key: "storage", label: "Storage protection", value: summary ? String(summary.storageProtectedCount) : count((i) => i.storage?.verified === true), caption: "Encrypted states" },
    { key: "multipart", label: "Multipart packages", value: summary ? String(summary.multipartCount) : count((i) => (i.itemCount ?? 1) > 1), caption: "Active batches" },
    { key: "unassigned", label: "Unassigned records", value: summary ? String(summary.unassignedCount) : count((i) => !i.caseId), caption: "Awaiting triage" },
    { key: "review-ready", label: "Review-ready records", value: count((i) => Boolean(i.reviewReadyAtUtc)), caption: page, tone: "governance" },
  ];
}

/* --------------------------------------------------------------- Bulk actions */

export interface BulkActionSpec {
  action: EvidenceBulkActionName;
  label: string;
  destructive?: boolean;
}


export interface EvidenceBulkActionResult {
  evidenceId: string;
  ok: boolean;
  reason?: string;
}

export interface EvidenceBulkSelectionResponse {
  successCount?: number;
  failedCount?: number;
  results?: EvidenceBulkActionResult[];
  accepted?: boolean;
  queued?: boolean;
  pendingCount?: number;
}

/**
 * Resolve bulk selection only from an accepted TERMINAL server result.
 *
 * - total success -> no selection
 * - partial success -> failed ids remain selected
 * - queued/accepted-but-pending -> selection stays untouched
 * - malformed/non-terminal result -> selection stays untouched
 *
 * A request-level throw never calls this helper, so the original selection
 * also survives a refused request.
 */
export function resolveBulkSelection(
  selectedIds: readonly string[],
  response: EvidenceBulkSelectionResponse,
): string[] {
  if (response.accepted === true || response.queued === true) {
    return [...selectedIds];
  }

  if (!Array.isArray(response.results)) {
    return [...selectedIds];
  }

  const selected = new Set(selectedIds);
  const resultIds = new Set(
    response.results
      .map((result) => result.evidenceId)
      .filter((id) => selected.has(id)),
  );

  // A terminal response must account for the submitted selection. If it does
  // not, fail safe: never silently deselect records the server did not report.
  if (resultIds.size !== selected.size) {
    return [...selectedIds];
  }

  return response.results
    .filter((result) => !result.ok && selected.has(result.evidenceId))
    .map((result) => result.evidenceId);
}

export interface EvidenceBulkResponse extends EvidenceBulkSelectionResponse {
  updated?: number;
  csv?: string;
  fileName?: string;
}

/**
 * Parse POST /v1/evidence/bulk defensively.
 *
 * The canonical response reports per-record terminal results. A future queued
 * backend may instead report accepted/queued/pendingCount; callers must not
 * treat that state as completed.
 */
export function parseEvidenceBulkResponse(data: unknown): EvidenceBulkResponse {
  if (!data || typeof data !== "object") return {};
  const value = data as Record<string, unknown>;

  const results: EvidenceBulkActionResult[] | undefined = Array.isArray(value["results"])
    ? value["results"]
        .filter(
          (item: unknown): item is Record<string, unknown> =>
            !!item &&
            typeof item === "object" &&
            typeof (item as Record<string, unknown>)["evidenceId"] === "string" &&
            typeof (item as Record<string, unknown>)["ok"] === "boolean",
        )
        .map((item) => ({
          evidenceId: item["evidenceId"] as string,
          ok: item["ok"] as boolean,
          ...(typeof item["reason"] === "string"
            ? { reason: item["reason"] as string }
            : {}),
        }))
    : undefined;

  return {
    ...(typeof value["updated"] === "number"
      ? { updated: value["updated"] as number }
      : {}),
    ...(typeof value["successCount"] === "number"
      ? { successCount: value["successCount"] as number }
      : {}),
    ...(typeof value["failedCount"] === "number"
      ? { failedCount: value["failedCount"] as number }
      : {}),
    ...(results ? { results } : {}),
    ...(typeof value["accepted"] === "boolean"
      ? { accepted: value["accepted"] as boolean }
      : {}),
    ...(typeof value["queued"] === "boolean"
      ? { queued: value["queued"] as boolean }
      : {}),
    ...(typeof value["pendingCount"] === "number"
      ? { pendingCount: value["pendingCount"] as number }
      : {}),
    ...(typeof value["csv"] === "string"
      ? { csv: value["csv"] as string }
      : {}),
    ...(typeof value["fileName"] === "string" && (value["fileName"] as string).trim()
      ? { fileName: (value["fileName"] as string).trim() }
      : {}),
  };
}

/* ----------------------------------------- Bulk toolbar (BulkActionsToolbar) */

/** ACTION_LABELS (BulkActionsToolbar.tsx:30), verbatim. */
export const BULK_ACTION_LABELS: Record<EvidenceBulkActionName, string> = {
  ADD_TO_CASE: "Add to Case",
  REMOVE_FROM_CASE: "Remove from Case",
  ARCHIVE: "Archive",
  RESTORE_ARCHIVED: "Restore Archived",
  TRASH: "Move to Trash",
  RESTORE_TRASH: "Restore from Trash",
  EXPORT_METADATA_CSV: "Export Metadata CSV",
};

/** ACTION_VERB (BulkActionsToolbar.tsx:54) — the three tenses the dialog needs. */
export const BULK_ACTION_VERBS: Record<EvidenceBulkActionName, { pending: string; past: string; gerund: string }> = {
  ADD_TO_CASE: { pending: "Adding…", past: "added to the case", gerund: "added" },
  REMOVE_FROM_CASE: { pending: "Removing…", past: "removed from their cases", gerund: "removed" },
  ARCHIVE: { pending: "Archiving…", past: "archived", gerund: "archived" },
  RESTORE_ARCHIVED: { pending: "Restoring…", past: "restored", gerund: "restored" },
  TRASH: { pending: "Moving to trash…", past: "moved to trash", gerund: "moved to trash" },
  RESTORE_TRASH: { pending: "Restoring…", past: "restored", gerund: "restored" },
  EXPORT_METADATA_CSV: { pending: "Exporting…", past: "exported", gerund: "exported" },
};

const FAILURE_CATEGORIES: Array<{ key: string; label: string; match: RegExp }> = [
  { key: "retention", label: "Protected by retention", match: /RETENTION/i },
  { key: "legal_hold", label: "Legal hold", match: /LEGAL_HOLD/i },
  { key: "already_archived", label: "Already archived", match: /ALREADY_ARCHIVED/i },
  { key: "permission", label: "Insufficient permission", match: /FORBIDDEN|NOT_PERMITTED|PERMISSION|not found|ADMIN_ONLY/i },
  { key: "conflict", label: "Record changed since selection", match: /LOCKED|CONFLICT|STALE|VERSION|not assigned|deleted evidence/i },
];

/** categoriseBulkFailure (BulkActionsToolbar.tsx:94) — from the server's own per-record reason. */
export function categoriseBulkFailure(reason: string | undefined | null): { key: string; label: string } {
  const text = reason ?? "";
  const hit = FAILURE_CATEGORIES.find((c) => c.match.test(text));
  return hit ? { key: hit.key, label: hit.label } : { key: "unknown", label: "Unknown server failure" };
}

export function groupBulkFailures(results: readonly EvidenceBulkActionResult[] | undefined): Array<{ key: string; label: string; count: number }> {
  const groups = new Map<string, { label: string; count: number }>();
  for (const r of results ?? []) {
    if (r.ok) continue;
    const c = categoriseBulkFailure(r.reason);
    const g = groups.get(c.key);
    if (g) g.count += 1;
    else groups.set(c.key, { label: c.label, count: 1 });
  }
  return [...groups.entries()].map(([key, v]) => ({ key, ...v }));
}

/** isQueued (BulkActionsToolbar.tsx:119): accepted, not finished. */
export function isBulkQueued(r: EvidenceBulkResponse): boolean {
  return Boolean(r.queued || r.accepted) && (r.successCount ?? 0) === 0 && (r.failedCount ?? 0) === 0;
}

/** isRequestValidationFailure (BulkActionsToolbar.tsx:109). */
export function isBulkValidationFailure(error: unknown): boolean {
  const e = (error && typeof error === "object" ? error : {}) as { statusCode?: unknown; code?: unknown };
  const code = typeof e.code === "string" ? e.code.toUpperCase() : "";
  return e.statusCode === 400 || code === "INVALID_INPUT" || code === "VALIDATION_ERROR";
}

/**
 * The lifecycle verdict a list row carries (`lifecycle`, the canonical
 * projection mapEvidenceListItem attaches). Absent → null, never "allowed".
 */
export function bulkLifecycleCapability(
  item: { lifecycle?: unknown },
  action: EvidenceBulkActionName,
): boolean | null {
  const l = item.lifecycle && typeof item.lifecycle === "object" ? (item.lifecycle as Record<string, unknown>) : null;
  if (!l) return null;
  const key =
    action === "ARCHIVE" ? "canArchive"
      : action === "RESTORE_ARCHIVED" ? "canUnarchive"
        : action === "TRASH" ? "canTrash"
          : action === "RESTORE_TRASH" ? "canRestoreFromTrash"
            : null;
  if (!key) return null;
  return l[key] === true;
}

export function isLifecycleBulkAction(action: EvidenceBulkActionName): boolean {
  return action === "ARCHIVE" || action === "RESTORE_ARCHIVED" || action === "TRASH" || action === "RESTORE_TRASH";
}

/** Records the server's own lifecycle projection says the action cannot touch. */
export function countBulkProtected(items: ReadonlyArray<{ lifecycle?: unknown }>, action: EvidenceBulkActionName): number {
  return items.filter((i) => bulkLifecycleCapability(i, action) === false).length;
}

export function safeCsvFilename(value: string | undefined): string {
  const fallback = "proovra-evidence-metadata.csv";
  if (!value?.trim()) return fallback;

  const clean = value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ");

  if (!clean) return fallback;
  return clean.toLowerCase().endsWith(".csv") ? clean : `${clean}.csv`;
}


/* --------------------------------------------------------- Native Inspector */

export interface InspectorContentItem {
  id: string;
  label: string | null;
  originalFileName: string | null;
  mimeType: string | null;
  kind: string;
  previewable: boolean;
  viewUrl: string | null;
  isPrimary: boolean;
}

export interface InspectorEvidence {
  id: string;
  type: string;
  status: string;
  statusLabel: string | null;
  verificationStatus: string | null;
  verificationStatusLabel: string | null;
  /**
   * ACTIVE / ARCHIVED / TRASHED / LOCKED / DESTROYED.
   *
   * The scope tabs already separate archived and trashed records, so this
   * looks redundant — until LOCKED, which coexists with ACTIVE. A locked
   * record inside the Active scope was rendering identically to an unlocked
   * one, and "this cannot be changed" is not a detail to leave the user to
   * discover by trying.
   */
  lifecycleState: string | null;
  displayTitle: string | null;
  displayFileName: string | null;
  originalFileName: string | null;
  createdAt: string | null;
  defaultPreviewItemId: string | null;
  contentAccessMode: string | null;
  allowContentView: boolean | null;
  contentItems: InspectorContentItem[];
  /** getAnchorStatus — `anchor` on GET /v1/evidence/:id. */
  anchor: { configured: boolean; mode: string | null; anchoredAtUtc: string | null } | null;
}

export type InspectorPreview =
  | { kind: "restricted" }
  | { kind: "unavailable" }
  | { kind: "unsupported"; item: InspectorContentItem }
  | { kind: "image"; item: InspectorContentItem; url: string }
  | { kind: "external"; item: InspectorContentItem; url: string };

export interface InspectorArtifactState {
  report: string | null;
  verificationPackage: string | null;
}

function inspectorObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function inspectorString(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

export function projectInspectorEvidence(data: unknown): InspectorEvidence | null {
  const root = inspectorObject(data);
  const evidence = inspectorObject(root["evidence"]);
  const id = inspectorString(evidence["id"]);

  if (!id) return null;

  const access = inspectorObject(evidence["contentAccessPolicy"]);
  const rawItems = Array.isArray(evidence["contentItems"])
    ? evidence["contentItems"]
    : [];

  const contentItems: InspectorContentItem[] = rawItems
    .map((raw): InspectorContentItem | null => {
      const item = inspectorObject(raw);
      const itemId = inspectorString(item["id"]);
      if (!itemId) return null;

      return {
        id: itemId,
        label: inspectorString(item["label"]),
        originalFileName: inspectorString(item["originalFileName"]),
        mimeType: inspectorString(item["mimeType"]),
        kind: inspectorString(item["kind"]) ?? "other",
        previewable: item["previewable"] === true,
        viewUrl: inspectorString(item["viewUrl"]),
        isPrimary: item["isPrimary"] === true,
      };
    })
    .filter((item): item is InspectorContentItem => item !== null);

  return {
    id,
    type: inspectorString(evidence["type"]) ?? "Evidence",
    status: inspectorString(evidence["status"]) ?? "CREATED",
    statusLabel: inspectorString(evidence["statusLabel"]),
    verificationStatus: inspectorString(evidence["verificationStatus"]),
    verificationStatusLabel: inspectorString(evidence["verificationStatusLabel"]),
    // GET /v1/evidence/:id sends the lifecycle projection at `lifecycle.productState`
    // (EVIDENCE_LIFECYCLE_RESPONSE_FIELD); `lifecycleState` is never sent, so the
    // inspector's lifecycle badge (Archived / Trash) never rendered.
    lifecycleState: inspectorString(
      (evidence["lifecycle"] && typeof evidence["lifecycle"] === "object" ? (evidence["lifecycle"] as Record<string, unknown>) : {})["productState"],
    ),
    displayTitle: inspectorString(evidence["displayTitle"]),
    displayFileName: inspectorString(evidence["displayFileName"]),
    originalFileName: inspectorString(evidence["originalFileName"]),
    createdAt: inspectorString(evidence["createdAt"]),
    defaultPreviewItemId: inspectorString(evidence["defaultPreviewItemId"]),
    contentAccessMode: inspectorString(access["mode"]),
    allowContentView:
      typeof access["allowContentView"] === "boolean"
        ? (access["allowContentView"] as boolean)
        : null,
    contentItems,
    anchor: (() => {
      const a = evidence["anchor"];
      if (!a || typeof a !== "object") return null;
      const r = a as Record<string, unknown>;
      return { configured: r["configured"] === true, mode: inspectorString(r["mode"]), anchoredAtUtc: inspectorString(r["anchoredAtUtc"]) };
    })(),
  };
}

export function resolveInspectorPreview(
  evidence: InspectorEvidence,
): InspectorPreview {
  if (
    evidence.contentAccessMode === "metadata_only" ||
    evidence.allowContentView === false
  ) {
    return { kind: "restricted" };
  }

  const item =
    evidence.contentItems.find(
      (candidate) => candidate.id === evidence.defaultPreviewItemId,
    ) ??
    evidence.contentItems.find((candidate) => candidate.isPrimary) ??
    evidence.contentItems.find((candidate) => candidate.previewable) ??
    null;

  if (!item) return { kind: "unavailable" };
  if (!item.previewable) return { kind: "unsupported", item };
  if (!item.viewUrl) return { kind: "restricted" };
  if (item.kind === "other") return { kind: "unsupported", item };

  const mime = item.mimeType?.toLowerCase() ?? "";
  const kind = item.kind.toLowerCase();

  if (kind === "image" || mime.startsWith("image/")) {
    return { kind: "image", item, url: item.viewUrl };
  }

  return { kind: "external", item, url: item.viewUrl };
}

export function projectInspectorArtifactState(
  data: unknown,
): InspectorArtifactState {
  const outputs = inspectorObject(inspectorObject(data)["outputs"]);
  const report = inspectorObject(outputs["report"]);
  const verificationPackage = inspectorObject(
    outputs["verificationPackage"] ?? outputs["package"],
  );

  return {
    report: inspectorString(report["state"]),
    verificationPackage: inspectorString(verificationPackage["state"]),
  };
}

/**
 * The legacy blocks of GET /v1/evidence/:id/artifacts/status that carry the
 * timestamps and the PDF signature the web's artifact rows describe
 * (EvidenceArtifactStatus.report / .verificationPackage).
 */
export interface InspectorArtifactFacts {
  reportGeneratedAtUtc: string | null;
  pdfSignatureStatus: string | null;
  pdfSignatureWarning: string | null;
  packageGeneratedAtUtc: string | null;
  packageVersion: number | null;
}

export function projectInspectorArtifactFacts(data: unknown): InspectorArtifactFacts {
  const root = inspectorObject(data);
  const report = inspectorObject(root["report"]);
  const sig = inspectorObject(report["pdfSignature"]);
  const pkg = inspectorObject(root["verificationPackage"]);
  return {
    reportGeneratedAtUtc: report["available"] === true ? inspectorString(report["generatedAtUtc"]) : null,
    pdfSignatureStatus: inspectorString(sig["status"]),
    pdfSignatureWarning: inspectorString(sig["warning"]),
    packageGeneratedAtUtc: pkg["available"] === true ? inspectorString(pkg["generatedAtUtc"]) : null,
    packageVersion: pkg["available"] === true && typeof pkg["version"] === "number" ? (pkg["version"] as number) : null,
  };
}

/** review-workspace.workspaceCapabilitySnapshot — the three flags the Inspector reads. */
export interface InspectorCapabilities {
  reportsIncluded: boolean;
  verificationPackageIncluded: boolean;
  publicVerifyIncluded: boolean;
}

export function projectInspectorCapabilities(reviewWorkspace: unknown): InspectorCapabilities | null {
  const snap = reviewWorkspace && typeof reviewWorkspace === "object"
    ? (reviewWorkspace as Record<string, unknown>)["workspaceCapabilitySnapshot"]
    : null;
  if (!snap || typeof snap !== "object") return null;
  const s = snap as Record<string, unknown>;
  return {
    reportsIncluded: s["reportsIncluded"] === true,
    verificationPackageIncluded: s["verificationPackageIncluded"] === true,
    publicVerifyIncluded: s["publicVerifyIncluded"] === true,
  };
}

export type InspectorArtifactRowState =
  | "available"
  | "pending"
  | "missing"
  | "failed"
  | "disabled"
  | "restricted"
  | "not-configured";

export interface InspectorArtifactRow {
  key: "report" | "package" | "public-verification";
  title: string;
  state: InspectorArtifactRowState;
  detail: string;
}

/** STATE_LABEL (QueueSelectionPreview.tsx:81). */
export const ARTIFACT_STATE_LABEL: Record<InspectorArtifactRowState, string> = {
  available: "Available",
  pending: "Generating",
  missing: "Not recorded",
  failed: "Failed",
  disabled: "Not in plan",
  restricted: "Restricted",
  "not-configured": "Not configured",
};

/** STATE_TONE (QueueSelectionPreview.tsx:91) in the native tone vocabulary. */
export const ARTIFACT_STATE_TONE: Record<InspectorArtifactRowState, ProovraStatusTone> = {
  available: "verified",
  pending: "governance",
  missing: "neutral",
  failed: "risk",
  disabled: "neutral",
  restricted: "pending",
  "not-configured": "neutral",
};

export interface InspectorArtifactInput {
  /** The list row's `reportReady` (mapEvidenceListItem). */
  rowReportReady: boolean;
  outputs: InspectorArtifactState | null;
  facts: InspectorArtifactFacts | null;
  capabilities: InspectorCapabilities | null;
  anchor: InspectorEvidence["anchor"];
  formatDate: (iso: string) => string;
}

const IN_FLIGHT = new Set(["QUEUED", "GENERATING"]);
const FAILED = new Set(["TERMINAL_FAILURE", "RETRYABLE_FAILURE"]);

export function inspectorReportAvailable(input: Pick<InspectorArtifactInput, "rowReportReady" | "outputs">): boolean {
  return input.outputs?.report === "READY" || input.rowReportReady;
}

export function inspectorPackageAvailable(input: Pick<InspectorArtifactInput, "outputs" | "facts">): boolean {
  return input.outputs?.verificationPackage === "READY" || Boolean(input.facts?.packageGeneratedAtUtc) || input.facts?.packageVersion != null;
}

/**
 * The three artifact rows (QueueSelectionPreview.tsx:122-264), with the
 * web's precedence: an artifact that EXISTS is described as what it is, and
 * the commercial answer is for records that have none. Native reads the
 * canonical output state (`outputs.*.state`) where the web reads the
 * download routes, so the Inspector never mints a URL on open.
 */
export function buildInspectorArtifactRows(input: InspectorArtifactInput): InspectorArtifactRow[] {
  const reportState = input.outputs?.report ?? null;
  const pkgState = input.outputs?.verificationPackage ?? null;
  const reportAvailable = inspectorReportAvailable(input);
  const pkgAvailable = inspectorPackageAvailable(input);

  let report: InspectorArtifactRow;
  if (!reportAvailable && (reportState === "NOT_INCLUDED" || input.capabilities?.reportsIncluded === false)) {
    report = { key: "report", title: "Report", state: "disabled", detail: "PDF reports are not included for this evidence record." };
  } else if (input.facts?.pdfSignatureStatus === "SIGNING_FAILED") {
    report = {
      key: "report",
      title: "Report",
      state: "failed",
      detail: input.facts.pdfSignatureWarning || "The report artifact was produced but its signature step failed.",
    };
  } else if (reportState === "READY" && input.facts?.reportGeneratedAtUtc) {
    report = { key: "report", title: "Report available", state: "available", detail: `Generated ${input.formatDate(input.facts.reportGeneratedAtUtc)}` };
  } else if (reportAvailable) {
    report = { key: "report", title: "Report", state: "pending", detail: "The record is marked report-ready. The artifact is not yet projected here." };
  } else if (reportState && IN_FLIGHT.has(reportState)) {
    report = { key: "report", title: "Report", state: "pending", detail: "The report is being generated for this record." };
  } else if (reportState && FAILED.has(reportState)) {
    report = { key: "report", title: "Report", state: "failed", detail: "Report generation did not complete for this record." };
  } else if (reportState === "BLOCKED") {
    report = { key: "report", title: "Report", state: "restricted", detail: "Report generation is blocked for this record." };
  } else {
    report = { key: "report", title: "Report", state: "missing", detail: "No generated report is recorded for this record." };
  }

  let pkg: InspectorArtifactRow;
  if (!pkgAvailable && (pkgState === "NOT_INCLUDED" || input.capabilities?.verificationPackageIncluded === false)) {
    pkg = { key: "package", title: "Verification package", state: "disabled", detail: "Verification packages are not included for this evidence record." };
  } else if (pkgAvailable) {
    pkg = {
      key: "package",
      title: "Verification package ready",
      state: "available",
      detail: input.facts?.packageGeneratedAtUtc
        ? `Generated ${input.formatDate(input.facts.packageGeneratedAtUtc)}`
        : `Package version ${input.facts?.packageVersion ?? "recorded"}.`,
    };
  } else if (pkgState && IN_FLIGHT.has(pkgState)) {
    pkg = { key: "package", title: "Verification package", state: "pending", detail: "The record reports a package build. The artifact is not yet projected here." };
  } else if (pkgState && FAILED.has(pkgState)) {
    pkg = { key: "package", title: "Verification package", state: "failed", detail: "Verification package generation did not complete for this record." };
  } else if (pkgState === "BLOCKED") {
    pkg = { key: "package", title: "Verification package", state: "restricted", detail: "Verification package generation is blocked for this record." };
  } else {
    pkg = { key: "package", title: "Verification package", state: "missing", detail: "No verification package is recorded for this record." };
  }

  const anchor = input.anchor;
  let pub: InspectorArtifactRow;
  if (!input.capabilities?.publicVerifyIncluded) {
    pub = { key: "public-verification", title: "Public verification", state: "disabled", detail: "Public verification is not included in this workspace plan." };
  } else if (!anchor?.configured || anchor.mode === "off") {
    pub = { key: "public-verification", title: "Public verification", state: "not-configured", detail: "Not configured for this record." };
  } else if (anchor.mode === "active" && anchor.anchoredAtUtc) {
    pub = { key: "public-verification", title: "Public verification", state: "available", detail: `Anchored ${input.formatDate(anchor.anchoredAtUtc)}` };
  } else {
    pub = { key: "public-verification", title: "Public verification", state: "pending", detail: "The anchor is configured. No anchored timestamp is recorded yet." };
  }

  return [report, pkg, pub];
}

/** The footer's disabled reasons (QueueSelectionPreview.tsx:586-596), stated as text. */
export function inspectorActionReasons(input: Pick<InspectorArtifactInput, "rowReportReady" | "outputs" | "facts" | "capabilities" | "anchor">): {
  report: string | null;
  package: string | null;
  link: string | null;
} {
  return {
    report: inspectorReportAvailable(input) ? null : "No generated report is recorded for this record.",
    package: inspectorPackageAvailable(input) ? null : "No verification package is recorded for this record.",
    link: !input.capabilities?.publicVerifyIncluded
      ? "Public verification is not included in this workspace plan."
      : !input.anchor?.configured
        ? "No public verification anchor is configured for this record."
        : null,
  };
}

/* ------------------------------------------------------------- Saved views */

export interface SavedViewItem {
  id: string;
  name: string;
  description: string | null;
  /** A workspace ("Team view") view, or null for a personal one. */
  teamId: string | null;
  scope: string; // native scope ("active"|"archived"|"trash"|"locked")
  type: string; // "all" or a type filter value (TYPE_OPTIONS)
  status: string; // "all" or a lower-case EvidenceStatus
  search: string;
  review: string;
  exportReadiness: string;
  caseAssignment: string;
  retention: string;
  sort: LibrarySort;
  isDefault: boolean;
}

/** Server stores trash as "deleted"; native uses "trash". */
function scopeFromServer(s: string): string {
  return s === "deleted" ? "trash" : s;
}
function scopeToServer(s: string): "active" | "archived" | "deleted" | "locked" {
  return (s === "trash" ? "deleted" : s) as "active" | "archived" | "deleted" | "locked";
}
function toSort(v: unknown): LibrarySort {
  return v === "oldest" || v === "priority" ? v : "newest";
}
function allOr(v: unknown): string {
  return typeof v === "string" && v && v !== "all" && v !== "ALL" ? v : "all";
}
/** Views an older native build saved carry the enum spelling (PHOTO, SIGNED). */
function typeValue(v: unknown): string {
  const raw = allOr(v).toLowerCase();
  return raw === "photo" ? "image" : raw;
}

/** One row of a record picker: an id and a title that is never blank. */
export interface EvidencePickerRow {
  id: string;
  title: string;
  subtitle: string | null;
}

/**
 * The reader's own library, reduced to what a picker needs.
 *
 * Used by the batch-analysis picker and the evidence-relationship picker. A
 * row with no id is dropped rather than rendered as an unselectable line, and
 * the title falls back through the same cascade the library list uses, so a
 * record with no title is still identifiable rather than blank.
 */
export function parseEvidencePickerRows(payload: unknown): EvidencePickerRow[] {
  const d = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const list = Array.isArray(d.items) ? d.items : Array.isArray(d.data) ? d.data : [];
  return list
    .map((raw) => {
      const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const id = typeof e.id === "string" && e.id.length > 0 ? e.id : null;
      if (!id) return null;
      const title =
        (typeof e.title === "string" && e.title) ||
        (typeof e.displayTitle === "string" && e.displayTitle) ||
        (typeof e.fileName === "string" && e.fileName) ||
        (typeof e.originalFileName === "string" && e.originalFileName) ||
        id;
      const status = typeof e.status === "string" ? e.status : null;
      const type = typeof e.type === "string" ? e.type : null;
      const subtitle = [type, status].filter(Boolean).join(" · ");
      return { id, title, subtitle: subtitle.length > 0 ? subtitle : null };
    })
    .filter((r): r is EvidencePickerRow => r !== null);
}

/** Parse GET /v1/evidence/saved-views → { items } into the fields native captures. */
export function parseSavedViews(data: unknown): SavedViewItem[] {
  const d = (data && typeof data === "object" ? (data as Record<string, unknown>) : {});
  const items = Array.isArray(d["items"]) ? (d["items"] as unknown[]) : [];
  const out: SavedViewItem[] = [];
  for (const raw of items) {
    const v = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {});
    const id = typeof v["id"] === "string" ? (v["id"] as string) : null;
    const name = typeof v["name"] === "string" ? (v["name"] as string) : null;
    if (!id || !name) continue;
    const filters = (v["filters"] && typeof v["filters"] === "object" ? (v["filters"] as Record<string, unknown>) : {});
    out.push({
      id,
      name,
      description: typeof v["description"] === "string" && v["description"].trim() ? (v["description"] as string) : null,
      teamId: typeof v["teamId"] === "string" && v["teamId"] ? (v["teamId"] as string) : null,
      scope: scopeFromServer(typeof v["scope"] === "string" ? (v["scope"] as string) : "active"),
      type: typeValue(filters["type"]),
      status: allOr(filters["status"]).toLowerCase(),
      search: typeof filters["search"] === "string" ? (filters["search"] as string) : "",
      review: allOr(filters["review"]),
      exportReadiness: allOr(filters["exportReadiness"]),
      caseAssignment: allOr(filters["caseAssignment"]),
      retention: allOr(filters["retention"]),
      sort: toSort(v["sortKey"] ?? filters["sort"]),
      isDefault: v["isDefault"] === true,
    });
  }
  return out;
}

/** applySavedView (page.tsx:945): the defaults, overlaid with the view. */
export function savedViewToFilters(v: SavedViewItem): LibraryFilters {
  const scope = (["active", "archived", "trash", "locked"].includes(v.scope) ? v.scope : "active") as LibraryScope;
  return {
    ...DEFAULT_LIBRARY_FILTERS,
    scope,
    search: v.search,
    status: v.status,
    type: v.type,
    review: v.review,
    exportReadiness: v.exportReadiness,
    caseAssignment: v.caseAssignment,
    retention: v.retention,
    sort: v.sort,
  };
}

/** SavedViewsMenu.tsx:109 — "Scope: … • Sort: … • Personal view • Default". */
export function savedViewMetaLine(v: SavedViewItem): string {
  return `Scope: ${v.scope} • Sort: ${v.sort}${v.teamId ? " • Team view" : " • Personal view"}${v.isDefault ? " • Default" : ""}`;
}

/**
 * Build the POST /v1/evidence/saved-views body (CreateSavedViewBody) from the
 * current filters, as the web does (page.tsx:969). `acquisition` is not part
 * of SavedViewFiltersSchema, so it is not sent — and the sheet says so.
 */
export function buildSavedViewBody(input: {
  name: string;
  description?: string;
  isDefault?: boolean;
  teamId?: string | null;
  filters: LibraryFilters;
}) {
  const f = input.filters;
  const scope = scopeToServer(f.scope);
  return {
    name: input.name.trim(),
    description: input.description?.trim() ? input.description.trim() : null,
    isDefault: input.isDefault === true,
    teamId: input.teamId ? input.teamId : null,
    scope,
    sortKey: f.sort,
    filters: {
      search: f.search.trim(),
      scope,
      status: f.status,
      type: f.type,
      review: f.review,
      exportReadiness: f.exportReadiness,
      caseAssignment: f.caseAssignment,
      retention: f.retention,
      tsaStatus: f.tsaStatus,
      otsStatus: f.otsStatus,
      publicVerifyState: f.publicVerifyState,
      verificationStatus: f.verificationStatus,
      sort: f.sort,
    },
  };
}

/** "Update Saved View" (SavedViewsMenu.tsx:173): name, description, default. */
export function buildSavedViewUpdateBody(input: { name: string; description: string; isDefault: boolean }) {
  return { name: input.name.trim(), description: input.description.trim(), isDefault: input.isDefault };
}

/**
 * The "Team view: <name>" options (page.tsx:936): the envelope's canonical
 * owned-workspace list, identity only.
 */
export function savedViewTeamOptions(envelope: unknown): Array<{ id: string; name: string }> {
  const env = envelope && typeof envelope === "object" ? (envelope as Record<string, unknown>) : {};
  const opts = env["contextOptions"] && typeof env["contextOptions"] === "object" ? (env["contextOptions"] as Record<string, unknown>) : {};
  const rows = Array.isArray(opts["ownedWorkspaces"]) ? (opts["ownedWorkspaces"] as unknown[]) : [];
  return rows
    .map((raw) => {
      const w = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const id = typeof w["workspaceId"] === "string" ? (w["workspaceId"] as string) : null;
      if (!id) return null;
      return { id, name: typeof w["name"] === "string" && w["name"] ? (w["name"] as string) : "Workspace" };
    })
    .filter((x): x is { id: string; name: string } => x !== null);
}

/** One saved view: `/v1/evidence/saved-views/:id`. */
export function buildSavedViewPath(id: string): string {
  return `/v1/evidence/saved-views/${encodeURIComponent(id)}`;
}

/** `POST` here makes the view the reader's default for the workspace. */
export function buildSavedViewDefaultPath(id: string): string {
  return `${buildSavedViewPath(id)}/default`;
}

export const SAVED_VIEW_NAME_MAX = 120;

/**
 * A rename is the only field a phone edits.
 *
 * `UpdateSavedViewBody` also accepts scope, filters and sortKey, and the web
 * deliberately does not send them from its list either: re-saving the current
 * filters INTO an existing view is a different operation from renaming one,
 * and offering both behind a single "Edit" is how an operator loses a view
 * they meant to keep. Native matches the web rather than inventing a third
 * behaviour for the same route.
 */
export function validateSavedViewName(name: string): string | null {
  const n = name.trim();
  if (n.length === 0) return "Name the view first.";
  if (n.length > SAVED_VIEW_NAME_MAX) {
    return `A saved view name cannot be longer than ${SAVED_VIEW_NAME_MAX} characters.`;
  }
  return null;
}

export function buildSavedViewRenameBody(name: string): { name: string } {
  return { name: name.trim() };
}

/**
 * Applying `POST :id/default` locally.
 *
 * The server clears the previous default in the same workspace, so a client
 * that only flipped the new row would show two defaults until the next read.
 * The web does this same fold-in (evidence/page.tsx:1036); stating it once
 * here keeps the two clients from drifting.
 */
export function withDefaultSavedView(views: SavedViewItem[], id: string): SavedViewItem[] {
  return views.map((v) => ({ ...v, isDefault: v.id === id }));
}

/**
 * The view to apply on first load, or null.
 *
 * Only when the operator has not already filtered: a default view that
 * overrode a filter the user just set would be the surface arguing with them.
 * The web gates it the same way (evidence/page.tsx:600).
 */
export function defaultSavedViewToApply(
  views: SavedViewItem[],
  filtersAreUntouched: boolean,
): SavedViewItem | null {
  if (!filtersAreUntouched) return null;
  return views.find((v) => v.isDefault) ?? null;
}

/**
 * The bulk actions applicable to a scope (mirrors EVIDENCE_BULK_ACTIONS +
 * lifecycle), labelled with the web's ACTION_LABELS. The web lists all seven
 * in every scope and lets the lifecycle projection refuse; a phone offers
 * only those the scope can carry.
 */
export function bulkActionsForScope(scope: string): BulkActionSpec[] {
  const spec = (action: EvidenceBulkActionName, destructive = false): BulkActionSpec =>
    destructive ? { action, label: BULK_ACTION_LABELS[action], destructive } : { action, label: BULK_ACTION_LABELS[action] };
  const caseActions = [spec("ADD_TO_CASE"), spec("REMOVE_FROM_CASE")];

  switch (scope) {
    case "active":
    case "locked":
      return [...caseActions, spec("ARCHIVE"), spec("TRASH", true), spec("EXPORT_METADATA_CSV")];
    case "archived":
      return [...caseActions, spec("RESTORE_ARCHIVED"), spec("TRASH", true), spec("EXPORT_METADATA_CSV")];
    case "trash":
      return [spec("RESTORE_TRASH"), spec("EXPORT_METADATA_CSV")];
    default:
      return [spec("EXPORT_METADATA_CSV")];
  }
}
