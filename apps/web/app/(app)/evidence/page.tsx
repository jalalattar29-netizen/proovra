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
  EvidenceListResponse,
  EvidenceListScope,
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
import { getEvidenceTypeLabel } from "./lib/evidence-library-status";
import { buildVerificationUrl } from "./lib/evidence-library-formatters";

const PAGE_SIZE = 20;

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

export default function EvidenceLibraryPage() {
  const router = useRouter();
  const { addToast } = useToast();
  const detailCacheRef = useRef<Record<string, DetailWorkspaceState>>({});

  const [filters, setFilters] = useState<EvidenceFilterState>(DEFAULT_FILTERS);
  const [library, setLibrary] = useState<LibraryLoadState>({
    billingOverview: null,
    personalWorkspace: null,
    teamWorkspaces: [],
    cases: [],
    items: [],
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<DetailWorkspaceState | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [assigningCase, setAssigningCase] = useState(false);
  const [removingCase, setRemovingCase] = useState(false);

  const caseMap = useMemo(
    () => new Map(library.cases.map((item) => [item.id, item.name] as const)),
    [library.cases]
  );

  const loadLibrary = useCallback(
    async (scope: EvidenceListScope) => {
      setError(null);

      try {
        const [evidenceRes, casesRes, billingRes] = await Promise.allSettled([
          apiFetch(`/v1/evidence?scope=${scope}`) as Promise<EvidenceListResponse>,
          apiFetch("/v1/cases") as Promise<CasesListResponse>,
          apiFetch("/v1/billing/overview"),
        ]);

        if (evidenceRes.status !== "fulfilled") {
          throw evidenceRes.reason;
        }

        setLibrary({
          items: Array.isArray(evidenceRes.value.items) ? evidenceRes.value.items : [],
          cases:
            casesRes.status === "fulfilled" && Array.isArray(casesRes.value.items)
              ? casesRes.value.items
              : [],
          billingOverview: billingRes.status === "fulfilled" ? (billingRes.value ?? null) : null,
          personalWorkspace:
            billingRes.status === "fulfilled"
              ? (billingRes.value?.workspaces?.personal ?? null)
              : null,
          teamWorkspaces:
            billingRes.status === "fulfilled" && Array.isArray(billingRes.value?.workspaces?.teams)
              ? billingRes.value.workspaces.teams
              : [],
        });
      } catch (loadError) {
        const message =
          loadError instanceof Error ? loadError.message : "Failed to load evidence library";
        setError(message);
        captureException(loadError, {
          feature: "web_evidence_library_scope_load",
          scope,
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
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      await loadLibrary(filters.scope);
      if (!cancelled) {
        setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [filters.scope, loadLibrary]);

  useEffect(() => {
    if (!selectedId && library.items.length > 0) {
      setSelectedId(library.items[0].id);
      return;
    }

    if (selectedId && !library.items.some((item) => item.id === selectedId)) {
      setSelectedId(library.items[0]?.id ?? null);
    }
  }, [library.items, selectedId]);

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
    await loadLibrary(filters.scope);
    if (selectedId) {
      await loadDetail(selectedId, true);
    }
    setRefreshing(false);
  };

  const filteredItems = useMemo(() => {
    const searchNeedle = filters.search.trim().toLowerCase();

    const next = library.items.filter((item) => {
      const matchesSearch =
        !searchNeedle ||
        item.title.toLowerCase().includes(searchNeedle) ||
        item.id.toLowerCase().includes(searchNeedle) ||
        (item.displayFileName ?? "").toLowerCase().includes(searchNeedle) ||
        getEvidenceTypeLabel(item).toLowerCase().includes(searchNeedle);

      if (!matchesSearch) return false;

      if (
        filters.status !== "all" &&
        String(item.status).trim().toLowerCase() !== filters.status
      ) {
        return false;
      }

      if (filters.type !== "all") {
        const kind = item.itemCount > 1 ? "multipart" : item.primaryKind ?? "other";
        if (kind !== filters.type) return false;
      }

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

      if (filters.exportReadiness === "report-available" && !item.latestReportVersion) {
        return false;
      }
      if (filters.exportReadiness === "report-missing" && item.latestReportVersion) {
        return false;
      }

      if (filters.caseAssignment === "assigned" && !item.caseId) return false;
      if (filters.caseAssignment === "unassigned" && item.caseId) return false;

      if (filters.retention === "protected" && !item.storage?.verified) return false;
      if (filters.retention === "unprotected" && item.storage?.verified) return false;

      return true;
    });

    next.sort((a, b) => {
      if (filters.sort === "oldest") {
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      }

      if (filters.sort === "priority") {
        const aPriority = buildReviewPriority(a, a.id === selectedId ? selectedDetail : null);
        const bPriority = buildReviewPriority(b, b.id === selectedId ? selectedDetail : null);
        const order = { critical: 3, operational: 2, informational: 1, stable: 0 } as const;
        return order[bPriority.level] - order[aPriority.level];
      }

      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return next;
  }, [filters, library.items, selectedDetail, selectedId]);

  useEffect(() => {
    setPage(1);
  }, [filters]);

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const pagedItems = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredItems.slice(start, start + PAGE_SIZE);
  }, [filteredItems, page]);

  const selectedItem = useMemo(
    () => library.items.find((item) => item.id === selectedId) ?? null,
    [library.items, selectedId]
  );

  const metrics = useMemo(() => {
    const lockedCount = library.items.filter((item) => item.storage?.verified).length;
    const reportCount = library.items.filter((item) => Boolean(item.latestReportVersion)).length;
    const reviewReadyCount = library.items.filter((item) => Boolean(item.reviewReadyAtUtc)).length;
    const caseLinkedCount = library.items.filter((item) => Boolean(item.caseId)).length;
    const multipartCount = library.items.filter((item) => item.itemCount > 1).length;

    return [
      {
        label: "Loaded records",
        value: String(library.items.length),
        detail: `Current scope: ${filters.scope}`,
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
      {
        label: "Scale note",
        value: library.items.length >= 50 ? "50 loaded" : "Within load",
        detail: "The current evidence list route returns up to 50 records per scope.",
      },
    ];
  }, [filters.scope, library.items]);

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

  return (
    <div className="section app-section evidence-library-page">
      <div className="evidence-library-shell">
        <EvidenceLibraryHeader refreshing={refreshing} onRefresh={refreshCurrentScope} />
        <EvidenceMetrics items={metrics} />
        <EvidenceFilters value={filters} onChange={setFilters} />

        <div className="evidence-library-main">
          <EvidenceList
            items={pagedItems}
            loading={loading}
            error={error}
            selectedId={selectedId}
            caseMap={caseMap}
            currentScope={filters.scope}
            scopeMayBeTruncated={library.items.length >= 50}
            page={page}
            totalPages={totalPages}
            onSelect={setSelectedId}
            onRetry={refreshCurrentScope}
            onOpenRecord={openRecord}
            onDownloadReport={downloadReport}
            canDownloadReport={canDownloadReportForItem}
            onPrevPage={() => setPage((current) => Math.max(1, current - 1))}
            onNextPage={() => setPage((current) => Math.min(totalPages, current + 1))}
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
