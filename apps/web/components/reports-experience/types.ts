/**
 * Phase 32.8D — Reports & Artifacts experience frontend types.
 *
 * Mirrors the envelope returned by `/v1/reports/artifacts`.
 */

// RELIABILITY CLOSURE (2026-09-09) — the canonical output vocabulary, so this
// page renders the server's action instead of deriving one from the lossy
// five-value lifecycle below.
import type {
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
  | "failed"
  | "unavailable";

export type PackageLifecycle =
  | "not_requested"
  | "pending"
  | "ready"
  | "blocked"
  | "failed"
  | "unavailable";

export type ArtifactRow = {
  evidenceId: string;
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

/** Filters only an API with the truthful buckets accepts. */
export const TRUTHFUL_BUCKET_FILTERS: ReadonlySet<LifecycleFilter> = new Set<LifecycleFilter>([
  "package_missing",
  "report_awaiting_issuance",
  "report_not_issued",
  "entitlement_unavailable",
]);
