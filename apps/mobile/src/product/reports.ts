/**
 * REPORTS & ARTIFACTS — pure projections for the native Reports surface.
 *
 * Ports `apps/web/components/reports-experience/ReportsIndex.tsx` over
 * `GET /v1/reports/artifacts` (a read-only aggregator, side-effect-free).
 *
 * Reports is one of the nine canonical primary-navigation destinations
 * (`CANONICAL_PRIMARY_ROUTE_IDS` includes `workspace.reports`). The superseded
 * native contract excluded it by fiat — "Report actions live on Evidence;
 * standalone Reports web-only" — which is a decision, not evidence, and it is
 * not one Native gets to make.
 *
 * Two things the web page is careful about, carried over verbatim because both
 * were defects there first:
 *
 *   1. The display title is a CASCADE (`title` → `displayFileName` →
 *      `originalFileName`). Reading `title` alone is what filled the web page
 *      with "Untitled evidence".
 *   2. `total` is the count across the whole workspace for the current query,
 *      NOT the length of this page.
 *
 * Pure: no React, no react-native, no fetch.
 */
import type { ProovraStatusTone } from "@proovra/ui";
import { outputUnavailableReasonShort } from "@proovra/shared";
import type { NewVersionOfferView } from "./evidence-record";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;

/** The server default. Named so the pager and the screen agree on one number. */
export const REPORTS_PAGE_SIZE = 25;

/* ------------------------------------------------------------------ summary */

export interface ReportsSummary {
  reportsReady: number | null;
  reportsPending: number | null;
  reportsFailed: number | null;
  packagesReady: number | null;
  packagesPending: number | null;
  packagesBlocked: number | null;
  totalEvidenceWithArtifacts: number | null;
}

/**
 * The canonical counters, in the web's order, with its labels
 * (ReportsIndex.tsx SUMMARY_METRICS). Every one counts RECORDS, and every one
 * with a lifecycle filter equals that filter's total on the server.
 */
export const REPORTS_METRICS: ReadonlyArray<{
  key: keyof ReportsSummary;
  label: string;
  tone: ProovraStatusTone;
}> = [
  { key: "reportsReady", label: "Reports ready", tone: "info" },
  // PENDING takes the shared attention tone, not the caution amber.
  { key: "reportsPending", label: "Reports pending", tone: "pending" },
  { key: "reportsFailed", label: "Reports failed", tone: "risk" },
  { key: "packagesReady", label: "Packages ready", tone: "verified" },
  { key: "packagesPending", label: "Packages pending", tone: "pending" },
  { key: "packagesBlocked", label: "Packages blocked", tone: "risk" },
  { key: "totalEvidenceWithArtifacts", label: "Records with artifacts", tone: "neutral" },
];

export function parseReportsSummary(payload: unknown): ReportsSummary | null {
  const section = obj(obj(obj(payload).sections).summary);
  if (str(section.status) === "unavailable") return null;
  const d = obj(section.data);
  if (Object.keys(d).length === 0) return null;
  return {
    reportsReady: int(d.reportsReady),
    reportsPending: int(d.reportsPending),
    reportsFailed: int(d.reportsFailed),
    packagesReady: int(d.packagesReady),
    packagesPending: int(d.packagesPending),
    packagesBlocked: int(d.packagesBlocked),
    totalEvidenceWithArtifacts: int(d.totalEvidenceWithArtifacts),
  };
}

/* ----------------------------------------------------------------- artifacts */

export interface ArtifactRow {
  evidenceId: string;
  /** Already resolved through the canonical cascade — render this. */
  displayTitle: string;
  type: string;
  status: string;
  verificationStatus: string | null;
  caseId: string | null;
  caseTitle: string | null;
  reportState: string | null;
  packageState: string | null;
  /** Org-supplied business metadata (web "Customer:"); asserts nothing about integrity. */
  intakeCustomerId: string | null;
  /**
   * The SERVER's verbs, per output (outputs.*.action); the list derives none.
   * A missing package is the package's RECOVER, never a verb on both.
   */
  outputActions: Array<{ output: "report" | "verificationPackage"; action: ReportOutputAction }>;
  /** Why no verb is offered, when a person should know (the first output's reason). */
  actionWithheldReason: string | null;
  /** The separate new-version decision ({action, reason}); null when absent. */
  newVersion: NewVersionOfferView | null;
  /** Re-read the list at this interval while this row has live work; null = none. */
  pollIntervalMs: number | null;
  /** `report.version` / `package.version` — the web's "· vN". */
  reportVersion?: number | null;
  packageVersion?: number | null;
  /** `package.blockedReason` — the governance reason a package export is blocked. */
  packageBlockedReason?: string | null;
  /** The record's capture time (`createdAt`) — the web's "Captured 3d ago". */
  createdAt?: string | null;
}

/** The per-output verbs a row may render (REGENERATE is retired). */
export type ReportOutputAction = "GENERATE" | "RETRY" | "RECOVER";

/**
 * The row's per-output verbs and the reason none is offered — one reader for
 * both the workspace aggregator and the user-scoped fallback.
 */
export function readRowOutputs(outputsRaw: unknown): Pick<
  ArtifactRow,
  "outputActions" | "actionWithheldReason" | "newVersion" | "pollIntervalMs"
> {
  const out = obj(outputsRaw);
  const outputActions: ArtifactRow["outputActions"] = [];
  for (const output of ["report", "verificationPackage"] as const) {
    const action = asAction(obj(out[output]).action);
    if (action) outputActions.push({ output, action });
  }
  const reasons = [str(obj(out.report).actionUnavailableReason), str(obj(out.verificationPackage).actionUnavailableReason)];
  const pollRaw = out.pollIntervalMs;
  return {
    outputActions,
    actionWithheldReason: reasons.find((r) => outputUnavailableReasonShort(r as never) !== null) ?? null,
    // A row carries the decision only; the versions and the estimate are read
    // from the record's own status when the confirmation opens.
    newVersion: str(obj(out.newVersion).action)
      ? {
          action: str(obj(out.newVersion).action) as string,
          reason: str(obj(out.newVersion).reason),
          currentVersion: null,
          nextVersion: null,
          estimate: null,
        }
      : null,
    pollIntervalMs: typeof pollRaw === "number" && Number.isFinite(pollRaw) ? pollRaw : null,
  };
}

/** The web ReportsIndex integrityLabel: the enum said once, without a repeated "Integrity". */
export function reportIntegrityLabel(status: string): string {
  const raw = status.trim().toUpperCase();
  const stripped = raw.replace(/^RECORDED_INTEGRITY_/, "").replace(/^INTEGRITY_/, "");
  return (stripped || raw).toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function asAction(v: unknown): ReportOutputAction | null {
  return v === "GENERATE" || v === "RETRY" || v === "RECOVER" ? v : null;
}

/**
 * The display-title cascade, matching the web's `getDisplayTitle`.
 *
 * Many records carry their name in `displayFileName` / `originalFileName` with
 * `title` null; reading `title` alone is exactly what filled the web page with
 * "Untitled evidence".
 */
export function resolveDisplayTitle(row: {
  title?: string | null;
  displayFileName?: string | null;
  originalFileName?: string | null;
}): string {
  return (
    str(row.title)?.trim() ||
    str(row.displayFileName)?.trim() ||
    str(row.originalFileName)?.trim() ||
    "Untitled evidence"
  );
}

export interface ArtifactPage {
  items: ArtifactRow[];
  nextCursor: string | null;
  /** Rows matching the CURRENT query across the workspace — not this page. */
  total: number | null;
  /** True when the list section itself failed, as distinct from being empty. */
  unavailable: boolean;
}

export function parseArtifacts(payload: unknown): ArtifactPage {
  const section = obj(obj(obj(payload).sections).artifacts);
  const unavailable = str(section.status) === "unavailable";
  return {
    unavailable,
    nextCursor: str(section.nextCursor),
    total: int(section.total),
    items: rows(section.items).map((raw) => {
      const r = obj(raw);
      return {
        evidenceId: str(r.evidenceId) ?? "",
        displayTitle: resolveDisplayTitle({
          title: str(r.title),
          displayFileName: str(r.displayFileName),
          originalFileName: str(r.originalFileName),
        }),
        type: str(r.type) ?? "DOCUMENT",
        status: str(r.status) ?? "",
        verificationStatus: str(r.verificationStatus),
        caseId: str(r.caseId),
        caseTitle: str(r.caseTitle),
        // The aggregator sends `report.state` / `package.state`
        // (reports-aggregator.service.ts :768-778). The top-level `reportState`
        // / `packageState` and `verificationPackage.state` this also read are
        // keys the server never sends.
        reportState: str(obj(r.report).state),
        packageState: str(obj(r.package).state),
        reportVersion: int(obj(r.report).version),
        packageVersion: int(obj(r.package).version),
        packageBlockedReason: str(obj(r.package).blockedReason),
        createdAt: str(r.createdAt),
        intakeCustomerId: str(r.intakeCustomerId),
        ...readRowOutputs(r.outputs),
      };
    }),
  };
}

/* ------------------------------------------------------------------ filters */

export type LifecycleFilter =
  | "all"
  | "report_ready"
  | "report_pending"
  | "report_failed"
  | "package_ready"
  | "package_pending"
  | "package_blocked";

export const REPORTS_SEARCH_MAX = 80;

/** The canonical lifecycle filters, in the web's order. */
export const REPORTS_FILTERS: ReadonlyArray<{ value: LifecycleFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "report_ready", label: "Report ready" },
  { value: "report_pending", label: "Report pending" },
  { value: "report_failed", label: "Report failed" },
  { value: "package_ready", label: "Package ready" },
  { value: "package_pending", label: "Package pending" },
  { value: "package_blocked", label: "Package blocked" },
];

export function buildReportsPath(input: {
  teamId: string | null;
  filter?: LifecycleFilter;
  cursor?: string | null;
  limit?: number;
  /** T-12 — "Search by evidence title" (ReportsIndex.tsx:671-700); 1–80 chars (ArtifactsQuery). */
  search?: string | null;
  /**
   * `false` sends `summary=0` (ArtifactsQuery): the six workspace counters no
   * filter, search or page can change, so the LIST does not ask for them —
   * they are read once by `buildReportsSummaryPath` (ReportsIndex.tsx:325).
   */
  summary?: boolean;
}): string | null {
  if (!input.teamId) return null;
  const params = new URLSearchParams();
  params.set("teamId", input.teamId);
  params.set("limit", String(input.limit ?? REPORTS_PAGE_SIZE));
  if (input.summary === false) params.set("summary", "0");
  if (input.filter && input.filter !== "all") params.set("lifecycle", input.filter);
  const q = (input.search ?? "").trim().slice(0, REPORTS_SEARCH_MAX);
  if (q) params.set("search", q);
  if (input.cursor) params.set("cursor", input.cursor);
  return `/v1/reports/artifacts?${params.toString()}`;
}

/* -------------------------------------------------------------------- tones */

/**
 * The row's state as one label and tone.
 *
 * Deliberately conservative about "ready": a package that is blocked is the
 * fact worth surfacing, and a row with no artifact state at all says so rather
 * than implying something is in progress.
 */
export function artifactRowState(row: ArtifactRow): { label: string; tone: ProovraStatusTone } {
  const pkg = (row.packageState ?? "").toUpperCase();
  const rep = (row.reportState ?? "").toUpperCase();
  if (pkg === "BLOCKED") return { label: "Package blocked", tone: "risk" };
  if (rep === "FAILED") return { label: "Report failed", tone: "risk" };
  if (pkg === "READY") return { label: "Package ready", tone: "verified" };
  if (rep === "READY" || rep === "GENERATED") return { label: "Report ready", tone: "verified" };
  if (pkg === "PENDING" || rep === "PENDING") return { label: "In progress", tone: "pending" };
  return { label: "No artifact yet", tone: "neutral" };
}

// ---------------------------------------------------------------------------
// Retrieving a report from the list
// ---------------------------------------------------------------------------

/**
 * MINTING A REPORT URL IS NOT A READ.
 *
 * `GET /v1/evidence/:id/report/latest` records a custody/audit download — the
 * Evidence Detail screen already notes this, and takes the side-effect-free
 * status first for exactly that reason.
 *
 * So a Reports LIST must never pre-fetch a URL per row: a user who scrolled
 * past forty records would have written forty download events into the custody
 * chain of records they never opened. The chain would then say those reports
 * were retrieved, which is a false statement in the one place the product
 * exists to keep true.
 *
 * The list therefore mints on TAP, one record at a time, and only for a row
 * the server has already reported READY.
 */
export function buildReportLatestPath(evidenceId: string): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/report/latest`;
}

export function parseReportUrl(payload: unknown): string | null {
  const d = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const url = d.url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

/**
 * Whether this row's report can be retrieved at all.
 *
 * Only a READY report. Offering a download for a row that is still generating
 * produces a request that mints nothing and an audit event that says a
 * retrieval was attempted on a report that did not exist.
 */
export function isReportRetrievable(row: ArtifactRow): boolean {
  return (row.reportState ?? "").toUpperCase() === "READY";
}

// ---------------------------------------------------------------------------
// Web-parity additions (ReportsIndex.tsx)
// ---------------------------------------------------------------------------

/** The summary, read on its own and once per workspace (ReportsIndex.tsx:325-339). */
export function buildReportsSummaryPath(teamId: string): string {
  return `/v1/reports/artifacts?teamId=${encodeURIComponent(teamId)}&limit=1`;
}

export const REPORTS_TITLE = "Reports & Artifacts";
export const REPORTS_EYEBROW = "Deliverables";
export const REPORTS_DESCRIPTION =
  'Generated report snapshots and verification packages. These are workspace deliverables — they record integrity at the time of generation and do NOT assert legal admissibility, authenticity, or "court-ready" status.';
export const REPORTS_SUMMARY_UNAVAILABLE = "Summary is temporarily unavailable. The artifact list below remains usable.";
export const REPORTS_LIST_UNAVAILABLE = "Artifact list is temporarily unavailable. Retry shortly.";
export const REPORTS_FOOTNOTE =
  "Browsing this page never triggers report or package generation and never marks any artifact as viewed. Signed download URLs are only minted on explicit per-row action (the Download buttons above), the same gated path used by the evidence-detail page.";
export const CUSTOMER_ID_HINT = "Customer ID supplied by your organization";
/** generation-labels.ts DOWNLOAD_REPORT_LABEL / DOWNLOAD_PACKAGE_LABEL. */
export const DOWNLOAD_REPORT_LABEL = "Download Report PDF";
export const DOWNLOAD_PACKAGE_LABEL = "Download Verification Package ZIP";

const lc = (s: string | null | undefined) => String(s ?? "").toLowerCase();

/** "Report ready · v2" (web reportLabel + version). */
export function reportStatusText(row: ArtifactRow): string {
  const s = lc(row.reportState);
  const word = s === "not_requested" || s === "" ? "not requested" : s;
  return `Report ${word}${row.reportVersion ? ` · v${row.reportVersion}` : ""}`;
}

/** "Package blocked by governance" (web packageLabel + version). */
export function packageStatusText(row: ArtifactRow): string {
  const s = lc(row.packageState);
  const word = s === "blocked" ? "blocked by governance" : s === "not_requested" || s === "" ? "not requested" : s;
  return `Package ${word}${row.packageVersion ? ` · v${row.packageVersion}` : ""}`;
}

/** The lifecycle → tone the web gives the status text (green / amber / red / slate). */
export function lifecycleTone(state: string | null | undefined): ProovraStatusTone {
  switch (lc(state)) {
    case "ready":
      return "verified";
    case "pending":
      return "pending";
    case "failed":
      return "risk";
    case "blocked":
      return "governance";
    default:
      return "neutral";
  }
}

/** Verified is the only positive integrity outcome (web integrityToneAttr). */
export function integrityTone(status: string): ProovraStatusTone {
  const raw = status.trim().toUpperCase();
  if (raw.endsWith("VERIFIED")) return "verified";
  if (raw.includes("FAIL") || raw.includes("MISMATCH")) return "risk";
  return "neutral";
}

/** What the row says where a download is not offered (ReportsIndex.tsx:1162-1215). */
export function reportActionStatus(row: ArtifactRow): string | null {
  switch (lc(row.reportState)) {
    case "ready":
      return null;
    case "pending":
      return "Report generating — refresh shortly";
    case "failed":
      return "Report generation failed";
    case "not_requested":
      return "Report not generated yet";
    default:
      return "Report not included for this record";
  }
}

export function packageActionStatus(row: ArtifactRow): string | null {
  switch (lc(row.packageState)) {
    case "ready":
      return null;
    case "blocked":
      return `Package blocked — ${row.packageBlockedReason ?? "governance policy"}`;
    case "pending":
      return "Package generating — refresh shortly";
    case "failed":
      return "Package generation failed";
    case "not_requested":
      return "Package not generated yet";
    default:
      return "Package not included for this record";
  }
}

export function isPackageRetrievable(row: ArtifactRow): boolean {
  return lc(row.packageState) === "ready";
}

/** The web's per-row download failures, by status (ReportsIndex.tsx:950-1010). */
export function reportDownloadError(status: number | null, safeMessage: string | null): string {
  if (status === 202) return "Report is still generating. Try again in a moment.";
  if (status === 403) return "You don't have permission to download this report.";
  if (status === 409) return safeMessage ?? "Report download blocked by workspace policy.";
  return safeMessage ?? "Could not start download.";
}

export function packageDownloadError(status: number | null, safeMessage: string | null): string {
  if (status === 202) return "Package is still generating. Try again in a moment.";
  if (status === 403) return "You don't have permission to download this package.";
  if (status === 409) return safeMessage ?? "Package blocked by workspace policy.";
  return safeMessage ?? "Could not start download.";
}

/** The package endpoint's 200 answer without a URL (ReportsIndex.tsx:990-996). */
export function packageNoUrlMessage(payload: unknown): string {
  return obj(payload).code === "verification_package_pending" ? "Package is still generating." : "Package URL is unavailable.";
}

/** THE EMPTY STATE, aware of what was asked (ReportsEmptyState). */
export function reportsEmptyCopy(
  filter: LifecycleFilter,
  search: string,
): { title: string; body: string; offerEvidence: boolean } {
  const searched = search.trim().length > 0;
  const filtered = filter !== "all" || searched;
  return {
    title: !filtered ? "No reports yet" : searched ? "No reports match your search." : "No reports match this filter.",
    body: !filtered
      ? "Reports are generated from signed evidence. Capture or upload evidence to create your first report."
      : "Adjust the filter or the search to widen the query.",
    offerEvidence: !filtered,
  };
}

/** The web's relative time (formatRelativeTime): "just now", "5m ago", "3h ago", "2d ago", else the date. */
export function formatRelativeTime(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const minutes = Math.floor((nowMs - t) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** `generatedAt` of the aggregator envelope — the web's "Refreshed …" strip. */
export function parseGeneratedAt(payload: unknown): string | null {
  return str(obj(payload).generatedAt);
}

// ---------------------------------------------------------------- fallback

/**
 * The user-scoped fallback, `GET /v1/reports` (reports.routes.ts
 * UserReportsEnvelope: `{ items, nextCursor }`).
 *
 * The web reads it when the workspace aggregator 404s (not a TeamMember of the
 * active workspace — a personal-bootstrap gap) or returns an EMPTY unfiltered
 * list (ReportsIndex.tsx:381-420). Its rows carry the canonical
 * `reportLifecycle` / `packageLifecycle`, mapped here onto the aggregator's row
 * vocabulary exactly as the web's toReportLifecycle / toPackageLifecycle do.
 */
export const USER_REPORTS_PATH = "/v1/reports";

function toLifecycle(state: unknown): string {
  switch (state) {
    case "READY":
      return "ready";
    case "QUEUED":
    case "GENERATING":
      return "pending";
    case "RETRYABLE_FAILURE":
    case "TERMINAL_FAILURE":
      return "failed";
    case "NOT_INCLUDED":
      return "unavailable";
    default:
      return "not_requested";
  }
}

export function parseUserScopedReports(payload: unknown): ArtifactPage {
  const d = obj(payload);
  return {
    unavailable: false,
    nextCursor: str(d.nextCursor),
    // The fallback route has no total; the count falls back to the page length.
    total: null,
    items: rows(d.items).map((raw) => {
      const r = obj(raw);
      return {
        evidenceId: str(r.evidenceId) ?? "",
        displayTitle: resolveDisplayTitle({
          title: str(r.title),
          displayFileName: str(r.displayFileName),
          originalFileName: str(r.originalFileName),
        }),
        type: str(r.type) ?? "DOCUMENT",
        status: str(r.status) ?? "",
        verificationStatus: null,
        caseId: str(r.caseId),
        caseTitle: str(r.caseTitle),
        reportState: toLifecycle(r.reportLifecycle),
        packageState: toLifecycle(r.packageLifecycle),
        reportVersion: int(obj(r.report).version),
        packageVersion: int(obj(r.package).version),
        packageBlockedReason: null,
        createdAt: str(r.createdAt),
        intakeCustomerId: str(r.intakeCustomerId),
        ...readRowOutputs(r.outputs),
      };
    }),
  };
}
