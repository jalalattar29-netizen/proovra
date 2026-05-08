"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "../../../components/ui";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";
import { EvidenceLibraryHeader } from "./components/EvidenceLibraryHeader";
import { EvidenceMetrics } from "./components/EvidenceMetrics";
import {
  EvidenceFilters,
  type EvidenceFilterState,
} from "./components/EvidenceFilters";
import { EvidenceList } from "./components/EvidenceList";
import { ReviewWorkspace } from "./components/ReviewWorkspace";
import "./evidence-library.css";
import type {
  CasesListResponse,
  DetailWorkspaceState,
  EvidenceListItem,
  EvidenceListQuery,
  EvidenceListResponse,
  EvidenceResponse,
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
};

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
  if (query.sort) params.set("sort", query.sort);

  return `/v1/evidence?${params.toString()}`;
}

export default function EvidenceLibraryPage() {
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
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [assigningCase, setAssigningCase] = useState(false);
  const [removingCase, setRemovingCase] = useState(false);

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
    ]
  );

  const updateFilters = useCallback((next: EvidenceFilterState) => {
    setFilters(next);
    setCurrentCursor(null);
    setCursorHistory([]);
    setPageNumber(1);
  }, []);

  const loadSupportData = useCallback(
    async (force = false) => {
      if (!force && supportLoaded) {
        return;
      }

      const [casesRes, billingRes] = await Promise.allSettled([
        apiFetch("/v1/cases") as Promise<CasesListResponse>,
        apiFetch("/v1/billing/overview"),
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
        const evidence = (await apiFetch(
          buildEvidenceListPath(query)
        )) as EvidenceListResponse;

        if (evidenceRequestRef.current !== requestId) {
          return;
        }

        setLibrary((current) => ({
          ...current,
          items: Array.isArray(evidence.items) ? evidence.items : [],
          pageInfo: evidence.pageInfo ?? null,
          totalCount: typeof evidence.totalCount === "number" ? evidence.totalCount : undefined,
        }));
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

      setSelectedCaseId(selectedListItem.caseId ?? "");
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

  const metrics = useMemo(() => {
    const lockedCount = visibleItems.filter((item) => item.storage?.verified).length;
    const reportCount = visibleItems.filter((item) => Boolean(item.latestReportVersion)).length;
    const reviewReadyCount = visibleItems.filter((item) => Boolean(item.reviewReadyAtUtc)).length;
    const caseLinkedCount = visibleItems.filter((item) => Boolean(item.caseId)).length;
    const multipartCount = visibleItems.filter((item) => item.itemCount > 1).length;

    return [
      {
        label: library.totalCount ? "Records in view" : "Page results",
        value: library.totalCount ? String(library.totalCount) : String(visibleItems.length),
        detail: `Server scope: ${filters.scope}`,
      },
      {
        label: "Loaded on page",
        value: String(visibleItems.length),
        detail: "Current server-filtered results.",
      },
      {
        label: "Report versions recorded",
        value: String(reportCount),
        tone: "success" as const,
        detail: "Based on list response fields only.",
      },
      {
        label: "Review-ready markers",
        value: String(reviewReadyCount),
        tone: "success" as const,
      },
      {
        label: "Case-linked records",
        value: String(caseLinkedCount),
      },
      {
        label: "Storage protection recorded",
        value: String(lockedCount),
      },
      {
        label: "Multipart packages",
        value: String(multipartCount),
      },
      {
        label: "Package readiness",
        value: "Detail check",
        detail: "Verification package state is confirmed only from record detail endpoints.",
      },
    ];
  }, [filters.scope, library.totalCount, visibleItems]);

  const pageLabel = useMemo(() => `Page ${pageNumber}`, [pageNumber]);
  const resultsLabel = useMemo(() => {
    if (typeof library.totalCount === "number") {
      return `${visibleItems.length} loaded of ${library.totalCount}`;
    }

    return `${visibleItems.length} page results`;
  }, [library.totalCount, visibleItems.length]);

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

  const assignCase = async () => {
    if (!selectedItem || !selectedCaseId) return;

    setAssigningCase(true);
    try {
      await apiFetch(`/v1/cases/${selectedCaseId}/evidence`, {
        method: "POST",
        body: JSON.stringify({ evidenceId: selectedItem.id }),
      });

      setLibrary((current) => ({
        ...current,
        items: current.items.map((item) =>
          item.id === selectedItem.id ? { ...item, caseId: selectedCaseId } : item
        ),
      }));

      await loadDetail(selectedItem.id, true);
      addToast("Evidence added to case", "success");
    } catch (assignError) {
      captureException(assignError, {
        feature: "web_evidence_library_assign_case_second_pass",
        evidenceId: selectedItem.id,
        caseId: selectedCaseId,
      });
      addToast(assignError instanceof Error ? assignError.message : "Failed to assign case", "error");
    } finally {
      setAssigningCase(false);
    }
  };

  const removeCase = async () => {
    if (!selectedItem?.caseId || !selectedItem) return;

    setRemovingCase(true);
    try {
      await apiFetch(`/v1/cases/${selectedItem.caseId}/evidence/${selectedItem.id}`, {
        method: "DELETE",
      });

      setLibrary((current) => ({
        ...current,
        items: current.items.map((item) =>
          item.id === selectedItem.id ? { ...item, caseId: null } : item
        ),
      }));
      setSelectedCaseId("");
      await loadDetail(selectedItem.id, true);
      addToast("Evidence removed from case", "success");
    } catch (removeError) {
      captureException(removeError, {
        feature: "web_evidence_library_remove_case_second_pass",
        evidenceId: selectedItem.id,
        caseId: selectedItem.caseId,
      });
      addToast(removeError instanceof Error ? removeError.message : "Failed to remove case", "error");
    } finally {
      setRemovingCase(false);
    }
  };

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

  return (
    <div className="section app-section evidence-library-page">
      <div className="evidence-library-shell">
        <EvidenceLibraryHeader refreshing={refreshing} onRefresh={refreshCurrentScope} />
        <EvidenceMetrics items={metrics} />
        <EvidenceFilters value={filters} onChange={updateFilters} />

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
            hasNextPage={Boolean(library.pageInfo?.hasMore && library.pageInfo?.nextCursor)}
            hasPreviousPage={cursorHistory.length > 0}
            onSelect={setSelectedId}
            onRetry={refreshCurrentScope}
            onOpenRecord={openRecord}
            onDownloadReport={downloadReport}
            canDownloadReport={canDownloadReportForItem}
            onPrevPage={goToPreviousPage}
            onNextPage={goToNextPage}
          />

          <ReviewWorkspace
            item={selectedItem}
            detail={selectedDetail}
            loading={detailLoading}
            error={detailError}
            availableCases={library.cases}
            selectedCaseId={selectedCaseId}
            assigningCase={assigningCase}
            removingCase={removingCase}
            onChangeCase={setSelectedCaseId}
            onAssignCase={assignCase}
            onRemoveCase={removeCase}
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
