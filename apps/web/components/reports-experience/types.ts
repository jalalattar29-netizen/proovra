/**
 * Phase 32.8D — Reports & Artifacts experience frontend types.
 *
 * Mirrors the envelope returned by `/v1/reports/artifacts`.
 */

// RELIABILITY CLOSURE (2026-09-09) — the canonical output vocabulary, so this
// page renders the server's action instead of deriving one from the lossy
// five-value lifecycle below.
import type {
  DeliverableStatus,
  DeliverableStatusReason,
  EvidenceOutputState,
  NewVersionAction,
  OutputAction,
  OutputActionUnavailableReason,
  OutputOperation,
  OutputTerminalReasonClass,
} from "@proovra/shared";

/** `skipped` = the caller did not ask for it. NOT a failure. */
export type SectionStatus = "ok" | "degraded" | "unavailable" | "skipped";

export type ReportLifecycle =
  | "not_requested"
  | "pending"
  | "ready"
  /** ET-RPT-02 — the latest request is blocked (stale policy / policy block). */
  | "blocked"
  | "failed"
  | "unavailable";

export type PackageLifecycle =
  | "not_requested"
  | "pending"
  | "ready"
  | "blocked"
  | "failed"
  | "unavailable";

/**
 * 2026-10-16 — the record's ONE deliverable status, as the server projects it
 * (`deliverableStatusFor`). Optional on the wire: the user-scoped fallback and
 * an older API send none, and the row then states no status rather than one
 * this page invented.
 */
export type RowDeliverable = {
  status: DeliverableStatus;
  reason: DeliverableStatusReason;
};

export type ArtifactRow = {
  evidenceId: string;
  deliverable?: RowDeliverable;
  /** Actual record workspace, not merely the workspace selected in the shell. */
  teamId: string | null;
  /**
   * The stored title, VERBATIM — `null` when the record has none.
   *
   * Do NOT render this directly. Pass the row through `getDisplayTitle`, the
   * same cascade the Evidence Library and Case Detail use: many records carry
   * their name in `displayFileName` / `originalFileName` with `title` null,
   * and reading `title` alone is exactly what filled this page with
   * "Untitled evidence".
   */
  title: string | null;
  /** Cascade inputs. Never a display value on their own. */
  displayFileName: string | null;
  originalFileName: string | null;
  mimeType: string | null;
  type: string;
  status: string;
  verificationStatus: string | null;
  caseId: string | null;
  /** The linked case's NAME. Null only when the case genuinely has none. */
  caseTitle: string | null;
  /** Organization-supplied Customer ID from the intake link. Null unless intake. */
  intakeCustomerId: string | null;
  createdAt: string;
  report: {
    state: ReportLifecycle;
    /** ET-RPT-01 — a report exists and its latest report request failed (absent from older APIs). */
    updateFailed?: boolean;
    version: number | null;
    generatedAtUtc: string | null;
  };
  package: {
    state: PackageLifecycle;
    version: number | null;
    generatedAtUtc: string | null;
    blockedReason: string | null;
  };
  /**
   * RELIABILITY CLOSURE (2026-09-09) — THE CANONICAL PROJECTION.
   *
   * The two blocks above are the legacy five-value vocabulary, kept because the
   * status text reads well from it. What it cannot carry is an ACTION, and this
   * page used to derive one from it — a mapping that is lossy in exactly the
   * places that decide whether a button should exist. `BLOCKED` collapses into
   * `not_requested`, so the page offered Generate for a record whose canonical
   * action is NONE; every `TERMINAL_FAILURE` collapses into `failed`, so it
   * offered Retry for terminals nothing will reopen.
   *
   * `action` is the SERVER's — the same `outputActionFor` answer Evidence
   * Detail renders — so the two surfaces cannot disagree about one record.
   *
   * OPTIONAL on the wire: the user-scoped fallback envelope this page can also
   * receive is a different endpoint, and a row without it renders no action
   * rather than an invented one.
   */
  outputs?: {
    report: ArtifactOutputProjection;
    verificationPackage: ArtifactOutputProjection & {
      /** The newest package of any version (may predate the latest report). */
      latestAvailableVersion?: number | null;
    };
    /** The separate, optional "create a new version" decision. */
    newVersion?: { action: NewVersionAction; reason: OutputActionUnavailableReason | null };
    /** Re-read the list at this interval while this row has live work; null = none. */
    pollIntervalMs?: number | null;
  };
};

/** One output's canonical state, action and availability, as projected. */
export type ArtifactOutputProjection = {
  state: EvidenceOutputState;
  action: OutputAction;
  /** Why no verb is offered (bounded). */
  actionUnavailableReason?: OutputActionUnavailableReason | null;
  /** The server operation the offered verb performs. */
  operation?: OutputOperation | null;
  terminalReasonClass: OutputTerminalReasonClass | null;
  /** Bounded worker code when TERMINAL_FAILURE (absent from older APIs). */
  terminalReasonCode?: string | null;
  /** An artifact exists and may be opened, whatever the current request says. */
  downloadable: boolean;
};

/**
 * The operational counters the summary strip renders. Every one counts
 * RECORDS (never artifact versions), and every one with a lifecycle filter
 * equals that filter's total over the same workspace.
 */
export type ReportsSummary = {
  reportsReady: number;
  reportsPending: number;
  /** Absent from servers older than the tile ⇔ filter parity change. */
  reportsFailed?: number;
  /** ET-RPT-01 — a report exists; its latest report request failed. Absent from older APIs. */
  reportsUpdateFailed?: number;
  /** ET-RPT-02 — no report; the latest request is blocked. Absent from older APIs. */
  reportsBlocked?: number;
  packagesReady: number;
  packagesPending: number;
  packagesBlocked: number;
  packagesFailed?: number;
  /** Deprecated server fields, kept by the API for older clients. */
  reportsNotRequested?: number;
  packagesNotRequested?: number;
  reportsNotIssued?: number;
  reportsAwaitingFirstIssuance?: number;
  packagesMissingForLatestReport?: number;
  outputsEntitlementUnavailable?: number;
  totalEvidenceWithArtifacts: number;
  totalArtifactVersions?: number;
  /*
   * 2026-10-16 — the record status counts (mutually exclusive, summing to
   * `recordsTotal`). Absent from APIs older than the compact summary.
   */
  recordsReady?: number;
  recordsInProgress?: number;
  recordsNeedingAttention?: number;
  recordsIncomplete?: number;
  recordsNotAvailable?: number;
  recordsTotal?: number;
};

export type ReportsArtifactsEnvelope = {
  generatedAt: string;
  workspace: { id: string; role: string };
  sections: {
    summary: {
      status: SectionStatus;
      data: ReportsSummary | null;
    };
    artifacts: {
      status: SectionStatus;
      items: ArtifactRow[];
      nextCursor: string | null;
      /**
       * Rows matching the CURRENT query across the whole workspace — not the
       * length of this page. Null only when the list itself failed.
       */
      total: number | null;
    };
  };
};

export type LifecycleFilter =
  | "all"
  | "report_ready"
  | "report_pending"
  | "report_failed"
  | "report_update_failed"
  | "report_blocked"
  | "package_ready"
  | "package_pending"
  | "package_failed"
  | "package_blocked"
  // 2026-09-29 — the buckets "not requested" used to hide.
  | "report_not_issued"
  | "report_awaiting_issuance"
  | "package_missing"
  | "entitlement_unavailable";

/** Every filter, for validating a `?lifecycle=` deep link. */
export const LIFECYCLE_FILTERS: ReadonlyArray<LifecycleFilter> = [
  "all",
  "report_ready",
  "report_pending",
  "report_failed",
  "report_update_failed",
  "report_blocked",
  "package_ready",
  "package_pending",
  "package_failed",
  "package_blocked",
  "report_not_issued",
  "report_awaiting_issuance",
  "package_missing",
  "entitlement_unavailable",
];

/**
 * A deep link's filter (e.g. Billing → `/reports?lifecycle=report_awaiting_issuance`),
 * or null when absent or not a known filter — an unknown value never reaches
 * the server.
 */
export function lifecycleFilterFromSearch(search: string): LifecycleFilter | null {
  const value = new URLSearchParams(search).get("lifecycle");
  return value && (LIFECYCLE_FILTERS as readonly string[]).includes(value)
    ? (value as LifecycleFilter)
    : null;
}

/**
 * ROLLOUT COMPATIBILITY (2026-09-29). The web app deploys on every push to
 * main; the API deploys separately, after its migration. An API without the
 * truthful buckets answers the previous summary and REJECTS the new lifecycle
 * filters with a 400. The page shows the new cards and offers these filters
 * only once the summary proves the API supports them.
 */
export function supportsTruthfulOutputBuckets(summary: ReportsSummary | null | undefined): boolean {
  return typeof summary?.reportsNotIssued === "number";
}

/**
 * ET-RPT-01/02 — the same rollout rule for the blocked and updated-report
 * buckets: offered only once the summary proves the API has them.
 */
export function supportsReportBlockedBuckets(summary: ReportsSummary | null | undefined): boolean {
  return typeof summary?.reportsBlocked === "number" && typeof summary?.reportsUpdateFailed === "number";
}

/** Filters only an API with the blocked / updated-report buckets accepts. */
export const REPORT_BLOCKED_BUCKET_FILTERS: ReadonlySet<LifecycleFilter> = new Set<LifecycleFilter>([
  "report_update_failed",
  "report_blocked",
]);

/** Filters only an API with the truthful buckets accepts. */
export const TRUTHFUL_BUCKET_FILTERS: ReadonlySet<LifecycleFilter> = new Set<LifecycleFilter>([
  "package_missing",
  "report_awaiting_issuance",
  "report_not_issued",
  "entitlement_unavailable",
]);

// ===========================================================================
// THE FILTER MODEL (2026-10-16).
// ===========================================================================
//
// Fourteen always-visible chips became four dimensions, each one canonical
// server value or "any": the RECORD STATUS (the primary selector), and the
// report, package and entitlement lifecycle (advanced). Every dimension maps
// to a parameter the aggregator applies before pagination, so the list total,
// the pager and a summary count describe the same population.
//
// The URL carries the same four plus search and sort, so a filtered view is a
// link. A value this page does not know is dropped, never forwarded.

export type StatusFilter =
  | "all"
  | "ready"
  | "in_progress"
  | "needs_attention"
  | "incomplete"
  | "not_available";
export const STATUS_FILTERS: ReadonlyArray<StatusFilter> = [
  "all",
  "ready",
  "in_progress",
  "needs_attention",
  "incomplete",
  "not_available",
];
/** The four the primary selector shows; the other two live in Advanced. */
export const PRIMARY_STATUS_FILTERS: ReadonlyArray<StatusFilter> = [
  "all",
  "ready",
  "in_progress",
  "needs_attention",
];

export type ReportDimension =
  | "report_ready"
  | "report_pending"
  | "report_failed"
  | "report_update_failed"
  | "report_blocked"
  | "report_awaiting_issuance";
export const REPORT_DIMENSION: ReadonlyArray<ReportDimension> = [
  "report_ready",
  "report_pending",
  "report_failed",
  "report_update_failed",
  "report_blocked",
  "report_awaiting_issuance",
];
export type PackageDimension =
  | "package_ready"
  | "package_pending"
  | "package_failed"
  | "package_blocked"
  | "package_missing";
export const PACKAGE_DIMENSION: ReadonlyArray<PackageDimension> = [
  "package_ready",
  "package_pending",
  "package_failed",
  "package_blocked",
  "package_missing",
];
export type EntitlementDimension = "report_not_issued" | "entitlement_unavailable";
export const ENTITLEMENT_DIMENSION: ReadonlyArray<EntitlementDimension> = [
  "report_not_issued",
  "entitlement_unavailable",
];

export type ReportsSort = "newest" | "oldest";

export type ReportsFilters = {
  status: StatusFilter;
  report: ReportDimension | "any";
  package: PackageDimension | "any";
  entitlement: EntitlementDimension | "any";
  sort: ReportsSort;
  /** Free text, bounded to what the server accepts. */
  q: string;
};

export const DEFAULT_FILTERS: ReportsFilters = Object.freeze({
  status: "all",
  report: "any",
  package: "any",
  entitlement: "any",
  sort: "newest",
  q: "",
}) as ReportsFilters;

const pick = <T extends string>(value: string | null, allowed: ReadonlyArray<T>): T | null =>
  value && (allowed as readonly string[]).includes(value) ? (value as T) : null;

/**
 * The filters a URL names. Unknown or stale values fall back to their
 * default, one dimension at a time — a link with one bad value still opens on
 * the rest. A legacy `?lifecycle=` link (Billing, older bookmarks) lands on
 * the dimension that value belongs to.
 */
export function filtersFromSearch(search: string): ReportsFilters {
  const params = new URLSearchParams(search);
  const out: ReportsFilters = { ...DEFAULT_FILTERS };
  out.status = pick(params.get("status"), STATUS_FILTERS) ?? "all";
  out.report = pick(params.get("report"), REPORT_DIMENSION) ?? "any";
  out.package = pick(params.get("package"), PACKAGE_DIMENSION) ?? "any";
  out.entitlement = pick(params.get("entitlement"), ENTITLEMENT_DIMENSION) ?? "any";
  out.sort = pick(params.get("sort"), ["newest", "oldest"] as const) ?? "newest";
  out.q = (params.get("q") ?? "").slice(0, 80);
  const legacy = lifecycleFilterFromSearch(search);
  if (legacy && legacy !== "all") {
    const asReport = pick(legacy, REPORT_DIMENSION);
    const asPackage = pick(legacy, PACKAGE_DIMENSION);
    const asEntitlement = pick(legacy, ENTITLEMENT_DIMENSION);
    if (asReport && out.report === "any") out.report = asReport;
    if (asPackage && out.package === "any") out.package = asPackage;
    if (asEntitlement && out.entitlement === "any") out.entitlement = asEntitlement;
  }
  return out;
}

/**
 * The URL for a set of filters: defaults are omitted, and the legacy
 * `lifecycle` key is cleared once it has been read into its dimension.
 */
export function filtersToSearch(f: ReportsFilters): Record<string, string | null> {
  return {
    status: f.status === "all" ? null : f.status,
    report: f.report === "any" ? null : f.report,
    package: f.package === "any" ? null : f.package,
    entitlement: f.entitlement === "any" ? null : f.entitlement,
    sort: f.sort === "newest" ? null : f.sort,
    q: f.q.trim() ? f.q.trim() : null,
    lifecycle: null,
  };
}

/** How many ADVANCED dimensions are narrowing the list. */
export function advancedFilterCount(f: ReportsFilters): number {
  return (
    (f.report !== "any" ? 1 : 0) +
    (f.package !== "any" ? 1 : 0) +
    (f.entitlement !== "any" ? 1 : 0) +
    (PRIMARY_STATUS_FILTERS.includes(f.status) ? 0 : 1)
  );
}

/** Is anything narrowing the list (sort does not narrow)? */
export function isFiltered(f: ReportsFilters): boolean {
  return (
    f.status !== "all" ||
    f.report !== "any" ||
    f.package !== "any" ||
    f.entitlement !== "any" ||
    f.q.trim().length > 0
  );
}

/** What the API this page is talking to has proven it accepts. */
export type ReportsApiCapabilities = {
  /** `status=`, several `lifecycle=` values and `sort=` (records* in the summary). */
  recordStatus: boolean;
  truthfulBuckets: boolean;
  blockedBuckets: boolean;
};

/**
 * ROLLOUT COMPATIBILITY (2026-10-16). The web app deploys before the API. The
 * record status, several lifecycle values and the sort are offered to the
 * server only once its summary shows `recordsTotal`; an older API is sent at
 * most ONE lifecycle value it accepts, and never a status it would ignore.
 */
export function supportsRecordStatus(summary: ReportsSummary | null | undefined): boolean {
  return typeof summary?.recordsTotal === "number";
}

/** The list request's query for a set of filters, within what the API accepts. */
export function apiQueryFor(
  f: ReportsFilters,
  caps: ReportsApiCapabilities,
): { status?: StatusFilter; lifecycle: string; sort?: ReportsSort; search?: string } {
  const accepted = (v: LifecycleFilter) =>
    (caps.truthfulBuckets || !TRUTHFUL_BUCKET_FILTERS.has(v)) &&
    (caps.blockedBuckets || !REPORT_BLOCKED_BUCKET_FILTERS.has(v));
  const lifecycles = [f.report, f.package, f.entitlement].filter(
    (v): v is ReportDimension | PackageDimension | EntitlementDimension => v !== "any",
  ).filter(accepted);
  const search = f.q.trim().slice(0, 80);
  if (!caps.recordStatus) {
    return { lifecycle: lifecycles[0] ?? "all", ...(search ? { search } : {}) };
  }
  return {
    ...(f.status !== "all" ? { status: f.status } : {}),
    lifecycle: lifecycles.length ? lifecycles.join(",") : "all",
    ...(f.sort !== "newest" ? { sort: f.sort } : {}),
    ...(search ? { search } : {}),
  };
}
