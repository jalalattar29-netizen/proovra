"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "../../../components/ui";
import { apiFetch } from "../../../lib/api";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { ContextualHelp } from "../../../components/contextual-help/ContextualHelp";
import { canAccessSurface } from "../../../lib/surface/access";
import { useSurfaceUserContext } from "../../../lib/surface/useSurfaceUserContext";
import {
  usePersonaProfile as useEvidencePersonaProfile,
  workflowFromPersona as evidenceWorkflowFromPersona,
} from "../../../lib/platform-context";
import { captureException } from "../../../lib/sentry";
import { EvidenceLibraryHeader } from "./components/EvidenceLibraryHeader";
import { EvidenceMetrics } from "./components/EvidenceMetrics";
import {
  EvidenceFilters,
  type EvidenceFilterState,
} from "./components/EvidenceFilters";
import { EvidenceList } from "./components/EvidenceList";
import { QueueSelectionPreview } from "./components/QueueSelectionPreview";
import { SavedViewsMenu } from "./components/SavedViewsMenu";
import { BulkActionsToolbar } from "./components/BulkActionsToolbar";
import "./evidence-library.css";
import type {
  EvidenceBulkAction,
  EvidenceBulkActionResponse,
  CasesListResponse,
  DetailWorkspaceState,
  EvidenceLibrarySummaryResponse,
  EvidenceListItem,
  EvidenceListQuery,
  EvidenceListResponse,
  EvidenceResponse,
  EvidenceSavedView,
  EvidenceSavedViewsResponse,
  LibraryLoadState,
  OriginalResponse,
  PartsResponse,
  ReportResponse,
  VerificationPackageResponse,
} from "./lib/evidence-library-types";
import {
  deriveWorkspaceCapabilities,
  getCaseName,
} from "./lib/evidence-library-helpers";
import { buildReviewPriority } from "./lib/evidence-library-alerts";
import { buildVerificationUrl } from "./lib/evidence-library-formatters";

const SERVER_PAGE_LIMIT = 50;

const DEFAULT_FILTERS: EvidenceFilterState = {
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
};

/**
 * Phase EVIDENCE-LIBRARY-DATA-ACCURACY — summary endpoint URL.
 *
 * The summary accepts the same filter parameters as the list
 * endpoint (it reuses `parseEvidenceListQuery` +
 * `buildEvidenceListBaseWhere` server-side), so the workspace
 * counts stay in lock-step with whatever filters the user has
 * applied. Pagination params (limit / cursor) are deliberately
 * omitted — the summary is an aggregation, not a page.
 */
function buildEvidenceLibrarySummaryPath(query: EvidenceListQuery) {
  const params = new URLSearchParams();
  params.set("scope", query.scope);
  if (query.search) params.set("search", query.search);
  if (query.status && query.status !== "all") params.set("status", query.status);
  if (query.type && query.type !== "all") params.set("type", query.type);
  if (query.caseAssignment && query.caseAssignment !== "all") {
    params.set("caseAssignment", query.caseAssignment);
  }
  if (query.caseId) params.set("caseId", query.caseId);
  if (query.reportReady && query.reportReady !== "all") {
    params.set("reportReady", query.reportReady);
  }
  if (query.tsaStatus && query.tsaStatus !== "all") {
    params.set("tsaStatus", query.tsaStatus);
  }
  if (query.otsStatus && query.otsStatus !== "all") {
    params.set("otsStatus", query.otsStatus);
  }
  if (query.publicVerifyState && query.publicVerifyState !== "all") {
    params.set("publicVerifyState", query.publicVerifyState);
  }
  if (query.verificationStatus && query.verificationStatus !== "all") {
    params.set("verificationStatus", query.verificationStatus);
  }
  return `/v1/evidence/library-summary?${params.toString()}`;
}

function buildEvidenceListPath(query: EvidenceListQuery) {
  const params = new URLSearchParams();
  params.set("scope", query.scope);
  params.set("limit", String(query.limit));

  if (query.cursor) params.set("cursor", query.cursor);
  if (query.search) params.set("search", query.search);
  if (query.status && query.status !== "all") params.set("status", query.status);
  if (query.type && query.type !== "all") params.set("type", query.type);
  if (query.caseAssignment && query.caseAssignment !== "all") {
    params.set("caseAssignment", query.caseAssignment);
  }
  if (query.caseId) params.set("caseId", query.caseId);
  if (query.reportReady && query.reportReady !== "all") {
    params.set("reportReady", query.reportReady);
  }
  if (query.tsaStatus && query.tsaStatus !== "all") {
    params.set("tsaStatus", query.tsaStatus);
  }
  if (query.otsStatus && query.otsStatus !== "all") {
    params.set("otsStatus", query.otsStatus);
  }
  if (query.publicVerifyState && query.publicVerifyState !== "all") {
    params.set("publicVerifyState", query.publicVerifyState);
  }
  if (query.verificationStatus && query.verificationStatus !== "all") {
    params.set("verificationStatus", query.verificationStatus);
  }
  if (query.sort) params.set("sort", query.sort);

  return `/v1/evidence?${params.toString()}`;
}

/**
 * Phase HOME-PROOF — visible chip strip for trust-signal filters.
 *
 * When Home priority links land here they apply a backend filter that
 * isn't reflected in the existing dropdown UI. The chip strip makes
 * the active filter visible (so the user understands *why* the list
 * is reduced) and dismissable in one click.
 */
type TrustChipKey = "tsaStatus" | "otsStatus" | "publicVerifyState" | "verificationStatus" | "status" | "type";

function humaniseTrustFilterValue(raw: string): string {
  return raw
    .split(",")
    .map((v) => v.trim().toUpperCase().replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()))
    .join(" / ");
}

function ActiveTrustFilterChips({
  filters,
  onClear,
}: {
  filters: EvidenceFilterState;
  onClear: (key: TrustChipKey) => void;
}) {
  const chips: Array<{ key: TrustChipKey; label: string }> = [];
  if (filters.tsaStatus && filters.tsaStatus !== "all") {
    chips.push({ key: "tsaStatus", label: `Trust timestamp: ${humaniseTrustFilterValue(filters.tsaStatus)}` });
  }
  if (filters.otsStatus && filters.otsStatus !== "all") {
    chips.push({ key: "otsStatus", label: `Blockchain anchor: ${humaniseTrustFilterValue(filters.otsStatus)}` });
  }
  if (filters.publicVerifyState && filters.publicVerifyState !== "all") {
    chips.push({ key: "publicVerifyState", label: `Public verification: ${humaniseTrustFilterValue(filters.publicVerifyState)}` });
  }
  // Phase HOME-CLOSURE — render the "needs integrity review" filter
  // with a friendlier label than its raw enum union ("REVIEW_REQUIRED,
  // FAILED"). This is the new filter the Home Review integrity
  // priority deep-links into.
  if (filters.verificationStatus && filters.verificationStatus !== "all") {
    const vsLabel = /REVIEW_REQUIRED.*FAILED|FAILED.*REVIEW_REQUIRED/i.test(filters.verificationStatus)
      ? "Needs integrity review"
      : humaniseTrustFilterValue(filters.verificationStatus);
    chips.push({ key: "verificationStatus", label: vsLabel });
  }
  if (chips.length === 0) return null;
  return (
    <div
      data-evidence-active-filter-chips
      style={{
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        margin: "8px 0 4px",
      }}
    >
      {chips.map((c) => (
        <span
          key={c.key}
          data-evidence-filter-chip={c.key}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 8px",
            borderRadius: 999,
            background: "#eef2ff",
            color: "#3730a3",
            fontSize: 12.5,
            fontWeight: 600,
          }}
        >
          {c.label}
          <button
            type="button"
            onClick={() => onClear(c.key)}
            aria-label={`Clear ${c.label}`}
            style={{
              border: "none",
              background: "transparent",
              color: "#3730a3",
              cursor: "pointer",
              fontWeight: 700,
              padding: 0,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * Phase HOME-PROOF — read trust-signal filters from URL on first load.
 * Lets Home priority deep-links land on a pre-filtered Evidence view
 * (e.g. `/evidence?tsaStatus=FAILED`). We deliberately read the URL
 * directly (not useSearchParams) to avoid Suspense boundaries here.
 */
function readUrlFilterOverrides(): Partial<EvidenceFilterState> {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  const out: Partial<EvidenceFilterState> = {};
  const tsa = params.get("tsaStatus");
  if (tsa) out.tsaStatus = tsa.toUpperCase();
  const ots = params.get("otsStatus");
  if (ots) out.otsStatus = ots.toUpperCase();
  const pv = params.get("publicVerifyState");
  if (pv) out.publicVerifyState = pv.toUpperCase();
  const vs = params.get("verificationStatus");
  if (vs) out.verificationStatus = vs.toUpperCase();
  const status = params.get("status");
  if (status) out.status = status.toLowerCase();
  const type = params.get("type");
  if (type) out.type = type.toLowerCase();
  return out;
}

// Phase 38.9 — wrap in canonical PageRouteGate. The inner component
// retains its existing capability behavior; the gate short-circuits
// denied states with the canonical structured panel.
export default function EvidenceLibraryPage() {
  return (
    <PageRouteGate routeId="workspace.evidence">
      <EvidenceLibraryPageInner />
    </PageRouteGate>
  );
}

function EvidenceLibraryPageInner() {
  const router = useRouter();
  const { addToast } = useToast();
  const detailCacheRef = useRef<Record<string, DetailWorkspaceState>>({});
  const evidenceRequestRef = useRef(0);

  const [filters, setFilters] = useState<EvidenceFilterState>(DEFAULT_FILTERS);
  const [debouncedSearch, setDebouncedSearch] = useState(DEFAULT_FILTERS.search);
  const [library, setLibrary] = useState<LibraryLoadState>({
    billingOverview: null,
    personalWorkspace: null,
    teamWorkspaces: [],
    cases: [],
    savedViews: [],
    items: [],
    pageInfo: null,
  });
  const [supportLoaded, setSupportLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentCursor, setCurrentCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [pageNumber, setPageNumber] = useState(1);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<DetailWorkspaceState | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /**
   * Phase EVIDENCE-LIBRARY-DATA-ACCURACY — workspace summary.
   *
   * Null when the new `/v1/evidence/library-summary` endpoint is
   * unreachable. The metric cards then label every non-trivial
   * card "On this page" and the package-readiness card specifically
   * says "Package readiness unavailable" — we NEVER fall back to the
   * `latestReportVersion` proxy for package state.
   */
  const [workspaceSummary, setWorkspaceSummary] =
    useState<EvidenceLibrarySummaryResponse | null>(null);
  const defaultSavedViewAppliedRef = useRef(false);
  const urlFiltersAppliedRef = useRef(false);

  // Phase HOME-PROOF — apply URL trust-signal filters once on mount so
  // Home priority deep-links (e.g. /evidence?tsaStatus=FAILED) land on
  // a pre-filtered view. Subsequent edits to filters go through the
  // normal updateFilters path.
  useEffect(() => {
    if (urlFiltersAppliedRef.current) return;
    urlFiltersAppliedRef.current = true;
    const overrides = readUrlFilterOverrides();
    if (Object.keys(overrides).length > 0) {
      setFilters((prev) => ({ ...prev, ...overrides }));
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedSearch(filters.search);
    }, 300);

    return () => window.clearTimeout(timeout);
  }, [filters.search]);

  const caseMap = useMemo(
    () => new Map(library.cases.map((item) => [item.id, item.name] as const)),
    [library.cases]
  );

  const serverQuery = useMemo<EvidenceListQuery>(
    () => ({
      scope: filters.scope,
      limit: SERVER_PAGE_LIMIT,
      cursor: currentCursor,
      search: debouncedSearch.trim() || undefined,
      status: filters.status !== "all" ? filters.status : undefined,
      type: filters.type !== "all" ? filters.type : undefined,
      caseAssignment:
        filters.caseAssignment === "assigned" || filters.caseAssignment === "unassigned"
          ? filters.caseAssignment
          : "all",
      reportReady:
        filters.exportReadiness === "report-available"
          ? "ready"
          : filters.exportReadiness === "report-missing"
            ? "missing"
            : "all",
      tsaStatus: filters.tsaStatus !== "all" ? filters.tsaStatus : undefined,
      otsStatus: filters.otsStatus !== "all" ? filters.otsStatus : undefined,
      publicVerifyState:
        filters.publicVerifyState !== "all" ? filters.publicVerifyState : undefined,
      verificationStatus:
        filters.verificationStatus !== "all" ? filters.verificationStatus : undefined,
      sort:
        filters.sort === "oldest" || filters.sort === "priority"
          ? filters.sort
          : "newest",
    }),
    [
      currentCursor,
      debouncedSearch,
      filters.caseAssignment,
      filters.exportReadiness,
      filters.scope,
      filters.sort,
      filters.status,
      filters.type,
      filters.tsaStatus,
      filters.otsStatus,
      filters.publicVerifyState,
      filters.verificationStatus,
    ]
  );

  const updateFilters = useCallback((next: EvidenceFilterState) => {
    setFilters(next);
    setCurrentCursor(null);
    setCursorHistory([]);
    setPageNumber(1);
    setSelectedIds(new Set());
  }, []);

  const loadSupportData = useCallback(
    async (force = false) => {
      if (!force && supportLoaded) {
        return;
      }

      const [casesRes, billingRes, savedViewsRes] = await Promise.allSettled([
        apiFetch("/v1/cases") as Promise<CasesListResponse>,
        apiFetch("/v1/billing/overview"),
        apiFetch("/v1/evidence/saved-views") as Promise<EvidenceSavedViewsResponse>,
      ]);

      setLibrary((current) => ({
        ...current,
        cases:
          casesRes.status === "fulfilled" && Array.isArray(casesRes.value.items)
            ? casesRes.value.items
            : current.cases,
        billingOverview:
          billingRes.status === "fulfilled" ? (billingRes.value ?? null) : current.billingOverview,
        personalWorkspace:
          billingRes.status === "fulfilled"
            ? (billingRes.value?.workspaces?.personal ?? null)
            : current.personalWorkspace,
        teamWorkspaces:
          billingRes.status === "fulfilled" && Array.isArray(billingRes.value?.workspaces?.teams)
            ? billingRes.value.workspaces.teams
            : current.teamWorkspaces,
        savedViews:
          savedViewsRes.status === "fulfilled" && Array.isArray(savedViewsRes.value.items)
            ? savedViewsRes.value.items
            : current.savedViews,
      }));
      setSupportLoaded(true);
    },
    [supportLoaded]
  );

  const loadLibraryPage = useCallback(
    async (query: EvidenceListQuery) => {
      const requestId = evidenceRequestRef.current + 1;
      evidenceRequestRef.current = requestId;
      setError(null);

      try {
        // Phase EVIDENCE-LIBRARY-DATA-ACCURACY — list + summary in
        // parallel. List failure remains a hard fail (existing
        // behaviour). Summary failure is soft: we null the state
        // and the metric cards transparently surface the fallback
        // labels — package readiness specifically becomes
        // "Package readiness unavailable" (no silent
        // latestReportVersion proxy).
        const [evidence, summarySettled] = await Promise.all([
          apiFetch(buildEvidenceListPath(query)) as Promise<EvidenceListResponse>,
          (async () => {
            try {
              return (await apiFetch(
                buildEvidenceLibrarySummaryPath(query),
              )) as EvidenceLibrarySummaryResponse;
            } catch {
              return null;
            }
          })(),
        ]);

        if (evidenceRequestRef.current !== requestId) {
          return;
        }

        setLibrary((current) => ({
          ...current,
          items: Array.isArray(evidence.items) ? evidence.items : [],
          pageInfo: evidence.pageInfo ?? null,
          totalCount: typeof evidence.totalCount === "number" ? evidence.totalCount : undefined,
        }));
        setWorkspaceSummary(summarySettled);
      } catch (loadError) {
        if (evidenceRequestRef.current !== requestId) {
          return;
        }

        const message =
          loadError instanceof Error ? loadError.message : "Failed to load evidence library";
        setError(message);
        setLibrary((current) => ({
          ...current,
          items: [],
          pageInfo: null,
        }));
        // Phase EVIDENCE-LIBRARY-DATA-ACCURACY — clear the summary
        // too so the metric cards switch to the honest fallback
        // labels instead of showing stale workspace numbers.
        setWorkspaceSummary(null);
        captureException(loadError, {
          feature: "web_evidence_library_scope_load",
          query,
        });
        addToast(message, "error");
      }
    },
    [addToast]
  );

  const loadDetail = useCallback(
    async (evidenceId: string, force = false) => {
      const selectedListItem = library.items.find((item) => item.id === evidenceId);
      if (!selectedListItem) return;

      setDetailError(null);

      if (!force && detailCacheRef.current[evidenceId]) {
        setSelectedDetail(detailCacheRef.current[evidenceId]);
        return;
      }

      setDetailLoading(true);

      try {
        const [evidenceRes, partsRes, originalRes, reportRes, verificationRes] =
          await Promise.allSettled([
            apiFetch(`/v1/evidence/${evidenceId}`) as Promise<EvidenceResponse>,
            apiFetch(`/v1/evidence/${evidenceId}/parts`) as Promise<PartsResponse>,
            apiFetch(`/v1/evidence/${evidenceId}/original`) as Promise<OriginalResponse>,
            apiFetch(`/v1/evidence/${evidenceId}/report/latest`) as Promise<ReportResponse>,
            apiFetch(
              `/v1/evidence/${evidenceId}/verification-package`
            ) as Promise<VerificationPackageResponse>,
          ]);

        const evidence =
          evidenceRes.status === "fulfilled" ? evidenceRes.value.evidence ?? null : null;
        const detail: DetailWorkspaceState = {
          evidence,
          parts:
            partsRes.status === "fulfilled" && Array.isArray(partsRes.value.parts)
              ? partsRes.value.parts
              : [],
          original: originalRes.status === "fulfilled" ? originalRes.value ?? null : null,
          report: reportRes.status === "fulfilled" ? reportRes.value ?? null : null,
          verificationPackage:
            verificationRes.status === "fulfilled" ? verificationRes.value ?? null : null,
          capabilities: deriveWorkspaceCapabilities({
            evidence: evidence ?? {
              teamId: selectedListItem.teamId,
              caseId: selectedListItem.caseId,
              workspaceNameSnapshot: null,
            },
            personal: library.personalWorkspace,
            teams: library.teamWorkspaces,
            cases: library.cases,
          }),
          caseName: getCaseName(evidence?.caseId ?? selectedListItem.caseId, caseMap),
        };

        detailCacheRef.current[evidenceId] = detail;
        setSelectedDetail(detail);
      } catch (loadError) {
        const message =
          loadError instanceof Error ? loadError.message : "Failed to load review workspace";
        setDetailError(message);
        captureException(loadError, {
          feature: "web_evidence_library_detail_load",
          evidenceId,
        });
      } finally {
        setDetailLoading(false);
      }
    },
    [caseMap, library.cases, library.items, library.personalWorkspace, library.teamWorkspaces]
  );

  useEffect(() => {
    void loadSupportData();
  }, [loadSupportData]);

  useEffect(() => {
    if (defaultSavedViewAppliedRef.current) {
      return;
    }

    const defaultView = library.savedViews.find((view) => view.isDefault);
    if (!defaultView) {
      defaultSavedViewAppliedRef.current = true;
      return;
    }

    const hasCustomFilters =
      JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS);
    if (hasCustomFilters) {
      defaultSavedViewAppliedRef.current = true;
      return;
    }

    defaultSavedViewAppliedRef.current = true;
    updateFilters({
      ...DEFAULT_FILTERS,
      ...defaultView.filters,
      scope: defaultView.scope,
    });
  }, [filters, library.savedViews, updateFilters]);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      await loadLibraryPage(serverQuery);
      if (!cancelled) {
        setLoading(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [loadLibraryPage, serverQuery]);

  const visibleItems = useMemo(() => {
    const next = library.items.filter((item) => {
      if (filters.review === "review-ready" && !item.reviewReadyAtUtc) return false;
      if (
        filters.review === "review-required" &&
        String(item.verificationStatus ?? "").toUpperCase() !== "REVIEW_REQUIRED"
      ) {
        return false;
      }
      if (
        filters.review === "verification-failed" &&
        String(item.verificationStatus ?? "").toUpperCase() !== "FAILED"
      ) {
        return false;
      }

      if (filters.retention === "protected" && !item.storage?.verified) return false;
      if (filters.retention === "unprotected" && item.storage?.verified) return false;

      return true;
    });

    if (filters.sort === "priority") {
      next.sort((a, b) => {
        const aPriority = buildReviewPriority(a, a.id === selectedId ? selectedDetail : null);
        const bPriority = buildReviewPriority(b, b.id === selectedId ? selectedDetail : null);
        const order = { critical: 3, operational: 2, informational: 1, stable: 0 } as const;
        return order[bPriority.level] - order[aPriority.level];
      });
    }

    return next;
  }, [filters.retention, filters.review, filters.sort, library.items, selectedDetail, selectedId]);

  useEffect(() => {
    if (!selectedId && visibleItems.length > 0) {
      setSelectedId(visibleItems[0].id);
      return;
    }

    if (selectedId && !visibleItems.some((item) => item.id === selectedId)) {
      setSelectedId(visibleItems[0]?.id ?? null);
    }
  }, [selectedId, visibleItems]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedDetail(null);
      return;
    }

    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  const refreshCurrentScope = async () => {
    setRefreshing(true);
    detailCacheRef.current = {};

    await Promise.allSettled([loadSupportData(true), loadLibraryPage(serverQuery)]);

    if (selectedId) {
      await loadDetail(selectedId, true);
    }

    setRefreshing(false);
  };

  const selectedItem = useMemo(
    () => visibleItems.find((item) => item.id === selectedId) ?? null,
    [selectedId, visibleItems]
  );

  /**
   * Phase EVIDENCE-LIBRARY-DATA-ACCURACY — informational metric cards.
   *
   * The cards are read-only — they do NOT apply filters when clicked
   * (the EvidenceMetrics component renders plain divs, not buttons).
   * The page's filtering happens in the dropdown filter row + saved
   * views, unchanged from before.
   *
   * Each card's `detail` line carries the source scope so the user
   * never reads a page-loaded count as a workspace total:
   *
   *   "Workspace total · {scope}"  — backend `/v1/evidence/library-summary`
   *   "On this page"               — derived from `visibleItems`
   *   "Package readiness unavailable" — backend summary failed; we
   *                                     do NOT fall back to
   *                                     `latestReportVersion`
   *                                     because that is a proxy that
   *                                     misreports records whose
   *                                     report succeeded but whose
   *                                     package generation failed.
   */
  const metrics = useMemo(() => {
    const usingWorkspaceTotal = workspaceSummary !== null;
    const workspaceScopeDetail = `Workspace total · ${filters.scope}`;
    const pageScopeDetail = "On this page";

    // Page-derived (safe fallbacks for non-package values).
    const pageReviewReadyCount = visibleItems.filter((item) => Boolean(item.reviewReadyAtUtc)).length;
    const pageMultipartCount = visibleItems.filter((item) => item.itemCount > 1).length;
    const pageProtectedCount = visibleItems.filter((item) => item.storage?.verified).length;
    const pageUnassignedCount = visibleItems.filter((item) => !item.caseId).length;

    // Card 1 — Total active records. Workspace total when available,
    // else fall through to the existing list-response totalCount, else
    // the current page count (clearly labelled).
    const activeRecordsCard = usingWorkspaceTotal
      ? {
          label: "Active records",
          value: String(workspaceSummary.totalActiveRecords),
          detail: workspaceScopeDetail,
        }
      : typeof library.totalCount === "number"
        ? {
            label: "Active records",
            value: String(library.totalCount),
            detail: `Workspace total · ${filters.scope}`,
          }
        : {
            label: "Active records",
            value: String(visibleItems.length),
            detail: pageScopeDetail,
          };

    // Card 2 — Reports ready. Workspace via real `reports.some` count.
    // Page fallback via `latestReportVersion` (the list field IS the
    // report-version count, so the proxy is honest here — the issue
    // was only with PACKAGE readiness).
    const reportsReadyCard = usingWorkspaceTotal
      ? {
          label: "Reports ready",
          value: String(workspaceSummary.reportsReadyCount),
          tone: "success" as const,
          detail: workspaceScopeDetail,
        }
      : {
          label: "Reports ready",
          value: String(visibleItems.filter((item) => item.reportReady === true).length),
          tone: "success" as const,
          detail: pageScopeDetail,
        };

    // Card 3 — Verification packages ready. THIS IS THE
    // LOAD-BEARING ACCURACY FIX. We refuse to fall back to a
    // `latestReportVersion` proxy because report-ready does not
    // imply package-ready (failure mode: report succeeds, package
    // generation fails). When the backend summary is unavailable,
    // we surface that honestly.
    const packagesReadyCard = usingWorkspaceTotal
      ? {
          label: "Verification packages ready",
          value: String(workspaceSummary.packagesReadyCount),
          tone: "success" as const,
          detail: workspaceScopeDetail,
        }
      : {
          label: "Verification packages ready",
          value: "—",
          detail: "Package readiness unavailable",
        };

    // Card 4 — Verification packages missing. Same accuracy rule.
    const packagesMissingCard = usingWorkspaceTotal
      ? {
          label: "Verification packages missing",
          value: String(workspaceSummary.packagesMissingCount),
          tone: workspaceSummary.packagesMissingCount > 0
            ? ("warning" as const)
            : ("default" as const),
          detail: workspaceScopeDetail,
        }
      : {
          label: "Verification packages missing",
          value: "—",
          detail: "Package readiness unavailable",
        };

    // Card 5 — Storage protection. Workspace mirrors the list
    // mapper's `storage.verified` predicate (OR of objectLockMode /
    // retainUntil / legalHold). Page fallback uses the same field.
    const storageProtectedCard = usingWorkspaceTotal
      ? {
          label: "Storage protection",
          value: String(workspaceSummary.storageProtectedCount),
          detail: workspaceScopeDetail,
        }
      : {
          label: "Storage protection",
          value: String(pageProtectedCount),
          detail: pageScopeDetail,
        };

    // Card 6 — Multipart packages. Workspace via real
    // `parts.some(partIndex > 0)`. Page fallback via `itemCount > 1`.
    const multipartCard = usingWorkspaceTotal
      ? {
          label: "Multipart packages",
          value: String(workspaceSummary.multipartCount),
          detail: workspaceScopeDetail,
        }
      : {
          label: "Multipart packages",
          value: String(pageMultipartCount),
          detail: pageScopeDetail,
        };

    // Card 7 — Unassigned records (no case linkage).
    const unassignedCard = usingWorkspaceTotal
      ? {
          label: "Unassigned records",
          value: String(workspaceSummary.unassignedCount),
          detail: workspaceScopeDetail,
        }
      : {
          label: "Unassigned records",
          value: String(pageUnassignedCount),
          detail: pageScopeDetail,
        };

    // Card 8 — Review-ready markers (page only — no equivalent
    // workspace metric is needed for the operational view and the
    // existing list field is reliable per row).
    const reviewReadyCard = {
      label: "Review-ready records",
      value: String(pageReviewReadyCount),
      tone: "success" as const,
      detail: pageScopeDetail,
    };

    return [
      activeRecordsCard,
      reportsReadyCard,
      packagesReadyCard,
      packagesMissingCard,
      storageProtectedCard,
      multipartCard,
      unassignedCard,
      reviewReadyCard,
    ];
  }, [filters.scope, library.totalCount, visibleItems, workspaceSummary]);

  const pageLabel = useMemo(() => `Page ${pageNumber}`, [pageNumber]);
  const resultsLabel = useMemo(() => {
    if (typeof library.totalCount === "number") {
      return `${visibleItems.length} loaded of ${library.totalCount}`;
    }

    return `${visibleItems.length} page results`;
  }, [library.totalCount, visibleItems.length]);

  const allCurrentPageSelected = useMemo(
    () => visibleItems.length > 0 && visibleItems.every((item) => selectedIds.has(item.id)),
    [selectedIds, visibleItems]
  );

  const teamOptions = useMemo(
    () => library.teamWorkspaces.map((team) => ({ id: team.id, name: team.name })),
    [library.teamWorkspaces]
  );

  const applySavedView = useCallback(
    (view: EvidenceSavedView) => {
      updateFilters({
        ...DEFAULT_FILTERS,
        ...view.filters,
        scope: view.scope,
      });
      addToast(`Loaded saved view: ${view.name}`, "success");
    },
    [addToast, updateFilters]
  );

  const createSavedView = useCallback(
    async ({
      name,
      description,
      isDefault,
      teamId,
    }: {
      name: string;
      description: string;
      isDefault: boolean;
      teamId?: string | null;
    }) => {
      const response = (await apiFetch("/v1/evidence/saved-views", {
        method: "POST",
        body: JSON.stringify({
          name,
          description: description || null,
          isDefault,
          teamId: teamId ?? null,
          scope: filters.scope,
          sortKey: filters.sort,
          filters,
        }),
      })) as EvidenceSavedViewsResponse;

      if (response.savedView) {
        setLibrary((current) => ({
          ...current,
          savedViews: [response.savedView!, ...current.savedViews.filter((view) => view.id !== response.savedView!.id)],
        }));
        addToast("Saved view created", "success");
      }
    },
    [addToast, filters]
  );

  const updateSavedView = useCallback(
    async (id: string, input: { name?: string; description?: string; isDefault?: boolean }) => {
      const response = (await apiFetch(`/v1/evidence/saved-views/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      })) as EvidenceSavedViewsResponse;

      if (response.savedView) {
        setLibrary((current) => ({
          ...current,
          savedViews: current.savedViews.map((view) => {
            if (response.savedView?.isDefault && view.id !== response.savedView.id && view.teamId === response.savedView.teamId) {
              return { ...view, isDefault: false };
            }
            return view.id === response.savedView?.id ? response.savedView : view;
          }),
        }));
        addToast("Saved view updated", "success");
      }
    },
    [addToast]
  );

  const deleteSavedView = useCallback(
    async (id: string) => {
      await apiFetch(`/v1/evidence/saved-views/${id}`, { method: "DELETE" });
      setLibrary((current) => ({
        ...current,
        savedViews: current.savedViews.filter((view) => view.id !== id),
      }));
      addToast("Saved view deleted", "success");
    },
    [addToast]
  );

  const setDefaultSavedView = useCallback(
    async (id: string) => {
      const response = (await apiFetch(`/v1/evidence/saved-views/${id}/default`, {
        method: "POST",
      })) as EvidenceSavedViewsResponse;

      if (response.savedView) {
        setLibrary((current) => ({
          ...current,
          savedViews: current.savedViews.map((view) =>
            view.teamId === response.savedView?.teamId
              ? { ...view, isDefault: view.id === response.savedView.id }
              : view
          ),
        }));
        addToast("Default saved view updated", "success");
      }
    },
    [addToast]
  );

  const toggleSelected = useCallback((id: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const toggleSelectAllCurrentPage = useCallback(
    (checked: boolean) => {
      setSelectedIds((current) => {
        const next = new Set(current);
        visibleItems.forEach((item) => {
          if (checked) {
            next.add(item.id);
          } else {
            next.delete(item.id);
          }
        });
        return next;
      });
    },
    [visibleItems]
  );

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const openRecord = (evidenceId: string) => {
    router.push(`/evidence/${evidenceId}`);
  };

  const canDownloadReportForItem = useCallback(
    (item: EvidenceListItem) =>
      deriveWorkspaceCapabilities({
        evidence: {
          teamId: item.teamId,
          caseId: item.caseId,
          workspaceNameSnapshot: null,
        },
        personal: library.personalWorkspace,
        teams: library.teamWorkspaces,
        cases: library.cases,
      }).reportsIncluded,
    [library.cases, library.personalWorkspace, library.teamWorkspaces]
  );

  const downloadReport = async (evidenceId: string) => {
    const item = library.items.find((entry) => entry.id === evidenceId);
    if (item && !canDownloadReportForItem(item)) {
      addToast("PDF reports are not included for this workspace plan", "info");
      return;
    }

    try {
      const data = (await apiFetch(`/v1/evidence/${evidenceId}/report/latest`)) as ReportResponse;
      if (!data?.url) {
        addToast("Report not available", "info");
        return;
      }
      window.open(data.url, "_blank", "noopener,noreferrer");
      addToast("Report downloaded", "success");
    } catch (downloadError) {
      captureException(downloadError, {
        feature: "web_evidence_library_download_report_second_pass",
        evidenceId,
      });
      addToast("Failed to download report", "error");
    }
  };

  const downloadVerificationPackage = async (evidenceId: string) => {
    try {
      const data = (await apiFetch(
        `/v1/evidence/${evidenceId}/verification-package`
      )) as VerificationPackageResponse;
      if (!data?.url) {
        addToast("Verification package not available", "info");
        return;
      }
      window.open(data.url, "_blank", "noopener,noreferrer");
      addToast("Verification package downloaded", "success");
    } catch (downloadError) {
      captureException(downloadError, {
        feature: "web_evidence_library_download_package_second_pass",
        evidenceId,
      });
      addToast("Failed to download verification package", "error");
    }
  };

  const copyVerificationLink = async (evidenceId: string) => {
    try {
      await navigator.clipboard.writeText(buildVerificationUrl(evidenceId));
      addToast("Verification link copied", "success");
    } catch (copyError) {
      captureException(copyError, {
        feature: "web_evidence_library_copy_verify_second_pass",
        evidenceId,
      });
      addToast("Failed to copy verification link", "error");
    }
  };

  const runBulkAction = useCallback(
    async (
      action: EvidenceBulkAction,
      caseId?: string
    ): Promise<EvidenceBulkActionResponse> => {
      const evidenceIds = Array.from(selectedIds);
      const response = (await apiFetch("/v1/evidence/bulk", {
        method: "POST",
        body: JSON.stringify({
          action,
          evidenceIds,
          caseId: caseId ?? null,
        }),
      })) as EvidenceBulkActionResponse;

      if (response.csv) {
        const blob = new Blob([response.csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = response.fileName ?? "evidence-metadata.csv";
        anchor.click();
        URL.revokeObjectURL(url);
      }

      if (Array.isArray(response.items) && response.items.length > 0) {
        setLibrary((current) => {
          const updates = new Map(response.items?.map((item) => [item.id, item] as const));
          return {
            ...current,
            items: current.items.map((item) => updates.get(item.id) ?? item),
          };
        });
      }

      if (action !== "EXPORT_METADATA_CSV") {
        await loadLibraryPage(serverQuery);
      }

      if (selectedId && selectedIds.has(selectedId)) {
        delete detailCacheRef.current[selectedId];
        await loadDetail(selectedId, true);
      }

      const summaryMessage =
        response.failedCount > 0
          ? `${response.successCount} completed, ${response.failedCount} failed`
          : `${response.successCount} records updated`;
      addToast(summaryMessage, response.failedCount > 0 ? "warning" : "success");

      return response;
    },
    [addToast, loadDetail, loadLibraryPage, selectedId, selectedIds, serverQuery]
  );

  const goToPreviousPage = () => {
    if (cursorHistory.length === 0) return;

    const previousCursor = cursorHistory[cursorHistory.length - 1] ?? null;
    setCursorHistory((current) => current.slice(0, -1));
    setCurrentCursor(previousCursor);
    setPageNumber((current) => Math.max(1, current - 1));
  };

  const goToNextPage = () => {
    if (!library.pageInfo?.nextCursor) return;

    setCursorHistory((current) => [...current, currentCursor]);
    setCurrentCursor(library.pageInfo.nextCursor);
    setPageNumber((current) => current + 1);
  };

  // Phase 38.17 — workflow-aware contextual help mount.
  const evidencePersona = useEvidencePersonaProfile();
  const evidenceWorkflowCode = evidenceWorkflowFromPersona(
    evidencePersona.primaryProfile,
  ).code;

  // Phase EVIDENCE-LIBRARY-ENTERPRISE-GATE (FIX 6) — capability gate.
  // The QueueSelectionPreview's reviewer-assignment + due-date rows
  // are enterprise-only — they assume an external reviewer is on
  // the workflow. Personal Space / small-business workspaces hide
  // those rows; the user IS the reviewer there. Backend
  // authorization is unchanged — this is a visibility cleanup only.
  const surfaceUserCtx = useSurfaceUserContext();
  const canSeeReviewerOps = canAccessSurface(surfaceUserCtx, "/reviewer-ops");

  return (
    <div className="section app-section evidence-library-page">
      <div className="evidence-library-shell">
        <EvidenceLibraryHeader refreshing={refreshing} onRefresh={refreshCurrentScope} />
        {/* Phase 38.17 — workflow-aware contextual help, collapsed
            by default so the evidence table stays primary. */}
        <ContextualHelp
          workflow={evidenceWorkflowCode}
          surface="evidence"
          collapsedByDefault
        />
        <EvidenceMetrics items={metrics} />
        <ActiveTrustFilterChips
          filters={filters}
          onClear={(key) =>
            updateFilters({
              ...filters,
              [key]: key === "type" || key === "status" ? "all" : "all",
            })
          }
        />
        <EvidenceFilters
          value={filters}
          onChange={updateFilters}
          headerActions={
            <SavedViewsMenu
              views={library.savedViews}
              teamOptions={teamOptions}
              onApplyView={applySavedView}
              onCreateView={createSavedView}
              onUpdateView={updateSavedView}
              onDeleteView={deleteSavedView}
              onSetDefault={setDefaultSavedView}
            />
          }
        />

        <div className="evidence-library-main">
          <EvidenceList
            items={visibleItems}
            loading={loading}
            error={error}
            selectedId={selectedId}
            caseMap={caseMap}
            currentScope={filters.scope}
            pageLabel={pageLabel}
            resultsLabel={resultsLabel}
            toolbar={
              selectedIds.size > 0 ? (
                <BulkActionsToolbar
                  selectedCount={selectedIds.size}
                  selectedItems={visibleItems.filter((item) => selectedIds.has(item.id))}
                  availableCases={library.cases}
                  onClear={clearSelection}
                  onRun={runBulkAction}
                />
              ) : null
            }
            selectedIds={selectedIds}
            allCurrentPageSelected={allCurrentPageSelected}
            hasNextPage={Boolean(library.pageInfo?.hasMore && library.pageInfo?.nextCursor)}
            hasPreviousPage={cursorHistory.length > 0}
            onSelect={setSelectedId}
            onToggleSelected={toggleSelected}
            onToggleSelectAllCurrentPage={toggleSelectAllCurrentPage}
            onRetry={refreshCurrentScope}
            onOpenRecord={openRecord}
            onDownloadReport={downloadReport}
            canDownloadReport={canDownloadReportForItem}
            onPrevPage={goToPreviousPage}
            onNextPage={goToNextPage}
          />

          <QueueSelectionPreview
            item={selectedItem}
            detail={selectedDetail}
            loading={detailLoading}
            error={detailError}
            caseName={selectedItem?.caseId ? getCaseName(selectedItem.caseId, caseMap) : null}
            canSeeReviewerOps={canSeeReviewerOps}
            onOpenRecord={() => (selectedItem ? openRecord(selectedItem.id) : undefined)}
            onDownloadReport={() =>
              selectedItem ? void downloadReport(selectedItem.id) : undefined
            }
            onDownloadVerificationPackage={() =>
              selectedItem ? void downloadVerificationPackage(selectedItem.id) : undefined
            }
            onCopyVerificationLink={() =>
              selectedItem ? void copyVerificationLink(selectedItem.id) : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
