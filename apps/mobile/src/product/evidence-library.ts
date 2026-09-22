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
    lifecycleState: inspectorString(evidence["lifecycleState"]),
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

/* ------------------------------------------------------------- Saved views */

export interface SavedViewItem {
  id: string;
  name: string;
  scope: string; // native scope ("active"|"archived"|"trash"|"locked")
  type: string; // "ALL" or an EvidenceType
  status: string; // "ALL" or an EvidenceStatus
  search: string;
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
  return typeof v === "string" && v && v !== "all" ? v : "ALL";
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
      scope: scopeFromServer(typeof v["scope"] === "string" ? (v["scope"] as string) : "active"),
      type: allOr(filters["type"]),
      status: allOr(filters["status"]),
      search: typeof filters["search"] === "string" ? (filters["search"] as string) : "",
      sort: toSort(v["sortKey"] ?? filters["sort"]),
      isDefault: v["isDefault"] === true,
    });
  }
  return out;
}

/**
 * Build the POST /v1/evidence/saved-views body from the current state. Only the
 * cleanly-mapping dimensions are persisted (scope/type/status/search/sort) — the
 * saved-view filter schema has no source/report field, so nothing is silently
 * dropped or fabricated.
 */
export function buildSavedViewBody(input: { name: string; scope: string; type: string; status: string; search: string; sort: LibrarySort }) {
  return {
    name: input.name.trim(),
    scope: scopeToServer(input.scope),
    sortKey: input.sort,
    filters: {
      scope: scopeToServer(input.scope),
      search: input.search.trim(),
      type: input.type === "ALL" ? "all" : input.type,
      status: input.status === "ALL" ? "all" : input.status,
      sort: input.sort,
    },
  };
}

/** The bulk actions applicable to a scope (mirrors EVIDENCE_BULK_ACTIONS + lifecycle). */
export function bulkActionsForScope(scope: string): BulkActionSpec[] {
  const caseActions: BulkActionSpec[] = [
    { action: "ADD_TO_CASE", label: "Add to Case" },
    { action: "REMOVE_FROM_CASE", label: "Remove from Case" },
  ];

  switch (scope) {
    case "active":
    case "locked":
      return [
        ...caseActions,
        { action: "ARCHIVE", label: "Archive" },
        { action: "TRASH", label: "Move to Trash", destructive: true },
        { action: "EXPORT_METADATA_CSV", label: "Export CSV" },
      ];

    case "archived":
      return [
        ...caseActions,
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
