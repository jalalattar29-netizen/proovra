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

/** Server sort values (EvidenceListSortSchema). */
export const LIBRARY_SORTS = ["newest", "oldest", "priority"] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export function nextSort(current: LibrarySort): LibrarySort {
  const i = LIBRARY_SORTS.indexOf(current);
  return LIBRARY_SORTS[(i + 1) % LIBRARY_SORTS.length];
}
export function sortLabel(sort: LibrarySort): string {
  return sort === "newest" ? "Newest ↓" : sort === "oldest" ? "Oldest ↑" : "Priority ★";
}

/** Server `status` filter values (EvidenceStatus). */
export const STATUS_FILTERS = ["CREATED", "UPLOADING", "UPLOADED", "SIGNED", "REPORTED"] as const;
/** Server `acquisition` filter values (EVIDENCE_ACQUISITION_CATEGORIES). */
export const SOURCE_FILTERS = ["UPLOAD", "SECURE_INTAKE", "MOBILE_APP", "DIRECT_WEB_CAPTURE", "DIRECT_SCREEN_CAPTURE"] as const;
/** Server `reportReady` filter values. */
export const REPORT_FILTERS = ["ready", "missing"] as const;

export interface LibraryQueryInput {
  scope: string;
  search?: string;
  type?: string; // "ALL" or an EvidenceType
  status?: string; // "ALL" or an EvidenceStatus
  source?: string; // "ALL" or an acquisition category
  reportReady?: string; // "ALL" | "ready" | "missing"
  sort: LibrarySort;
  cursor?: string | null;
  limit?: number;
}

/** Build the GET /v1/evidence query string from the current filter state. */
export function buildLibraryQuery(input: LibraryQueryInput): string {
  const p = new URLSearchParams({ scope: input.scope, limit: String(input.limit ?? 50), sort: input.sort });
  if (input.search && input.search.trim()) p.set("search", input.search.trim());
  if (input.type && input.type !== "ALL") p.set("type", input.type);
  if (input.status && input.status !== "ALL") p.set("status", input.status);
  if (input.source && input.source !== "ALL") p.set("acquisition", input.source);
  if (input.reportReady && input.reportReady !== "ALL") p.set("reportReady", input.reportReady);
  if (input.cursor) p.set("cursor", input.cursor);
  return `/v1/evidence?${p.toString()}`;
}

/** True when any refinement beyond scope/sort is active (drives a "clear" affordance). */
export function hasActiveFilters(input: Pick<LibraryQueryInput, "type" | "status" | "source" | "reportReady">): boolean {
  return [input.type, input.status, input.source, input.reportReady].some((v) => v && v !== "ALL");
}

/* ------------------------------------------------------------- Library summary */

export interface LibraryMetric {
  key: string;
  label: string;
  value: number;
  tone: ProovraStatusTone;
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Project GET /v1/evidence/library-summary → the metric strip (real counts). */
export function projectLibraryMetrics(data: unknown): LibraryMetric[] {
  const d = (data && typeof data === "object" ? (data as Record<string, unknown>) : {});
  const needsAction = n(d["needsActionCount"]);
  const issues = n(d["verificationIssuesCount"]);
  return [
    { key: "total", label: "Active", value: n(d["totalActiveRecords"]), tone: "neutral" },
    { key: "reports", label: "Reports ready", value: n(d["reportsReadyCount"]), tone: "verified" },
    { key: "needs", label: "Needs action", value: needsAction, tone: needsAction > 0 ? "risk" : "neutral" },
    { key: "issues", label: "Integrity issues", value: issues, tone: issues > 0 ? "risk" : "neutral" },
  ];
}

/* --------------------------------------------------------------- Bulk actions */

export type BulkAction = "ARCHIVE" | "RESTORE_ARCHIVED" | "TRASH" | "RESTORE_TRASH" | "EXPORT_METADATA_CSV";

export interface BulkActionSpec {
  action: BulkAction;
  label: string;
  destructive?: boolean;
}

/** The bulk actions applicable to a scope (mirrors EVIDENCE_BULK_ACTIONS + lifecycle). */
export function bulkActionsForScope(scope: string): BulkActionSpec[] {
  switch (scope) {
    case "active":
    case "locked":
      return [
        { action: "ARCHIVE", label: "Archive" },
        { action: "TRASH", label: "Move to Trash", destructive: true },
        { action: "EXPORT_METADATA_CSV", label: "Export CSV" },
      ];
    case "archived":
      return [
        { action: "RESTORE_ARCHIVED", label: "Restore" },
        { action: "TRASH", label: "Move to Trash", destructive: true },
        { action: "EXPORT_METADATA_CSV", label: "Export CSV" },
      ];
    case "trash":
      return [
        { action: "RESTORE_TRASH", label: "Restore" },
        { action: "EXPORT_METADATA_CSV", label: "Export CSV" },
      ];
    default:
      return [{ action: "EXPORT_METADATA_CSV", label: "Export CSV" }];
  }
}
