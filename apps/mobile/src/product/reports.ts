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
  packagesReady: number | null;
  packagesPending: number | null;
  packagesBlocked: number | null;
  totalEvidenceWithArtifacts: number | null;
}

/** The six canonical counters, in the web's order, with its labels. */
export const REPORTS_METRICS: ReadonlyArray<{
  key: keyof ReportsSummary;
  label: string;
  tone: ProovraStatusTone;
}> = [
  { key: "reportsReady", label: "Reports generated", tone: "info" },
  // PENDING takes the shared attention tone, not the caution amber.
  { key: "reportsPending", label: "Reports pending", tone: "pending" },
  { key: "packagesReady", label: "Packages ready", tone: "verified" },
  { key: "packagesPending", label: "Packages pending", tone: "pending" },
  { key: "packagesBlocked", label: "Packages blocked", tone: "risk" },
  { key: "totalEvidenceWithArtifacts", label: "Evidence with artifacts", tone: "neutral" },
];

export function parseReportsSummary(payload: unknown): ReportsSummary | null {
  const section = obj(obj(obj(payload).sections).summary);
  if (str(section.status) === "unavailable") return null;
  const d = obj(section.data);
  if (Object.keys(d).length === 0) return null;
  return {
    reportsReady: int(d.reportsReady),
    reportsPending: int(d.reportsPending),
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
        reportState: str(r.reportState) ?? str(obj(r.report).state),
        packageState: str(r.packageState) ?? str(obj(r.verificationPackage).state),
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
}): string | null {
  if (!input.teamId) return null;
  const params = new URLSearchParams();
  params.set("teamId", input.teamId);
  params.set("limit", String(input.limit ?? REPORTS_PAGE_SIZE));
  if (input.filter && input.filter !== "all") params.set("lifecycle", input.filter);
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
