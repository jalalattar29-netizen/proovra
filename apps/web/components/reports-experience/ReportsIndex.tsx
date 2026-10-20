"use client";

/**
 * Phase 32.8D — Enterprise Reports & Artifacts deliverables index.
 *
 * Powered by `/v1/reports/artifacts` (read-only aggregator). The page surfaces
 * report + verification-package state for workspace evidence WITHOUT calling
 * any side-effecting download endpoint on browse. Downloads and generation
 * requests happen only on an explicit per-row action.
 *
 * Hard rules:
 *   - Browse is NEVER a download. Page-mount emits no custody events, no
 *     signed-URL generation, no audit log writes.
 *   - Every count comes from the aggregator. No client arithmetic, no
 *     decorative charts, no fabricated readiness.
 *   - Reports are described as "generated snapshots" / "verification
 *     packages". The page makes NO legal-admissibility, authenticity or
 *     "court-ready" claims.
 *
 * COMPACT OPERATIONS VIEW (2026-10-16).
 *
 * The page had become fifteen summary cards, fourteen always-visible filter
 * chips and a list of tall cards with every action repeated on every row —
 * and one record routinely appeared in three of the cards at once. It is now:
 *
 *   1. SIX metrics, each with one definition and the filter whose total it
 *      equals. The record-status counts are mutually exclusive (the server's
 *      `deliverableStatusFor`), so nothing is double counted; everything else
 *      sits in ONE "Detailed breakdown" disclosure.
 *   2. Search, a four-way status selector, an "Advanced filters" panel (record
 *      status, report, package, entitlement) and a sort. The URL carries all of
 *      it; a legacy `?lifecycle=` link lands on its dimension.
 *   3. A compact table (stacked cards on a narrow screen): title and type,
 *      status with its reason, report and package state with version, original
 *      integrity, capture date, the primary action and an overflow menu.
 *
 * Every word comes from the shared Reports copy (en/de/ar) through the server's
 * bounded values; no enum, lifecycle key or worker code is shown raw.
 */

import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
// RGA-04 — the ONE shared download-failure authority (same vocabulary as Evidence Detail).
import { describeArtifactDownloadFailure } from "../../lib/evidence/report-download-feedback";
// RELIABILITY CLOSURE (2026-09-09) — the canonical action label and the one
// reader of the typed generation outcome, shared with Evidence Detail.
import {
  DOWNLOAD_PACKAGE_LABEL,
  DOWNLOAD_REPORT_LABEL,
} from "../../lib/evidence/generation-labels";
import {
  outputActionLabel,
  outputNoteCopy,
  outputNoteShort,
  outputTerminalReasonCopy,
  type DeliverableStatus,
  type DeliverableStatusReason,
  type OutputKind, evidenceVerificationStatusTone } from "@proovra/shared";
import { fillReportsCopy, reportsCopyFor, type ReportsCopy } from "@proovra/shared/i18n";
import {
  readGenerationOutcome,
  type GenerationOutcomeTone,
  type GenerationResponse,
} from "../../lib/evidence/generation-outcome";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { PageShell, PageHeader, PageSection } from "../ui";
import { Card } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { Download, FileText, MoreHorizontal, Search, SlidersHorizontal } from "lucide-react";
import { apiFetch } from "../../lib/api";
import "./reports.css";
// THE canonical Evidence title cascade, type label and integrity label — the
// same ones the Evidence Library uses.
import {
  getDisplayTitle,
  getEvidenceTypeLabel,
  getVerificationStatusLabel,
} from "../../app/(app)/evidence/lib/evidence-library-status";
import { usePlatformContext, useWorkspaceId } from "../../lib/platform-context";
import { useUrlFilterSync } from "../../lib/use-url-filter-sync";
import { useOptionalLocale } from "../../app/providers";
import { useOpsTime } from "../../app/(app)/operations/_lib/copy";
import { formatUserDate } from "../../lib/date";
import { ContextualHelp } from "../contextual-help/ContextualHelp";
import { AccessGate } from "../access/AccessGate";
import { AppStatusBadge, type AppTone } from "../app-primitives/AppStatusBadge";
import { AppRowMenu, type AppRowAction } from "../app-primitives/AppRowMenu";
import { AppListbox } from "../app-primitives/AppListbox";
// Phase G3.2 — every Report PDF / Verification Package ZIP download MUST route
// through the governance pre-flight wrapper (`/v1/governance/export-eligibility`).
import { GovernedExportAction } from "../governance/GovernedExportAction";
import type { EvidenceOutputState } from "@proovra/shared";
import type {
  ArtifactRow,
  PackageLifecycle,
  ReportLifecycle,
  ReportsArtifactsEnvelope,
  ReportsFilters,
  ReportsSummary,
  StatusFilter,
} from "./types";
import {
  advancedFilterCount,
  apiQueryFor,
  DEFAULT_FILTERS,
  ENTITLEMENT_DIMENSION,
  filtersFromSearch,
  filtersToSearch,
  isFiltered,
  PACKAGE_DIMENSION,
  PRIMARY_STATUS_FILTERS,
  REPORT_DIMENSION,
  STATUS_FILTERS,
  supportsRecordStatus,
  supportsReportBlockedBuckets,
  supportsTruthfulOutputBuckets,
} from "./types";

/** The server default. Named so the pager and the page agree on one number. */
const REPORTS_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// THE SUMMARY, declared once.
// ---------------------------------------------------------------------------

type MetricTone = "success" | "warning" | "danger" | "info" | "accent" | "neutral";

/**
 * EXACTLY FOUR (2026-10-17), in this order. Each counts RECORDS, has one
 * definition (shared copy) and names the filter whose list total it equals —
 * clicking it applies exactly that filter, so the number and the rows below
 * always agree. "Reports ready" and "Packages ready" left the summary: they
 * restated the Ready status filter and the per-row state.
 *
 * The TONE names what the card MEANS, in the canonical metric-card tones
 * (`data-app-metric-tone`, app-primitives.css): informational blue, progress
 * purple, attention orange, danger red. Every card also carries its label and
 * definition as text, so colour is never the only signal.
 */
const PRIMARY_METRICS: ReadonlyArray<{
  key: string;
  field: keyof ReportsSummary;
  copy: keyof ReportsCopy["metrics"];
  apply: Partial<ReportsFilters>;
  tone: MetricTone;
  /** Needs the record-status API. */
  recordStatus: boolean;
}> = [
  { key: "records", field: "recordsTotal", copy: "records", apply: {}, tone: "info", recordStatus: true },
  { key: "in_progress", field: "recordsInProgress", copy: "inProgress", apply: { status: "in_progress" }, tone: "accent", recordStatus: true },
  { key: "needs_attention", field: "recordsNeedingAttention", copy: "needsAttention", apply: { status: "needs_attention" }, tone: "warning", recordStatus: true },
  { key: "incomplete", field: "recordsIncomplete", copy: "incomplete", apply: { status: "incomplete" }, tone: "danger", recordStatus: true },
];

/** Everything else, in ONE disclosure. A row with `apply` opens its filter. */
const BREAKDOWN: ReadonlyArray<{
  group: "breakdownReports" | "breakdownPackages" | "breakdownRecords";
  items: ReadonlyArray<{ field: keyof ReportsSummary & keyof ReportsCopy["breakdown"]; apply: Partial<ReportsFilters> | null }>;
}> = [
  {
    group: "breakdownReports",
    items: [
      { field: "reportsPending", apply: { report: "report_pending" } },
      { field: "reportsFailed", apply: { report: "report_failed" } },
      { field: "reportsUpdateFailed", apply: { report: "report_update_failed" } },
      { field: "reportsBlocked", apply: { report: "report_blocked" } },
      { field: "reportsAwaitingFirstIssuance", apply: { report: "report_awaiting_issuance" } },
      { field: "reportsNotIssued", apply: { entitlement: "report_not_issued" } },
    ],
  },
  {
    group: "breakdownPackages",
    items: [
      { field: "packagesPending", apply: { package: "package_pending" } },
      { field: "packagesFailed", apply: { package: "package_failed" } },
      { field: "packagesBlocked", apply: { package: "package_blocked" } },
      { field: "packagesMissingForLatestReport", apply: { package: "package_missing" } },
    ],
  },
  {
    group: "breakdownRecords",
    items: [
      { field: "outputsEntitlementUnavailable", apply: { entitlement: "entitlement_unavailable" } },
      { field: "recordsNotAvailable", apply: { status: "not_available" } },
      { field: "totalEvidenceWithArtifacts", apply: null },
      { field: "totalArtifactVersions", apply: null },
    ],
  },
];

/** A metric's filter: everything else back to its default, sort kept. */
function applyOnly(current: ReportsFilters, apply: Partial<ReportsFilters>): ReportsFilters {
  return { ...DEFAULT_FILTERS, sort: current.sort, ...apply };
}

/** Is exactly this metric's filter (and nothing else) in force? */
function isOnly(current: ReportsFilters, apply: Partial<ReportsFilters>): boolean {
  const target = applyOnly(current, apply);
  return (
    current.status === target.status &&
    current.report === target.report &&
    current.package === target.package &&
    current.entitlement === target.entitlement &&
    current.q.trim() === ""
  );
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; envelope: ReportsArtifactsEnvelope }
  | { status: "no_workspace" }
  | { status: "auth_error"; code: "auth_required" | "permission_denied" }
  | { status: "unavailable"; message: string };

// Phase IA-self-serve-regression-fix — user-scoped fallback. Shape
// returned by GET /v1/reports (see services/api/src/routes/reports.routes.ts).
type UserReportRow = {
  evidenceId: string;
  teamId?: string | null;
  title: string | null;
  displayFileName?: string | null;
  originalFileName?: string | null;
  mimeType?: string | null;
  type: string;
  status: string;
  caseId: string | null;
  caseTitle?: string | null;
  intakeCustomerId?: string | null;
  createdAt: string;
  /** The server's canonical output lifecycle. Rendered; never re-derived. */
  reportLifecycle: EvidenceOutputState;
  packageLifecycle: EvidenceOutputState;
  outputs?: ArtifactRow["outputs"];
  report: { available: boolean; version: number | null; generatedAtUtc: string | null };
  package: { available: boolean; version: number | null; generatedAtUtc: string | null };
};
type UserReportsEnvelope = { items: UserReportRow[]; nextCursor: string | null };

/**
 * The canonical output state, mapped onto this page's row vocabulary — the
 * same mapping the workspace aggregator applies server-side. Total over
 * `EvidenceOutputState`: a new state is a compile error, not a silent default.
 */
function toReportLifecycle(state: EvidenceOutputState): ReportLifecycle {
  switch (state) {
    case "READY":
      return "ready";
    case "QUEUED":
    case "GENERATING":
      return "pending";
    case "RETRYABLE_FAILURE":
    case "TERMINAL_FAILURE":
    case "ARTIFACT_MISSING":
      return "failed";
    case "NOT_INCLUDED":
    case "ENTITLEMENT_UNAVAILABLE":
      return "unavailable";
    case "NOT_APPLICABLE":
    case "ELIGIBLE_NOT_GENERATED":
      return "not_requested";
    case "BLOCKED":
      return "blocked";
  }
}

function toPackageLifecycle(state: EvidenceOutputState): PackageLifecycle {
  switch (state) {
    case "READY":
      return "ready";
    case "QUEUED":
    case "GENERATING":
      return "pending";
    case "RETRYABLE_FAILURE":
    case "TERMINAL_FAILURE":
    case "ARTIFACT_MISSING":
      return "failed";
    case "NOT_INCLUDED":
    case "ENTITLEMENT_UNAVAILABLE":
      return "unavailable";
    case "NOT_APPLICABLE":
    case "ELIGIBLE_NOT_GENERATED":
    case "BLOCKED":
      return "not_requested";
  }
}

/**
 * Phase IA-self-serve-regression-fix — the user-scoped list, adapted into the
 * artifact envelope. Returns null on any failure so the caller keeps its own
 * error. It carries no workspace summary and no record status (the server
 * projects neither on this route), and the page says so rather than guessing.
 */
async function tryUserScopedReports(workspaceId: string): Promise<ReportsArtifactsEnvelope | null> {
  try {
    const envelope = (await apiFetch(`/v1/reports?teamId=${encodeURIComponent(workspaceId)}`, {
      method: "GET",
    })) as UserReportsEnvelope;
    const items: ArtifactRow[] = (envelope.items ?? []).map((row) => ({
      evidenceId: row.evidenceId,
      teamId: row.teamId ?? null,
      title: row.title ?? null,
      displayFileName: row.displayFileName ?? null,
      originalFileName: row.originalFileName ?? null,
      mimeType: row.mimeType ?? null,
      type: row.type,
      status: row.status,
      verificationStatus: null,
      caseId: row.caseId,
      caseTitle: row.caseTitle ?? null,
      intakeCustomerId: row.intakeCustomerId ?? null,
      createdAt: row.createdAt,
      report: {
        state: toReportLifecycle(row.reportLifecycle),
        version: row.report.version,
        generatedAtUtc: row.report.generatedAtUtc,
      },
      package: {
        state: toPackageLifecycle(row.packageLifecycle),
        version: row.package.version,
        generatedAtUtc: row.package.generatedAtUtc,
        blockedReason: null,
      },
      outputs: row.outputs,
    }));
    return {
      generatedAt: new Date().toISOString(),
      workspace: { id: "user-scoped", role: "USER" },
      sections: {
        summary: { status: "unavailable", data: null },
        artifacts: { status: "ok", items, nextCursor: envelope.nextCursor, total: null },
      },
    };
  } catch {
    return null;
  }
}

export function ReportsIndex() {
  const { state: ctxState } = usePlatformContext();
  const workspaceId = useWorkspaceId();
  const locale = useOptionalLocale();
  const copy = reportsCopyFor(locale);
  const time = useOpsTime();
  const searchParams = useSearchParams();

  const [state, setState] = useState<LoadState>({ status: "loading" });
  /** A reload is in flight over results that are already on screen. */
  const [refreshing, setRefreshing] = useState(false);

  /**
   * THE FILTERS, read from the URL once and written back on every change. A
   * stale or unknown value falls back to its default (`filtersFromSearch`);
   * a legacy `?lifecycle=` link lands on its dimension and the URL is
   * rewritten in the canonical form.
   */
  const [filters, setFilters] = useState<ReportsFilters>(() =>
    filtersFromSearch(searchParams?.toString() ?? ""),
  );
  useUrlFilterSync("/reports", filtersToSearch(filters));
  const [advancedOpen, setAdvancedOpen] = useState(
    () => advancedFilterCount(filtersFromSearch(searchParams?.toString() ?? "")) > 0,
  );
  const advancedPanelId = useId();

  /**
   * CURSOR PAGINATION, as a stack. `cursors[n]` opens page n+2; Previous pops,
   * Next pushes the server's `nextCursor`. Page 1 is always `null`.
   */
  const [cursors, setCursors] = useState<string[]>([]);
  const page = cursors.length + 1;

  /** STALE-RESPONSE GUARD: only the newest request may write state. */
  const listGeneration = useRef(0);
  const listAbort = useRef<AbortController | null>(null);

  /**
   * THE SUMMARY, fetched on its own: workspace totals no filter, search or
   * page can change. One request per workspace, with its own state.
   */
  const [summarySection, setSummarySection] = useState<ReportsArtifactsEnvelope["sections"]["summary"]>({
    status: "unavailable",
    data: null,
  });
  // ET-RPT-05 — the summary has a LOADING phase; "temporarily unavailable"
  // is said only after it was asked for and did not come back.
  const [summaryAnswered, setSummaryAnswered] = useState(false);
  // True while the list on screen came from the user-scoped fallback.
  const [userScopedView, setUserScopedView] = useState(false);

  const summaryData = summarySection.status === "ok" ? summarySection.data : null;
  /*
   * ROLLOUT COMPATIBILITY. What the API accepts is learned from its summary;
   * until the summary answers (or when it could not be read) the current
   * contract is assumed. An API proven older is sent only what it accepts.
   */
  const caps = {
    recordStatus: summaryData ? supportsRecordStatus(summaryData) : true,
    truthfulBuckets: summaryData ? supportsTruthfulOutputBuckets(summaryData) : true,
    blockedBuckets: summaryData ? supportsReportBlockedBuckets(summaryData) : true,
  };
  const apiQuery = apiQueryFor(filters, caps);
  const apiQueryKey = JSON.stringify(apiQuery);

  const loadSummary = useCallback(async () => {
    if (!workspaceId) return;
    setSummaryAnswered(false);
    try {
      const envelope = (await apiFetch(
        `/v1/reports/artifacts?teamId=${encodeURIComponent(workspaceId)}&limit=1`,
        { method: "GET" },
      )) as ReportsArtifactsEnvelope;
      setSummarySection(envelope.sections.summary);
    } catch {
      setSummarySection({ status: "unavailable", data: null });
    } finally {
      setSummaryAnswered(true);
    }
  }, [workspaceId]);

  const reload = useCallback(
    async (queryKey: string, unfiltered: boolean, currentCursor: string | null) => {
      if (!workspaceId) return;
      const generation = (listGeneration.current += 1);
      listAbort.current?.abort();
      const controller = new AbortController();
      listAbort.current = controller;
      const isCurrent = () => generation === listGeneration.current;
      // ONLY the first load shows the skeleton; a reload keeps the results
      // (and the search field's focus) on screen.
      setState((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
      setRefreshing(true);
      const query = JSON.parse(queryKey) as ReturnType<typeof apiQueryFor>;
      const params = new URLSearchParams({
        teamId: workspaceId,
        lifecycle: query.lifecycle,
        // The workspace aggregations are fetched once by `loadSummary`.
        summary: "0",
      });
      if (query.status) params.set("status", query.status);
      if (query.sort) params.set("sort", query.sort);
      if (query.search) params.set("search", query.search);
      if (currentCursor) params.set("cursor", currentCursor);
      try {
        const envelope = (await apiFetch(`/v1/reports/artifacts?${params.toString()}`, {
          method: "GET",
          signal: controller.signal,
        })) as ReportsArtifactsEnvelope;
        if (!isCurrent()) return;
        // THE FALLBACK IS A BOOTSTRAP PROBE, NOT AN EMPTY-RESULT HANDLER: it
        // runs only for the unfiltered default view, the one shape the
        // user-scoped route (which takes no filter) can describe.
        if (
          unfiltered &&
          envelope.sections.artifacts.status === "ok" &&
          envelope.sections.artifacts.items.length === 0
        ) {
          const recovered = await tryUserScopedReports(workspaceId);
          if (recovered && isCurrent() && recovered.sections.artifacts.items.length > 0) {
            setUserScopedView(true);
            setState({ status: "ready", envelope: recovered });
            return;
          }
        }
        setUserScopedView(false);
        setState({ status: "ready", envelope });
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError" || !isCurrent()) return;
        const e = err as { message?: string; statusCode?: number };
        // 404 = not a member of this workspace: the personal-workspace
        // bootstrap gap. Fall back to the user-scoped list.
        if (e.statusCode === 404) {
          const recovered = await tryUserScopedReports(workspaceId);
          if (recovered && isCurrent()) {
            setUserScopedView(true);
            setState({ status: "ready", envelope: recovered });
            return;
          }
        }
        if (e.statusCode === 401) {
          setState({ status: "auth_error", code: "auth_required" });
        } else if (e.statusCode === 403) {
          setState({ status: "auth_error", code: "permission_denied" });
        } else {
          setState({
            status: "unavailable",
            message: toSafeUserError(e, { message: "Unable to load artifacts." }).message,
          });
        }
      } finally {
        if (isCurrent()) setRefreshing(false);
      }
    },
    [workspaceId],
  );

  const ctxStateName = ctxState.name;
  const ctxErrorCode = ctxState.name === "FAILED" ? ctxState.errorCode : null;
  const ctxMessage = ctxState.name === "FAILED" ? ctxState.message : null;
  useEffect(() => {
    if (ctxStateName === "IDLE" || ctxStateName === "LOADING_CONTEXT") {
      setState({ status: "loading" });
      return;
    }
    if (ctxStateName === "FAILED") {
      const isAuth = ctxErrorCode === "AUTH_REQUIRED" || ctxErrorCode === "PERMISSION_DENIED";
      setState({
        status: isAuth ? "auth_error" : "unavailable",
        code: ctxErrorCode === "PERMISSION_DENIED" ? "permission_denied" : "auth_required",
        message: ctxMessage,
      } as LoadState);
      return;
    }
    if (!workspaceId) {
      setState({ status: "no_workspace" });
      return;
    }
    // A workspace switch goes back to page 1 (same reference when already
    // there, so no needless commit) and re-reads the summary. The list effect
    // below owns the list request.
    setCursors((prev) => (prev.length > 0 ? [] : prev));
    void loadSummary();
  }, [ctxStateName, ctxErrorCode, ctxMessage, workspaceId, loadSummary]);

  const unfiltered = !isFiltered(filters);
  // THE LIST QUERY. Filters, search and page describe one request, so one
  // effect owns it. Typing keeps a short debounce; everything else is instant.
  useEffect(() => {
    if (!workspaceId) return;
    const cursor = cursors.length > 0 ? cursors[cursors.length - 1] : null;
    const t = setTimeout(() => {
      void reload(apiQueryKey, unfiltered, cursor);
    }, filters.q.trim() ? 250 : 0);
    return () => clearTimeout(t);
  }, [apiQueryKey, unfiltered, filters.q, cursors, reload, workspaceId]);

  // A different query is a different ordered set: back to page 1.
  const changeFilters = useCallback((next: ReportsFilters) => {
    setFilters(next);
    setCursors([]);
  }, []);
  const patchFilters = useCallback(
    (patch: Partial<ReportsFilters>) => changeFilters({ ...filters, ...patch }),
    [changeFilters, filters],
  );
  const clearFilters = useCallback(
    () => changeFilters({ ...DEFAULT_FILTERS, sort: filters.sort }),
    [changeFilters, filters.sort],
  );

  // AFTER A GENERATION REQUEST, RE-READ — never assume.
  const refreshAfterAction = useCallback(() => {
    void loadSummary();
    const cursor = cursors.length > 0 ? cursors[cursors.length - 1] : null;
    void reload(apiQueryKey, unfiltered, cursor);
  }, [loadSummary, reload, apiQueryKey, unfiltered, cursors]);

  /*
   * POLL WHILE A VISIBLE ROW HAS LIVE WORK — at the interval the server states,
   * list only (the summary is re-read once when the work ends). Bounded to ten
   * minutes. A poll is silent: nothing is announced to assistive technology.
   */
  const liveInterval =
    state.status === "ready" && state.envelope.sections.artifacts.status === "ok"
      ? state.envelope.sections.artifacts.items.reduce<number | null>((min, row) => {
          const ms = row.outputs?.pollIntervalMs ?? null;
          return ms == null ? min : min == null ? ms : Math.min(min, ms);
        }, null)
      : null;
  const pollStartedAt = useRef<number | null>(null);
  useEffect(() => {
    if (liveInterval == null) {
      if (pollStartedAt.current != null) {
        pollStartedAt.current = null;
        void loadSummary();
      }
      return;
    }
    pollStartedAt.current ??= Date.now();
    if (Date.now() - pollStartedAt.current > 10 * 60_000) return;
    const cursor = cursors.length > 0 ? cursors[cursors.length - 1] : null;
    const t = setTimeout(() => void reload(apiQueryKey, unfiltered, cursor), liveInterval);
    return () => clearTimeout(t);
  }, [liveInterval, state, reload, loadSummary, apiQueryKey, unfiltered, cursors]);

  if (state.status === "loading") return <ReportsLoading copy={copy} />;
  if (state.status === "no_workspace") return <ReportsNoWorkspace copy={copy} />;
  if (state.status === "auth_error") return <ReportsAuthError code={state.code} copy={copy} />;
  if (state.status === "unavailable") return <ReportsUnavailable message={state.message} copy={copy} />;

  const { envelope } = state;
  const { sections } = envelope;
  const pageCount =
    sections.artifacts.total != null
      ? Math.max(1, Math.ceil(sections.artifacts.total / REPORTS_PAGE_SIZE))
      : null;
  const listTotal = sections.artifacts.total ?? sections.artifacts.items.length;
  const filtered = isFiltered(filters);
  const advancedCount = advancedFilterCount(filters);

  // Filter options offered only where the API has proven it accepts them.
  const lifecycleOffered = (v: string) =>
    (caps.truthfulBuckets ||
      !["package_missing", "report_awaiting_issuance", "report_not_issued", "entitlement_unavailable"].includes(v)) &&
    (caps.blockedBuckets || !["report_update_failed", "report_blocked"].includes(v));

  /** The active advanced dimensions, each removable on its own. */
  const activeAdvanced: Array<{ key: string; label: string; clear: Partial<ReportsFilters> }> = [];
  if (!PRIMARY_STATUS_FILTERS.includes(filters.status)) {
    activeAdvanced.push({
      key: "status",
      label: `${copy.filters.statusLabel}: ${copy.filters.status[filters.status]}`,
      clear: { status: "all" },
    });
  }
  if (filters.report !== "any") {
    activeAdvanced.push({
      key: "report",
      label: `${copy.filters.reportLabel}: ${copy.filters.report[filters.report]}`,
      clear: { report: "any" },
    });
  }
  if (filters.package !== "any") {
    activeAdvanced.push({
      key: "package",
      label: `${copy.filters.packageLabel}: ${copy.filters.package[filters.package]}`,
      clear: { package: "any" },
    });
  }
  if (filters.entitlement !== "any") {
    activeAdvanced.push({
      key: "entitlement",
      label: `${copy.filters.entitlementLabel}: ${copy.filters.entitlement[filters.entitlement]}`,
      clear: { entitlement: "any" },
    });
  }

  const metrics = PRIMARY_METRICS.filter(
    (m) => (caps.recordStatus || !m.recordStatus) && typeof summaryData?.[m.field] === "number",
  );
  // Records exist, none holds a current artifact: say why instead of an empty
  // "ready" story (each row's status carries the reason).
  const noCurrentArtifacts =
    !filtered &&
    summaryData != null &&
    summaryData.totalEvidenceWithArtifacts === 0 &&
    sections.artifacts.items.length > 0;

  return (
    <PageShell
      data-reports-index
      header={
        <PageHeader
          eyebrow={copy.page.eyebrow}
          title={
            <span className="app-title-row">
              <span aria-hidden className="app-title-icon">
                <FileText strokeWidth={1.75} data-reports-title-icon />
              </span>
              <span data-reports-title>{copy.page.title}</span>
            </span>
          }
          subtitle={copy.page.subtitle}
          contextStrip={
            <span title={envelope.generatedAt} className="rpt-refreshed">
              {fillReportsCopy(copy.page.refreshed, { when: time.ago(envelope.generatedAt) })}
            </span>
          }
        />
      }
    >
      <ContextualHelp surface="reports" collapsedByDefault />

      {/* ---------------------------------------------------- summary */}
      <PageSection title={copy.summary.heading} data-reports-summary>
        {summaryData ? (
          <>
            {metrics.length > 0 ? (
            <div className="rpt-summary">
            <ul className="rpt-summary__grid" data-reports-summary-grid>
              {metrics.map((m) => {
                const value = summaryData[m.field] as number;
                const label = copy.metrics[m.copy].label;
                const defId = `rpt-metric-def-${m.key}`;
                const filterKey =
                  m.apply.status ?? m.apply.report ?? m.apply.package ?? m.apply.entitlement ?? "all";
                return (
                  <li key={m.key}>
                    <button
                      type="button"
                      className="app-metric-card rpt-metric"
                      data-app-metric-tone={m.tone}
                      aria-pressed={isOnly(filters, m.apply)}
                      aria-label={fillReportsCopy(copy.summary.showRecords, { label, count: value })}
                      aria-describedby={defId}
                      onClick={() => changeFilters(applyOnly(filters, m.apply))}
                      data-reports-summary-key={m.key}
                      data-reports-summary-filter={filterKey}
                      data-reports-summary-value={String(value)}
                    >
                      <span className="app-metric-card__value">{value}</span>
                      <span className="app-metric-card__label">{label}</span>
                      <span id={defId} className="app-metric-card__meta">
                        {copy.metrics[m.copy].definition}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            </div>
            ) : null}
            <details className="rpt-breakdown" data-reports-breakdown>
              <summary className="rpt-breakdown__toggle">{copy.summary.breakdown}</summary>
              <div className="rpt-breakdown__groups">
                {BREAKDOWN.map((group) => {
                  const items = group.items.filter(
                    (i) =>
                      typeof summaryData[i.field] === "number" &&
                      (i.apply?.status == null || caps.recordStatus),
                  );
                  if (items.length === 0) return null;
                  return (
                    <section key={group.group} className="rpt-breakdown__group" aria-label={copy.summary[group.group]}>
                      <h3 className="rpt-breakdown__heading">{copy.summary[group.group]}</h3>
                      <ul className="rpt-breakdown__list">
                        {items.map((i) => {
                          const value = summaryData[i.field] as number;
                          const label = copy.breakdown[i.field];
                          return (
                            <li key={i.field}>
                              {i.apply ? (
                                <button
                                  type="button"
                                  className="rpt-breakdown__item"
                                  aria-pressed={isOnly(filters, i.apply)}
                                  aria-label={fillReportsCopy(copy.summary.showRecords, { label, count: value })}
                                  onClick={() => changeFilters(applyOnly(filters, i.apply!))}
                                  data-reports-breakdown-key={i.field}
                                  data-reports-breakdown-value={String(value)}
                                >
                                  <span>{label}</span>
                                  <span className="rpt-breakdown__value">{value}</span>
                                </button>
                              ) : (
                                <span
                                  className="rpt-breakdown__item rpt-breakdown__item--static"
                                  data-reports-breakdown-key={i.field}
                                  data-reports-breakdown-value={String(value)}
                                >
                                  <span>{label}</span>
                                  <span className="rpt-breakdown__value">{value}</span>
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  );
                })}
              </div>
            </details>
          </>
        ) : (
          <Card variant="status" tone="neutral">
            <span className="cc-section-note rpt-note" data-cc-section-status={summarySection.status}>
              {!summaryAnswered
                ? copy.summary.loading
                : userScopedView
                  ? copy.summary.userScoped
                  : copy.summary.unavailable}
            </span>
          </Card>
        )}
      </PageSection>

      {/* ---------------------------------------------------- filters */}
      <PageSection title={copy.filters.heading} data-reports-filters>
        {/* THE SHARED CONTROLS (2026-10-17): the search field, AppListbox and
            the ghost reset are the ones Operations, the Evidence library and
            Intake Links use — their hover, focus ring, open and disabled states
            come from app-primitives, not from this page. The segmented control
            is the app's `.cases-segments` pattern. ONE filter state: the
            summary cards and the segments both write `filters.status`, and
            both reflect it (aria-pressed). */}
        <div className="rpt-toolbar" role="search" data-reports-toolbar>
          <div className="app-search-field rpt-toolbar__search">
            <span className="app-search-icon" aria-hidden>
              <Search size={16} />
            </span>
            <input
              type="search"
              className="app-search-input"
              value={filters.q}
              onChange={(e) => patchFilters({ q: e.target.value.slice(0, 80) })}
              placeholder={copy.filters.searchLabel}
              aria-label={copy.filters.searchLabel}
              data-reports-search-input
            />
          </div>
          {caps.recordStatus ? (
            <div
              className="cases-segments rpt-segments"
              role="group"
              aria-label={copy.filters.statusLabel}
              data-reports-status-selector
            >
              {PRIMARY_STATUS_FILTERS.map((st) => {
                const active = filters.status === st;
                return (
                  <button
                    key={st}
                    type="button"
                    aria-pressed={active}
                    onClick={() => patchFilters({ status: st })}
                    data-reports-status-filter={st}
                    className={`cases-filter-chip${active ? " is-active" : ""}`}
                  >
                    {copy.filters.status[st]}
                  </button>
                );
              })}
            </div>
          ) : null}
          <button
            type="button"
            className="app-secondary-action rpt-advanced-toggle"
            aria-expanded={advancedOpen}
            aria-controls={advancedPanelId}
            onClick={() => setAdvancedOpen((v) => !v)}
            data-reports-advanced-toggle
          >
            <SlidersHorizontal size={16} aria-hidden />
            <span>{copy.filters.advanced}</span>
            {advancedCount > 0 ? (
              <span className="rpt-advanced-toggle__count" data-reports-advanced-count={advancedCount}>
                {fillReportsCopy(copy.filters.advancedActive, { n: advancedCount })}
              </span>
            ) : null}
          </button>
          {caps.recordStatus ? (
            <div className="rpt-toolbar__sort" data-reports-sort={filters.sort}>
              <span className="app-visually-hidden" id={`${advancedPanelId}-sort`}>
                {copy.filters.sortLabel}
              </span>
              <AppListbox
                value={filters.sort}
                ariaLabelledby={`${advancedPanelId}-sort`}
                onChange={(v) => patchFilters({ sort: v === "oldest" ? "oldest" : "newest" })}
                options={[
                  { value: "newest", label: copy.filters.sort.newest },
                  { value: "oldest", label: copy.filters.sort.oldest },
                ]}
              />
            </div>
          ) : null}
          {filtered ? (
            <button type="button" className="app-ghost-action" onClick={clearFilters} data-reports-clear-filters>
              {copy.filters.clear}
            </button>
          ) : null}
        </div>

        <div
          id={advancedPanelId}
          role="region"
          aria-label={copy.filters.advancedTitle}
          className="rpt-advanced"
          hidden={!advancedOpen}
          data-reports-advanced-panel
        >
          <div className="rpt-advanced__grid">
            {caps.recordStatus ? (
            <div className="rpt-advanced__field" data-reports-advanced-status={filters.status}>
              <span className="rpt-advanced__label" id={`${advancedPanelId}-status`}>
                {copy.filters.statusLabel}
              </span>
              <AppListbox
                value={filters.status}
                ariaLabelledby={`${advancedPanelId}-status`}
                onChange={(v) => patchFilters({ status: (STATUS_FILTERS as readonly string[]).includes(v) ? (v as StatusFilter) : "all" })}
                options={STATUS_FILTERS.map((st) => ({ value: st, label: copy.filters.status[st] }))}
              />
            </div>
            ) : null}
            <div className="rpt-advanced__field" data-reports-advanced-report={filters.report}>
              <span className="rpt-advanced__label" id={`${advancedPanelId}-report`}>
                {copy.filters.reportLabel}
              </span>
              <AppListbox
                value={filters.report}
                ariaLabelledby={`${advancedPanelId}-report`}
                onChange={(v) => patchFilters({ report: REPORT_DIMENSION.find((d) => d === v) ?? "any" })}
                options={[
                  { value: "any", label: copy.filters.any },
                  ...REPORT_DIMENSION.filter(lifecycleOffered).map((d) => ({ value: d, label: copy.filters.report[d] })),
                ]}
              />
            </div>
            <div className="rpt-advanced__field" data-reports-advanced-package={filters.package}>
              <span className="rpt-advanced__label" id={`${advancedPanelId}-package`}>
                {copy.filters.packageLabel}
              </span>
              <AppListbox
                value={filters.package}
                ariaLabelledby={`${advancedPanelId}-package`}
                onChange={(v) => patchFilters({ package: PACKAGE_DIMENSION.find((d) => d === v) ?? "any" })}
                options={[
                  { value: "any", label: copy.filters.any },
                  ...PACKAGE_DIMENSION.filter(lifecycleOffered).map((d) => ({ value: d, label: copy.filters.package[d] })),
                ]}
              />
            </div>
            <div className="rpt-advanced__field" data-reports-advanced-entitlement={filters.entitlement}>
              <span className="rpt-advanced__label" id={`${advancedPanelId}-entitlement`}>
                {copy.filters.entitlementLabel}
              </span>
              <AppListbox
                value={filters.entitlement}
                ariaLabelledby={`${advancedPanelId}-entitlement`}
                onChange={(v) => patchFilters({ entitlement: ENTITLEMENT_DIMENSION.find((d) => d === v) ?? "any" })}
                options={[
                  { value: "any", label: copy.filters.any },
                  ...ENTITLEMENT_DIMENSION.filter(lifecycleOffered).map((d) => ({ value: d, label: copy.filters.entitlement[d] })),
                ]}
              />
            </div>
          </div>
          <button
            type="button"
            className="app-secondary-action rpt-advanced__done"
            onClick={() => setAdvancedOpen(false)}
            data-reports-advanced-done
          >
            {copy.filters.done}
          </button>
        </div>

        {activeAdvanced.length > 0 ? (
          <ul className="rpt-active-filters" data-reports-active-filters>
            {activeAdvanced.map((a) => (
              <li key={a.key}>
                <button
                  type="button"
                  className="rpt-active-filter"
                  aria-label={fillReportsCopy(copy.filters.removeFilter, { label: a.label })}
                  onClick={() => patchFilters(a.clear)}
                  data-reports-active-filter={a.key}
                >
                  <span>{a.label}</span>
                  <span aria-hidden>✕</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </PageSection>

      {/* ---------------------------------------------------- records */}
      <PageSection
        title={`${copy.list.heading} · ${listTotal}`}
        data-reports-list
        data-reports-refreshing={refreshing ? "true" : "false"}
        aria-busy={refreshing}
      >
        {noCurrentArtifacts ? (
          <Card variant="status" tone="neutral">
            <div className="rpt-note" data-reports-no-artifacts>
              <strong>{copy.empty.noArtifactsTitle}</strong> {copy.empty.noArtifactsBody}
            </div>
          </Card>
        ) : null}
        {sections.artifacts.status !== "ok" && sections.artifacts.items.length === 0 ? (
          <Card variant="status" tone="pending">
            <span className="cc-section-note rpt-note" data-cc-section-status={sections.artifacts.status}>
              {copy.list.unavailable}
            </span>
          </Card>
        ) : sections.artifacts.items.length === 0 ? (
          <ReportsEmptyState filtered={filtered} onClear={clearFilters} copy={copy} />
        ) : (
          <div className="rpt-records">
          <div className="app-table-surface rpt-table-surface">
            <table className="app-table rpt-table" data-reports-list-items aria-label={copy.list.heading}>
              <thead>
                <tr>
                  <th scope="col">{copy.list.columns.evidence}</th>
                  <th scope="col">{copy.list.columns.status}</th>
                  <th scope="col">{copy.list.columns.report}</th>
                  <th scope="col">{copy.list.columns.package}</th>
                  <th scope="col">{copy.list.columns.integrity}</th>
                  <th scope="col">{copy.list.columns.captured}</th>
                  <th scope="col" className="rpt-table__actions-head">
                    {copy.list.columns.actions}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sections.artifacts.items.map((row) => (
                  <ArtifactRowView
                    key={row.evidenceId}
                    row={row}
                    copy={copy}
                    ago={time.ago}
                    onOutputsRequested={refreshAfterAction}
                  />
                ))}
              </tbody>
            </table>
          </div>
          </div>
        )}
        {sections.artifacts.status === "ok" && (page > 1 || sections.artifacts.nextCursor) ? (
          <nav className="rpt-pagination" aria-label={copy.list.pagination} data-reports-pagination>
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => setCursors((c) => c.slice(0, -1))}
              disabled={page <= 1 || refreshing}
              data-reports-prev-page
            >
              {copy.list.previous}
            </button>
            <span className="rpt-pagination__status">
              {pageCount !== null
                ? fillReportsCopy(copy.list.pageOf, { page, count: pageCount })
                : fillReportsCopy(copy.list.page, { page })}
            </span>
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => {
                const next = sections.artifacts.nextCursor;
                if (next) setCursors((c) => [...c, next]);
              }}
              disabled={!sections.artifacts.nextCursor || refreshing}
              data-reports-next-page
            >
              {copy.list.next}
            </button>
          </nav>
        ) : null}
      </PageSection>

      <PageSection data-reports-footnote>
        <div className="cc-section-note rpt-footnote" data-cc-section-status="not_applicable">
          {copy.footnote}
        </div>
      </PageSection>
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// One record
// ---------------------------------------------------------------------------

const FAILURE_REASONS: ReadonlySet<DeliverableStatusReason> = new Set([
  "REPORT_FAILED",
  "PACKAGE_FAILED",
  "REPORT_UPDATE_FAILED",
  "ARTIFACT_MISSING",
]);

/**
 * The status badge's tone. Danger ONLY for a genuine failure this reader can
 * act on (the row offers a verb); a failure escalated to operators, a block or
 * an owed output is a warning; in progress and "nothing owed" are neutral.
 */
function deliverableTone(status: DeliverableStatus, reason: DeliverableStatusReason, actionable: boolean): AppTone {
  switch (status) {
    case "READY":
      return "green";
    case "NEEDS_ATTENTION":
      return FAILURE_REASONS.has(reason) && actionable ? "red" : "amber";
    case "INCOMPLETE":
      return "amber";
    case "IN_PROGRESS":
    case "NOT_AVAILABLE":
      return "slate";
  }
}

/** A per-output state's tone: ready green, failed red, blocked amber, the rest neutral. */
function outputTone(state: ReportLifecycle | PackageLifecycle): string {
  switch (state) {
    case "ready":
      return "green";
    case "failed":
      return "red";
    case "blocked":
      return "amber";
    default:
      return "slate";
  }
}

/** The server's verbs for this row, per output. Nothing invented. */
function outputVerbsFor(row: ArtifactRow): Array<{ kind: OutputKind; action: "GENERATE" | "RETRY" | "RECOVER" }> {
  const verbs: Array<{ kind: OutputKind; action: "GENERATE" | "RETRY" | "RECOVER" }> = [];
  for (const kind of ["report", "verificationPackage"] as const) {
    const a = row.outputs?.[kind].action;
    if (a === "GENERATE" || a === "RETRY" || a === "RECOVER") verbs.push({ kind, action: a });
  }
  return verbs;
}

/** Verified is the only positive integrity outcome; it alone reads green. */
function integrityTone(status: string): string {
  // AUD-47 (2026-10-20) — THE shared tone, drawn in this page's colours.
  return { success: "green", danger: "red", warning: "amber", neutral: "slate" }[evidenceVerificationStatusTone(status)];
}

function ArtifactRowView({
  row,
  copy,
  ago,
  onOutputsRequested,
}: {
  row: ArtifactRow;
  copy: ReportsCopy;
  ago: (iso: string | null | undefined) => string;
  onOutputsRequested?: () => void;
}) {
  const title = getDisplayTitle({
    id: row.evidenceId,
    title: row.title,
    displayFileName: row.displayFileName,
    originalFileName: row.originalFileName,
    type: row.type,
    mimeType: row.mimeType,
    itemCount: null,
  });
  const typeLabel = getEvidenceTypeLabel({ type: row.type, mimeType: row.mimeType, itemCount: null } as never);
  const verbs = outputVerbsFor(row);
  const olderPackage =
    row.package.state !== "ready" ? (row.outputs?.verificationPackage.latestAvailableVersion ?? null) : null;

  return (
    <tr className="rpt-row" data-reports-row-id={row.evidenceId} data-reports-row-status={row.deliverable?.status}>
      <td className="rpt-cell rpt-cell--evidence">
        <div className="rpt-evidence">
          <Link
            href={`/evidence/${row.evidenceId}`}
            className="rpt-row__title"
            data-reports-open-evidence={row.evidenceId}
          >
            {title}
          </Link>
          <span className="rpt-row__meta">
            <span className="rpt-row__type">{typeLabel}</span>
            {row.caseId ? (
              // The NAME; the short id only for a legacy case that has none.
              <Link href={`/cases/${row.caseId}`} className="rpt-row__case" data-reports-case-link={row.caseId}>
                {row.caseTitle ?? `#${row.caseId.slice(0, 6)}`}
              </Link>
            ) : null}
            {row.intakeCustomerId ? (
              <span className="rpt-row__muted" data-reports-customer-id={row.intakeCustomerId}>
                {fillReportsCopy(copy.list.customer, { id: row.intakeCustomerId })}
              </span>
            ) : null}
          </span>
        </div>
      </td>
      <td className="rpt-cell">
        <span className="rpt-cell__label">{copy.list.columns.status}</span>
        {row.deliverable ? (
          <span className="rpt-status-cell">
            <AppStatusBadge
              tone={deliverableTone(row.deliverable.status, row.deliverable.reason, verbs.length > 0)}
              dot
              data-reports-row-status-badge={row.deliverable.status}
            >
              {copy.statuses[row.deliverable.status]}
            </AppStatusBadge>
            {row.deliverable.reason !== "COMPLETE" ? (
              <span className="rpt-row__reason" data-reports-row-reason={row.deliverable.reason}>
                {copy.reasons[row.deliverable.reason]}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="rpt-row__muted">—</span>
        )}
      </td>
      <td className="rpt-cell">
        <span className="rpt-cell__label">{copy.list.columns.report}</span>
        <OutputCell
          state={row.report.state}
          version={row.report.version}
          generatedAtUtc={row.report.generatedAtUtc}
          copy={copy}
          ago={ago}
          dataAttr={{ "data-reports-report-state": row.report.state }}
        />
      </td>
      <td className="rpt-cell">
        <span className="rpt-cell__label">{copy.list.columns.package}</span>
        <OutputCell
          state={row.package.state}
          version={row.package.version}
          generatedAtUtc={row.package.generatedAtUtc}
          copy={copy}
          ago={ago}
          dataAttr={{ "data-reports-package-state": row.package.state }}
        />
        {olderPackage ? (
          // It names the report it certifies, so it is never read as proof for
          // the latest report (2026-09-29).
          <span className="rpt-row__muted rpt-row__note" data-reports-historical-package-version={olderPackage}>
            {fillReportsCopy(copy.list.olderPackage, { n: olderPackage })}
          </span>
        ) : null}
      </td>
      <td className="rpt-cell">
        <span className="rpt-cell__label">{copy.list.columns.integrity}</span>
        {row.verificationStatus ? (
          // The ORIGINAL evidence integrity check — not a statement about any
          // report or package.
          <span
            className="rpt-status"
            data-tone={integrityTone(row.verificationStatus)}
            data-reports-verification={row.verificationStatus}
          >
            {getVerificationStatusLabel(row.verificationStatus)}
          </span>
        ) : (
          <span className="rpt-row__muted">—</span>
        )}
      </td>
      <td className="rpt-cell">
        <span className="rpt-cell__label">{copy.list.columns.captured}</span>
        <time dateTime={row.createdAt} title={formatUserDate(row.createdAt)} className="rpt-row__muted">
          {ago(row.createdAt)}
        </time>
      </td>
      <td className="rpt-cell rpt-cell--actions">
        <ArtifactRowActions
          row={row}
          title={title}
          teamId={row.teamId}
          copy={copy}
          onOutputsRequested={onOutputsRequested}
        />
      </td>
    </tr>
  );
}

function OutputCell({
  state,
  version,
  generatedAtUtc,
  copy,
  ago,
  dataAttr,
}: {
  state: ReportLifecycle | PackageLifecycle;
  version: number | null;
  generatedAtUtc: string | null;
  copy: ReportsCopy;
  ago: (iso: string | null | undefined) => string;
  dataAttr: Record<string, string>;
}) {
  return (
    <span className="rpt-output">
      <span className="rpt-status" data-tone={outputTone(state)} {...dataAttr}>
        {copy.outputStates[state]}
        {version ? ` · ${fillReportsCopy(copy.list.version, { n: version })}` : ""}
      </span>
      {state === "ready" && generatedAtUtc ? (
        <time dateTime={generatedAtUtc} title={formatUserDate(generatedAtUtc)} className="rpt-row__muted">
          {ago(generatedAtUtc)}
        </time>
      ) : null}
    </span>
  );
}

/**
 * The row's sentence for a refused generation request. A declined request
 * (409) carries the server's own reason sentence; 403 is the domain permission
 * `evidence.generate_report`, which OWNER, ADMIN and MEMBER hold.
 */
function requestErrorMessage(err: unknown): string {
  const e = err as { statusCode?: number };
  if (e?.statusCode === 403) {
    return "You do not have permission to generate reports in this workspace.";
  }
  if (e?.statusCode === 404) return "Evidence not found.";
  return toSafeUserError(err, { message: "Could not request generation." }).message;
}

/**
 * THE ROW'S ACTIONS — the server's, never this page's guess.
 *
 *   * PRIMARY: the server's verb when it offers one (Generate / Retry /
 *     Recover), else the report download.
 *   * The two DOWNLOADS stay visible buttons, each inside the governance
 *     pre-flight (`GovernedExportAction`).
 *   * Everything else — a second verb, Open evidence, Open case — is in the
 *     row's overflow menu.
 *   * No verb when the server offers none; the reason is stated instead.
 */
function ArtifactRowActions({
  row,
  title,
  teamId,
  copy,
  onOutputsRequested,
}: {
  row: ArtifactRow;
  title: string;
  teamId: string | null;
  copy: ReportsCopy;
  onOutputsRequested?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "report" | "package" | "regen">(null);
  const [error, setError] = useState<string | null>(null);
  // ET-RPT-06 — the outcome keeps its own tone.
  const [regenNotice, setRegenNotice] = useState<{ message: string; tone: GenerationOutcomeTone } | null>(null);

  const triggerReport = async () => {
    if (busy) return;
    setBusy("report");
    setError(null);
    try {
      const resp = (await apiFetch(`/v1/evidence/${row.evidenceId}/report/latest`, { method: "GET" })) as {
        url?: string;
      };
      if (resp.url) {
        window.open(resp.url, "_blank", "noopener,noreferrer");
      } else {
        setError("Report URL is unavailable.");
      }
    } catch (err) {
      setError(describeArtifactDownloadFailure("report", err).message);
    } finally {
      setBusy(null);
    }
  };

  const triggerPackage = async () => {
    if (busy) return;
    setBusy("package");
    setError(null);
    try {
      const resp = (await apiFetch(`/v1/evidence/${row.evidenceId}/verification-package`, {
        method: "GET",
      })) as { url?: string; code?: string; message?: string };
      if (resp.url) {
        window.open(resp.url, "_blank", "noopener,noreferrer");
      } else {
        setError(
          describeArtifactDownloadFailure("verificationPackage", {
            code: resp.code,
            statusCode: resp.code ? 202 : 503,
          }).message,
        );
      }
    } catch (err) {
      setError(describeArtifactDownloadFailure("verificationPackage", err).message);
    } finally {
      setBusy(null);
    }
  };

  /** ONE OUTPUT'S ACTION — the verb the server chose for that output. */
  const requestOutput = async (intent: "GENERATE" | "RETRY" | "RECOVER", output: OutputKind) => {
    if (busy) return;
    setBusy("regen");
    setError(null);
    setRegenNotice(null);
    try {
      const resp = (await apiFetch(`/v1/evidence/${row.evidenceId}/reports/regenerate`, {
        method: "POST",
        body: JSON.stringify({ intent, output }),
      })) as GenerationResponse;
      const outcome = readGenerationOutcome(resp);
      setRegenNotice({ message: outcome.message, tone: outcome.tone });
    } catch (err) {
      setError(requestErrorMessage(err));
    } finally {
      setBusy(null);
      // Re-read either way: a declined request means this row was stale.
      onOutputsRequested?.();
    }
  };

  const reportReady = row.report.state === "ready";
  const packageReady = row.package.state === "ready";
  const verbs = outputVerbsFor(row);
  const primaryVerb = verbs[0] ?? null;
  const extraVerbs = verbs.slice(1);

  // WHY NO VERB, when a person should know (escalated, under review, a hold,
  // no permission). Short here; the full sentence is the tooltip.
  const withheldOutput =
    verbs.length > 0
      ? null
      : ((["report", "verificationPackage"] as const)
          .map((kind) => row.outputs?.[kind] ?? null)
          .find((output) => output !== null && outputNoteShort(output) !== null) ?? null);
  const withheld = withheldOutput
    ? outputTerminalReasonCopy(withheldOutput.terminalReasonCode)
      ? (withheldOutput.terminalReasonCode ?? null)
      : (withheldOutput.actionUnavailableReason ?? null)
    : null;

  const menuActions: AppRowAction[] = [
    ...extraVerbs.map(({ kind, action }) => ({
      key: `verb-${kind}`,
      label: outputActionLabel(kind, action, "compact"),
      onSelect: () => void requestOutput(action, kind),
      disabled: busy !== null,
    })),
    {
      key: "open-evidence",
      label: copy.list.openEvidence,
      onSelect: () => router.push(`/evidence/${row.evidenceId}`),
      separated: extraVerbs.length > 0,
    },
    ...(row.caseId
      ? [{ key: "open-case", label: copy.list.openCase, onSelect: () => router.push(`/cases/${row.caseId}`) }]
      : []),
  ];

  return (
    <div className="rpt-row__actions" data-reports-row-actions={row.evidenceId}>
      {primaryVerb ? (
        <button
          type="button"
          className="app-primary-action rpt-row__action"
          data-reports-regenerate={row.evidenceId}
          data-reports-output={primaryVerb.kind}
          data-reports-generate-verb={primaryVerb.action}
          onClick={() => void requestOutput(primaryVerb.action, primaryVerb.kind)}
          disabled={busy !== null}
        >
          {/* The COMPACT label: a shortening of the full one, never a
              different name for the same operation. */}
          {busy === "regen" ? copy.list.requesting : outputActionLabel(primaryVerb.kind, primaryVerb.action, "compact")}
        </button>
      ) : null}
      {reportReady ? (
        <GovernedExportAction
          evidenceId={row.evidenceId}
          teamId={teamId}
          actionLabel={DOWNLOAD_REPORT_LABEL}
          compactWhenAllowed
          onAction={() => void triggerReport()}
          renderAction={({ disabled, onClick }) => (
            <button
              type="button"
              className={`${primaryVerb ? "app-secondary-action" : "app-primary-action"} rpt-row__action`}
              data-reports-download-report={row.evidenceId}
              aria-label={DOWNLOAD_REPORT_LABEL}
              title={DOWNLOAD_REPORT_LABEL}
              onClick={onClick}
              disabled={busy !== null || disabled}
            >
              <Download size={14} aria-hidden />
              <span>{busy === "report" ? copy.list.opening : copy.list.reportPdfShort}</span>
            </button>
          )}
        />
      ) : null}
      {packageReady ? (
        <GovernedExportAction
          evidenceId={row.evidenceId}
          teamId={teamId}
          actionLabel={DOWNLOAD_PACKAGE_LABEL}
          compactWhenAllowed
          onAction={() => void triggerPackage()}
          renderAction={({ disabled, onClick }) => (
            <button
              type="button"
              className="app-secondary-action app-secondary-action--filled rpt-row__action"
              data-reports-download-package={row.evidenceId}
              aria-label={DOWNLOAD_PACKAGE_LABEL}
              title={DOWNLOAD_PACKAGE_LABEL}
              onClick={onClick}
              disabled={busy !== null || disabled}
            >
              <Download size={14} aria-hidden />
              <span>{busy === "package" ? copy.list.opening : copy.list.packageZipShort}</span>
            </button>
          )}
        />
      ) : null}
      <AppRowMenu
        label={fillReportsCopy(copy.list.moreActions, { title })}
        actions={menuActions}
        dataPrefix="reports"
        triggerLabel={copy.list.moreActionsShort}
        triggerLabelClassName="rpt-when-narrow"
        icon={<MoreHorizontal size={16} aria-hidden />}
      />
      {withheld && withheldOutput ? (
        <span
          className="app-status-text rpt-row__note"
          data-tone="slate"
          data-reports-action-withheld={withheld}
          title={outputNoteCopy(withheldOutput) ?? undefined}
        >
          {outputNoteShort(withheldOutput)}
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="app-status-text rpt-row__feedback" data-tone="red" data-reports-row-error={row.evidenceId}>
          {error}
        </span>
      ) : null}
      {regenNotice ? (
        <span
          role={regenNotice.tone === "error" ? "alert" : "status"}
          className="app-status-text rpt-row__feedback"
          data-tone={GENERATION_OUTCOME_STATUS_TONE[regenNotice.tone]}
          data-reports-row-regen-notice={row.evidenceId}
          data-reports-row-regen-tone={regenNotice.tone}
        >
          {regenNotice.message}
        </span>
      ) : null}
    </div>
  );
}

/** ET-RPT-06 — an outcome tone on the shared status-text scale. */
const GENERATION_OUTCOME_STATUS_TONE: Record<GenerationOutcomeTone, string> = {
  success: "green",
  info: "blue",
  error: "red",
};

/**
 * THE EMPTY STATE, aware of what was asked: a workspace with nothing yet
 * (first use, with the way to start) is not a filter that matched nothing
 * (with the way back).
 */
function ReportsEmptyState({
  filtered,
  onClear,
  copy,
}: {
  filtered: boolean;
  onClear: () => void;
  copy: ReportsCopy;
}) {
  return (
    <div data-reports-empty={filtered ? "filtered" : "workspace"} data-reports-empty-kind={filtered ? "no_match" : "no_data"}>
      <EmptyState
        framed
        title={filtered ? copy.empty.filteredTitle : copy.empty.workspaceTitle}
        purpose={filtered ? copy.empty.filteredBody : copy.empty.workspaceBody}
        action={
          filtered ? (
            <button type="button" className="app-secondary-action" onClick={onClear} data-reports-empty-clear>
              {copy.empty.clearFilters}
            </button>
          ) : (
            <Link href="/evidence" className="app-primary-action" data-reports-empty-state-cta>
              {copy.empty.workspaceAction}
            </Link>
          )
        }
      />
    </div>
  );
}

function ReportsLoading({ copy }: { copy: ReportsCopy }) {
  return (
    <PageShell data-reports-loading header={<PageHeader eyebrow={copy.page.eyebrow} title={copy.page.title} />}>
      <PageSection>
        <Card variant="empty" padding="comfortable">
          <div className="rpt-skeleton" aria-hidden="true" />
        </Card>
      </PageSection>
    </PageShell>
  );
}

function ReportsNoWorkspace({ copy }: { copy: ReportsCopy }) {
  return (
    <PageShell data-reports-no-workspace header={<PageHeader eyebrow={copy.page.eyebrow} title={copy.page.title} />}>
      <PageSection>
        <AccessGate
          kind="WORKSPACE_REQUIRED"
          surface="Reports"
          headline="Workspace setup pending"
          reason="We're finishing workspace setup, or you haven't picked one yet. Reports + verification packages are scoped to a workspace — pick one to continue."
          actions={[
            { label: "Open workspaces", href: "/workspaces", variant: "primary" },
            { label: "Open settings", href: "/settings", variant: "secondary" },
          ]}
          testid="reports-access-gate-no-workspace"
        />
      </PageSection>
    </PageShell>
  );
}

function ReportsAuthError({ code, copy }: { code: "auth_required" | "permission_denied"; copy: ReportsCopy }) {
  return (
    <PageShell
      data-reports-auth-error={code}
      header={<PageHeader eyebrow={copy.page.eyebrow} title={copy.page.title} />}
    >
      <PageSection>
        {code === "auth_required" ? (
          <AccessGate
            kind="PERMISSION_REQUIRED"
            surface="Reports"
            headline="Sign in to view artifacts"
            reason="Your session has expired or you aren't signed in. Sign in to load this workspace's report and verification-package state."
            actions={[{ label: "Sign in", href: "/login", variant: "primary" }]}
            testid="reports-access-gate-auth"
          />
        ) : (
          <AccessGate
            kind="REQUEST_ACCESS"
            surface="Reports"
            headline="You don't have access to this workspace's reports"
            reason="Your role doesn't include report and verification-package access for this workspace. An admin can grant it, or you can switch to a workspace you have access to."
            actions={[
              { label: "Switch workspace", href: "/workspaces", variant: "primary" },
              { label: "Open settings", href: "/settings", variant: "secondary" },
            ]}
            testid="reports-access-gate-permission"
          />
        )}
      </PageSection>
    </PageShell>
  );
}

function ReportsUnavailable({ message, copy }: { message: string; copy: ReportsCopy }) {
  return (
    <PageShell
      data-reports-unavailable
      header={<PageHeader eyebrow={copy.page.eyebrow} title="Temporarily unavailable" subtitle={message} />}
    >
      <PageSection>
        <Card variant="empty" padding="comfortable">
          <EmptyState title="Reports & Artifacts couldn't load" purpose={message} />
        </Card>
      </PageSection>
    </PageShell>
  );
}
