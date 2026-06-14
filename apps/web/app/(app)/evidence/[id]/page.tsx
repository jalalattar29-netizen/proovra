"use client";

/**
 * Phase EVIDENCE-IA — Evidence Detail page orchestrator.
 *
 * State, callbacks, hero, tabs navigation, sidebar, and modals only.
 * Tab bodies live in `./_tabs/*` and consume a single `EvidenceDetailCtx`
 * prop bag.
 *
 * Previously this file was 3,614 lines / 147 KB. Phase 0 extracted
 * the 7 tab bodies into separate components without behavior change;
 * subsequent phases (Phase 1–6) trimmed duplication, restructured
 * information architecture into the agreed 5-layer model, rewrote
 * copy for legal safety + plain language, and moved every technical
 * structure to the Technical Appendix tab.
 *
 * 5-layer IA:
 *   Layer 1 — Hero (top of page)                — name, status, actions, legal boundary
 *   Layer 2 — Review workspace                   — Review tab
 *   Layer 3 — Evidence content                   — Overview tab (preview + metadata)
 *   Layer 4 — Verification & preservation        — Integrity tab
 *   Layer 5 — Technical Appendix / advanced     — Technical Appendix tab
 *
 * The "What needs attention" risk strip lives directly below the hero
 * (Phase 3) so users see problems BEFORE any tab body renders.
 */

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ClipboardCheck,
  FileText,
  Globe,
  History,
  LayoutGrid,
  MessageSquare,
  Package,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { Button, Modal, useToast } from "../../../../components/ui";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { canAccessSurface } from "../../../../lib/surface/access";
import { useSurfaceUserContext } from "../../../../lib/surface/useSurfaceUserContext";
import { apiFetch } from "../../../../lib/api";
import { captureException } from "../../../../lib/sentry";
import { formatUserDateTime } from "../../../../lib/date";
import type { CaseOption } from "../lib/evidence-library-types";
import type { ReviewWorkspaceResponse } from "./review-workspace-types";
import {
  fetchEvidenceIntelligence,
  type IntelligenceEvidenceResponse,
} from "../../../../lib/api/intelligence";
import {
  ExportPackageEligibilityBadge,
  RuntimeStatusBanner,
} from "../../../../components/operational";
import { PresenceIndicator } from "../../../../components/presence/PresenceIndicator";
import { CollisionWarning } from "../../../../components/presence/CollisionWarning";
import "./evidence-detail.css";
import {
  SectionHeading,
  buildPublishedVerificationUrl,
  buildRiskSignals,
  buildTechnicalReadinessSummary,
  describeOtsStatus,
  describePublicVerificationState,
  describeReportArtifactStatus,
  describeVerificationPackageStatus,
  formatBytes,
  formatValue,
  isOtsTerminal,
  pillTone,
  shortId,
  shouldPollArtifactReadiness,
  tryDownloadFile,
  type EvidenceDetailCtx,
  type EvidenceDetailTab,
} from "./_tabs/_lib";
import { EvidenceOverviewTab } from "./_tabs/EvidenceOverviewTab";
import { EvidenceIntegrityTab } from "./_tabs/EvidenceIntegrityTab";
import { EvidenceCustodyTab } from "./_tabs/EvidenceCustodyTab";
import { EvidenceReviewTab } from "./_tabs/EvidenceReviewTab";
import { EvidenceArtifactsTab } from "./_tabs/EvidenceArtifactsTab";
import { EvidenceDiscussionTab } from "./_tabs/EvidenceDiscussionTab";
import { EvidenceTechnicalAppendixTab } from "./_tabs/EvidenceTechnicalAppendixTab";

const DETAIL_TABS: Array<{ id: EvidenceDetailTab; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "Overview", icon: LayoutGrid },
  { id: "integrity", label: "Integrity", icon: ShieldCheck },
  { id: "custody", label: "Custody", icon: History },
  { id: "review", label: "Review", icon: ClipboardCheck },
  { id: "artifacts", label: "Artifacts", icon: Package },
  { id: "discussion", label: "Discussion", icon: MessageSquare },
  { id: "technical", label: "Technical Appendix", icon: FileText },
];

export default function EvidenceDetailPage() {
  return (
    <PageRouteGate routeId="workspace.evidence">
      <EvidenceDetailPageInner />
    </PageRouteGate>
  );
}

function EvidenceDetailPageInner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { addToast } = useToast();
  const evidenceId = params?.id ?? "";

  const surfaceUserCtx = useSurfaceUserContext();
  const canSeeReviewerOps = canAccessSurface(surfaceUserCtx, "/reviewer-ops");
  const canSeeGovernance = canAccessSurface(surfaceUserCtx, "/governance");
  const canSeeIntelligence = canAccessSurface(surfaceUserCtx, "/intelligence");
  const canSeeIntakeLinks = canAccessSurface(surfaceUserCtx, "/intake-links");

  const initialTab: EvidenceDetailTab = (() => {
    const raw = searchParams?.get("tab");
    switch (raw) {
      case "overview":
      case "integrity":
      case "custody":
      case "review":
      case "artifacts":
      case "discussion":
      case "technical":
        return raw as EvidenceDetailTab;
      default:
        return "overview";
    }
  })();
  const initialThreadId = searchParams?.get("thread") ?? null;

  const [activeTab, setActiveTab] = useState<EvidenceDetailTab>(initialTab);
  const [workspace, setWorkspace] = useState<ReviewWorkspaceResponse | null>(null);
  const [cases, setCases] = useState<CaseOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [editingLabel, setEditingLabel] = useState(false);
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [assignCaseOpen, setAssignCaseOpen] = useState(false);
  const [lockOpen, setLockOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [workflowStatusDraft, setWorkflowStatusDraft] = useState("NOT_STARTED");
  const [workflowPriorityDraft, setWorkflowPriorityDraft] = useState("NORMAL");
  const [workflowAssigneeDraft, setWorkflowAssigneeDraft] = useState("");
  const [workflowDueAtDraft, setWorkflowDueAtDraft] = useState("");
  const [workflowNoteDraft, setWorkflowNoteDraft] = useState("");
  const [workflowEvents, setWorkflowEvents] = useState<
    Array<{
      id: string;
      eventType: string;
      note: string | null;
      previousValue: unknown;
      nextValue: unknown;
      createdAt: string;
      actor: { id: string; email: string | null; displayName: string | null } | null;
    }>
  >([]);
  const [workflowEventsLoading, setWorkflowEventsLoading] = useState(false);
  const [relationshipOpen, setRelationshipOpen] = useState(false);
  const [relationshipTargetId, setRelationshipTargetId] = useState("");
  const [relationshipType, setRelationshipType] = useState("RELATED");
  const [relationshipNote, setRelationshipNote] = useState("");
  const [exportDisabled, setExportDisabled] = useState(false);
  const [packageDisabled, setPackageDisabled] = useState(false);
  const [initialUpdatedAtUtc, setInitialUpdatedAtUtc] = useState<string | null>(null);
  const [intelligence, setIntelligence] = useState<IntelligenceEvidenceResponse | null>(null);
  const [intelligenceLoaded, setIntelligenceLoaded] = useState(false);
  const [pollStartedAt, setPollStartedAt] = useState<number | null>(null);
  const [stalePending, setStalePending] = useState(false);

  const loadWorkflowEvents = async () => {
    if (!evidenceId) return;
    setWorkflowEventsLoading(true);
    try {
      const response = (await apiFetch(`/v1/evidence/${evidenceId}/reviewer-workflow/events`)) as {
        items?: Array<{
          id: string;
          eventType: string;
          note: string | null;
          previousValue: unknown;
          nextValue: unknown;
          createdAt: string;
          actor: { id: string; email: string | null; displayName: string | null } | null;
        }>;
      };
      setWorkflowEvents(Array.isArray(response.items) ? response.items : []);
    } catch (loadError) {
      captureException(loadError, {
        feature: "web_evidence_workflow_events_load",
        evidenceId,
      });
      addToast("Failed to load workflow history", "error");
    } finally {
      setWorkflowEventsLoading(false);
    }
  };

  const loadWorkspace = async () => {
    if (!evidenceId) return;
    setLoading(true);
    setError(null);
    try {
      const [workspaceResult, casesResult] = await Promise.allSettled([
        apiFetch(`/v1/evidence/${evidenceId}/review-workspace`),
        apiFetch("/v1/cases"),
      ]);
      if (workspaceResult.status !== "fulfilled") throw workspaceResult.reason;
      const workspaceData = workspaceResult.value as ReviewWorkspaceResponse;
      setWorkspace(workspaceData);
      setInitialUpdatedAtUtc((prev) => prev ?? workspaceData.reviewWorkflow.updatedAt ?? null);
      setLabelDraft(workspaceData.evidence.displayTitle || workspaceData.evidence.title);
      setWorkflowStatusDraft(workspaceData.reviewWorkflow.status || "NOT_STARTED");
      setWorkflowPriorityDraft(workspaceData.reviewWorkflow.priority || "NORMAL");
      setWorkflowAssigneeDraft(workspaceData.reviewWorkflow.assignedTo?.id || "");
      setWorkflowDueAtDraft(
        workspaceData.reviewWorkflow.dueAt
          ? workspaceData.reviewWorkflow.dueAt.slice(0, 16)
          : "",
      );
      setWorkflowNoteDraft("");
      if (casesResult.status === "fulfilled") {
        const items = Array.isArray(casesResult.value?.items)
          ? (casesResult.value.items as CaseOption[])
          : [];
        setCases(items);
      } else {
        setCases([]);
      }
    } catch (loadError) {
      const message =
        loadError instanceof Error ? loadError.message : "Failed to load evidence review workspace";
      setError(message);
      captureException(loadError, {
        feature: "web_evidence_review_workspace_load",
        evidenceId,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadWorkspace();
  }, [evidenceId]);

  useEffect(() => {
    if (!evidenceId) return;
    void loadWorkflowEvents();
  }, [evidenceId]);

  useEffect(() => {
    const teamId = workspace?.reviewWorkflow?.teamId ?? null;
    if (!evidenceId || !teamId) return;
    let cancelled = false;
    void (async () => {
      const res = await fetchEvidenceIntelligence(evidenceId, teamId);
      if (cancelled) return;
      setIntelligence(res);
      setIntelligenceLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [evidenceId, workspace?.reviewWorkflow?.teamId]);

  // Phase 32.5 — Artifact-readiness polling. Identical contract to
  // the pre-decomposition implementation. Side-effect-free endpoint
  // (verified by the artifact-status route's contract test). The
  // 60s stale window then surfaces an actionable state instead of
  // looping forever.
  useEffect(() => {
    if (!evidenceId) return;
    if (!shouldPollArtifactReadiness(workspace)) {
      setPollStartedAt(null);
      setStalePending(false);
      return;
    }
    const activeWorkspace = workspace;
    if (!activeWorkspace) return;
    if (pollStartedAt === null) setPollStartedAt(Date.now());

    let cancelled = false;
    let priorReportAvailable = activeWorkspace.artifactStatus.report.available;
    let priorPackageAvailable = activeWorkspace.artifactStatus.verificationPackage.available;

    type ArtifactStatusResponse = {
      report: { available: boolean; pending: boolean };
      verificationPackage: {
        available: boolean;
        pending: boolean;
        unavailable?: boolean;
        unavailableReason?: string | null;
      };
    };

    const STALE_PENDING_AFTER_MS = 60_000;

    const pollOnce = async (): Promise<boolean> => {
      try {
        const r = (await apiFetch(
          `/v1/evidence/${evidenceId}/artifacts/status`,
        )) as ArtifactStatusResponse;
        if (cancelled) return false;
        const reportNowAvailable = r.report?.available === true;
        const packageNowAvailable = r.verificationPackage?.available === true;
        const stateChanged =
          reportNowAvailable !== priorReportAvailable ||
          packageNowAvailable !== priorPackageAvailable;
        priorReportAvailable = reportNowAvailable;
        priorPackageAvailable = packageNowAvailable;
        if (stateChanged) {
          await loadWorkspace();
          setPollStartedAt(Date.now());
          setStalePending(false);
        }
        const reportStillPending = r.report?.pending === true;
        const packageStillPending = r.verificationPackage?.pending === true;
        const stillWaiting = reportStillPending || packageStillPending;
        const startedAt = pollStartedAt ?? Date.now();
        if (stillWaiting && Date.now() - startedAt > STALE_PENDING_AFTER_MS) {
          setStalePending(true);
          return false;
        }
        return stillWaiting;
      } catch {
        return true;
      }
    };

    let timer: ReturnType<typeof setInterval> | null = null;
    let shouldContinue = true;
    void pollOnce().then((cont) => {
      if (cancelled) return;
      shouldContinue = cont;
      if (!shouldContinue) return;
      timer = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        void pollOnce().then((cont2) => {
          if (cancelled) return;
          if (!cont2 && timer) {
            clearInterval(timer);
            timer = null;
          }
        });
      }, 3000);
    });
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [
    evidenceId,
    workspace?.evidence?.status,
    workspace?.artifactStatus?.report?.available,
    workspace?.artifactStatus?.verificationPackage?.available,
    workspace?.artifactStatus?.verificationPackage?.blocked,
    workspace?.artifactStatus?.verificationPackage?.unavailable,
  ]);

  const evidence = workspace?.evidence ?? null;
  const workspaceCaps = workspace?.workspaceCapabilitySnapshot ?? null;

  const publicVerificationState = useMemo(
    () => (workspace ? describePublicVerificationState(workspace.publicVerificationSummary) : null),
    [workspace],
  );
  const otsStatusPresentation = useMemo(
    () => (workspace ? describeOtsStatus(workspace) : null),
    [workspace],
  );
  const technicalReadinessSummary = useMemo(
    () => (workspace ? buildTechnicalReadinessSummary(workspace) : ""),
    [workspace],
  );
  const reviewSignals = useMemo(
    () => (workspace ? buildRiskSignals(workspace.sourceContext, workspace.reviewerAlerts) : []),
    [workspace],
  );

  // Phase 4 — single consolidated metadata grid for the Overview
  // "Record summary" card. Same fields the previous two-panel
  // layout exposed, in one place.
  const overviewMetadataItems = useMemo(() => {
    if (!workspace) return [];
    return [
      { label: "Created", value: formatUserDateTime(workspace.evidence.createdAt) },
      {
        label: "Captured",
        value: formatValue(formatUserDateTime(workspace.evidence.capturedAtUtc)),
      },
      { label: "MIME type", value: workspace.evidence.mimeType || "Not recorded" },
      { label: "File size", value: formatBytes(workspace.evidence.sizeBytes) },
      { label: "Workspace", value: workspaceCaps?.workspaceName || "Not recorded" },
      { label: "Case", value: workspace.relationships.caseName || "Unassigned" },
      {
        label: "Review workflow",
        value: workspace.reviewWorkflow.status
          ? workspace.reviewWorkflow.status.replace(/_/g, " ")
          : "Not started",
      },
      {
        label: "Original filename",
        value:
          workspace.evidence.originalFileName ||
          workspace.evidence.displayFileName ||
          "Not recorded",
      },
    ];
  }, [workspace, workspaceCaps]);

  const reviewReadinessItems = useMemo(() => {
    if (!workspace) return [];
    return [
      {
        label: "Report artifact",
        value: describeReportArtifactStatus(workspace.artifactStatus),
      },
      {
        label: "Verification package",
        value: describeVerificationPackageStatus(
          workspace.artifactStatus,
          workspaceCaps?.verificationPackageIncluded ?? false,
        ),
      },
      {
        label: "Public verification",
        value: publicVerificationState?.label ?? "State unavailable",
      },
      {
        label: "Case assignment",
        value: workspace.relationships.caseName || "Unassigned",
      },
    ];
  }, [publicVerificationState, workspace, workspaceCaps]);

  const saveWorkflow = async () => {
    if (!evidenceId) return;
    setActionBusy(true);
    try {
      await apiFetch(`/v1/evidence/${evidenceId}/reviewer-workflow`, {
        method: "PATCH",
        body: JSON.stringify({
          assignedToUserId: workflowAssigneeDraft || null,
          status: workflowStatusDraft,
          priority: workflowPriorityDraft,
          dueAt: workflowDueAtDraft ? new Date(workflowDueAtDraft).toISOString() : null,
          note: workflowNoteDraft || null,
        }),
      });
      addToast("Reviewer workflow updated", "success");
      setWorkflowOpen(false);
      await Promise.all([loadWorkspace(), loadWorkflowEvents()]);
    } catch (saveError) {
      captureException(saveError, {
        feature: "web_evidence_workflow_update",
        evidenceId,
      });
      addToast(
        saveError instanceof Error ? saveError.message : "Failed to update workflow",
        "error",
      );
    } finally {
      setActionBusy(false);
    }
  };

  const saveRelationship = async () => {
    if (!evidenceId || !relationshipTargetId) return;
    setActionBusy(true);
    try {
      await apiFetch(`/v1/evidence/${evidenceId}/relationships`, {
        method: "POST",
        body: JSON.stringify({
          targetEvidenceId: relationshipTargetId,
          relationshipType,
          note: relationshipNote || null,
        }),
      });
      addToast("Relationship recorded", "success");
      setRelationshipOpen(false);
      setRelationshipTargetId("");
      setRelationshipType("RELATED");
      setRelationshipNote("");
      await loadWorkspace();
    } catch (saveError) {
      captureException(saveError, {
        feature: "web_evidence_relationship_create",
        evidenceId,
      });
      addToast(
        saveError instanceof Error ? saveError.message : "Failed to create relationship",
        "error",
      );
    } finally {
      setActionBusy(false);
    }
  };

  const handleRemoveRelationship = async (relationshipId: string) => {
    if (!evidenceId) return;
    setActionBusy(true);
    try {
      await apiFetch(`/v1/evidence/${evidenceId}/relationships/${relationshipId}`, {
        method: "DELETE",
      });
      addToast("Relationship removed", "success");
      await loadWorkspace();
    } catch (deleteError) {
      captureException(deleteError, {
        feature: "web_evidence_relationship_delete",
        evidenceId,
        relationshipId,
      });
      addToast(
        deleteError instanceof Error ? deleteError.message : "Failed to remove relationship",
        "error",
      );
    } finally {
      setActionBusy(false);
    }
  };

  const handleSaveLabel = async () => {
    if (!evidenceId || !labelDraft.trim()) return;
    setActionBusy(true);
    try {
      await apiFetch(`/v1/evidence/${evidenceId}/label`, {
        method: "PATCH",
        body: JSON.stringify({ label: labelDraft.trim() }),
      });
      setEditingLabel(false);
      addToast("Evidence label updated", "success");
      await loadWorkspace();
    } catch (updateError) {
      captureException(updateError, {
        feature: "web_evidence_detail_update_label",
        evidenceId,
      });
      addToast(
        updateError instanceof Error ? updateError.message : "Failed to update label",
        "error",
      );
    } finally {
      setActionBusy(false);
    }
  };

  const openOriginal = async () => {
    if (!evidenceId) return;
    try {
      const data = (await apiFetch(`/v1/evidence/${evidenceId}/original`)) as {
        url?: string | null;
        publicUrl?: string | null;
      };
      const url = data.publicUrl ?? data.url ?? null;
      if (!url) {
        addToast("Original file not available", "info");
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (openError) {
      addToast("Failed to open original", "error");
      captureException(openError, { feature: "web_evidence_open_original", evidenceId });
    }
  };

  const downloadOriginal = async () => {
    if (!evidenceId) return;
    try {
      const data = (await apiFetch(`/v1/evidence/${evidenceId}/original`)) as {
        url?: string | null;
        publicUrl?: string | null;
        originalFileName?: string | null;
      };
      const url = data.url ?? data.publicUrl ?? null;
      if (!url) {
        addToast("Original file not available", "info");
        return;
      }
      const ok = await tryDownloadFile(url, data.originalFileName || `evidence-${evidenceId}`);
      if (!ok) window.open(url, "_blank", "noopener,noreferrer");
      addToast("Original downloaded", "success");
    } catch (downloadError) {
      addToast("Failed to download original", "error");
      captureException(downloadError, {
        feature: "web_evidence_download_original",
        evidenceId,
      });
    }
  };

  const downloadReport = async () => {
    if (!evidenceId || !workspaceCaps) return;
    if (!workspaceCaps.reportsIncluded) {
      addToast("PDF reports are not included on the current workspace plan", "info");
      return;
    }
    try {
      const data = (await apiFetch(`/v1/evidence/${evidenceId}/report/latest`)) as {
        url?: string | null;
      };
      if (!data.url) {
        addToast("Report not available", "info");
        return;
      }
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (downloadError) {
      addToast("Failed to download report", "error");
      captureException(downloadError, {
        feature: "web_evidence_download_report",
        evidenceId,
      });
    }
  };

  const downloadVerificationPackage = async () => {
    if (!evidenceId || !workspaceCaps) return;
    if (!workspaceCaps.verificationPackageIncluded) {
      addToast(
        "Verification packages are not included on the current workspace plan",
        "info",
      );
      return;
    }
    try {
      const data = (await apiFetch(
        `/v1/evidence/${evidenceId}/verification-package`,
      )) as {
        url?: string | null;
        code?: string | null;
        message?: string | null;
      };
      if (data && typeof data.url === "string" && data.url.length > 0) {
        const ok = await tryDownloadFile(
          data.url,
          `verification-package-${evidenceId}.zip`,
        );
        if (!ok) window.open(data.url, "_blank", "noopener,noreferrer");
        return;
      }
      if (data && data.code === "verification_package_pending") {
        addToast(
          "Verification package is still being generated. Retry shortly.",
          "info",
        );
        return;
      }
      addToast("Verification package is temporarily unavailable.", "info");
    } catch (downloadError) {
      const e = downloadError as {
        statusCode?: number;
        code?: string;
        requestId?: string;
        message?: string;
      };
      let userMessage = "Unable to download verification package.";
      let tone: "info" | "error" = "error";
      switch (e?.code) {
        case "verification_package_pending":
          userMessage = "Verification package is still being generated. Retry shortly.";
          tone = "info";
          break;
        case "verification_package_blocked":
        case "PACKAGE_BLOCKED_BY_POLICY":
          userMessage = "Verification package is blocked by governance policy.";
          tone = "info";
          break;
        case "verification_package_unavailable":
          userMessage =
            "Verification package is unavailable for this workspace context.";
          tone = "info";
          break;
        case "verification_package_not_found":
          userMessage = "Verification package was not found.";
          tone = "info";
          break;
        case "GOVERNANCE_CHECK_FAILED":
        case "governance_schema_unavailable":
          userMessage = "Governance check is temporarily unavailable. Retry shortly.";
          tone = "info";
          break;
        default:
          switch (e?.statusCode) {
            case 401:
              userMessage = "Sign-in required to download this package.";
              tone = "info";
              break;
            case 403:
              userMessage = "Verification package is blocked by governance policy.";
              tone = "info";
              break;
            case 404:
              userMessage = "Verification package was not found.";
              tone = "info";
              break;
            case 409:
              userMessage = "Verification package is blocked by governance policy.";
              tone = "info";
              break;
            case 410:
              userMessage =
                "Verification package is unavailable for this workspace context.";
              tone = "info";
              break;
            case 503:
              userMessage =
                "Verification package is temporarily unavailable. Retry shortly.";
              tone = "info";
              break;
            default:
              userMessage = "Unable to download verification package.";
              tone = "error";
          }
      }
      addToast(userMessage, tone);
      const isExpectedBoundedSignal =
        e?.code === "verification_package_pending" ||
        e?.code === "verification_package_blocked" ||
        e?.code === "verification_package_unavailable" ||
        e?.code === "verification_package_not_found" ||
        e?.code === "PACKAGE_BLOCKED_BY_POLICY" ||
        e?.code === "GOVERNANCE_CHECK_FAILED" ||
        e?.code === "governance_schema_unavailable" ||
        e?.statusCode === 401 ||
        e?.statusCode === 403 ||
        e?.statusCode === 404 ||
        e?.statusCode === 409 ||
        e?.statusCode === 410;
      if (!isExpectedBoundedSignal) {
        captureException(downloadError, {
          feature: "web_evidence_download_verification_package",
          evidenceId,
        });
      }
    }
  };

  const copyShareLink = async () => {
    const url = buildPublishedVerificationUrl(workspace?.publicVerificationSummary);
    if (!url) {
      addToast(
        "Public verification link is only available when publication state is PUBLISHED",
        "info",
      );
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      addToast("Verification link copied", "success");
    } catch (copyError) {
      addToast("Failed to copy verification link", "error");
      captureException(copyError, {
        feature: "web_evidence_copy_share_link",
        evidenceId,
      });
    }
  };

  const runRecordAction = async (path: string, successMessage: string) => {
    if (!evidenceId) return;
    setActionBusy(true);
    try {
      await apiFetch(path, { method: "POST", body: JSON.stringify({}) });
      addToast(successMessage, "success");
      await loadWorkspace();
    } catch (runError) {
      addToast(runError instanceof Error ? runError.message : "Action failed", "error");
      captureException(runError, {
        feature: "web_evidence_record_action",
        evidenceId,
        path,
      });
    } finally {
      setActionBusy(false);
    }
  };

  const moveToTrash = async () => {
    if (!evidenceId) return;
    setActionBusy(true);
    try {
      await apiFetch(`/v1/evidence/${evidenceId}`, { method: "DELETE" });
      addToast("Evidence moved to trash", "success");
      await loadWorkspace();
    } catch (runError) {
      addToast(runError instanceof Error ? runError.message : "Delete failed", "error");
      captureException(runError, { feature: "web_evidence_move_to_trash", evidenceId });
    } finally {
      setActionBusy(false);
    }
  };

  const restoreTrash = async () => {
    if (!evidenceId) return;
    setActionBusy(true);
    try {
      await apiFetch(`/v1/evidence/${evidenceId}/restore`, {
        method: "POST",
        body: JSON.stringify({ restore: true }),
      });
      addToast("Evidence restored from trash", "success");
      await loadWorkspace();
    } catch (runError) {
      addToast(runError instanceof Error ? runError.message : "Restore failed", "error");
      captureException(runError, { feature: "web_evidence_restore_trash", evidenceId });
    } finally {
      setActionBusy(false);
    }
  };

  const assignCase = async () => {
    if (!evidenceId || !selectedCaseId) return;
    setActionBusy(true);
    try {
      await apiFetch(`/v1/cases/${selectedCaseId}/evidence`, {
        method: "POST",
        body: JSON.stringify({ evidenceId }),
      });
      addToast("Evidence added to case", "success");
      setAssignCaseOpen(false);
      await loadWorkspace();
    } catch (runError) {
      addToast(
        runError instanceof Error ? runError.message : "Assignment failed",
        "error",
      );
      captureException(runError, { feature: "web_evidence_assign_case", evidenceId });
    } finally {
      setActionBusy(false);
    }
  };

  const removeCase = async () => {
    if (!evidenceId || !workspace?.relationships.caseId) return;
    setActionBusy(true);
    try {
      await apiFetch(`/v1/cases/${workspace.relationships.caseId}/evidence/${evidenceId}`, {
        method: "DELETE",
      });
      addToast("Evidence removed from case", "success");
      await loadWorkspace();
    } catch (runError) {
      addToast(runError instanceof Error ? runError.message : "Remove failed", "error");
      captureException(runError, { feature: "web_evidence_remove_case", evidenceId });
    } finally {
      setActionBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="evidence-detail-page">
        <div className="evidence-detail-shell">
          <div className="evidence-detail-loading">Loading evidence review workspace…</div>
        </div>
      </div>
    );
  }

  if (error || !workspace || !evidence || !workspaceCaps) {
    return (
      <div className="evidence-detail-page">
        <div className="evidence-detail-shell">
          <section className="evidence-detail-section evidence-detail-error-card">
            <p className="evidence-detail-kicker">Evidence record</p>
            <h1>Unable to load the record</h1>
            <p>{error || "This evidence record is unavailable right now."}</p>
            <div className="evidence-detail-inline-actions">
              <Button onClick={() => void loadWorkspace()}>Retry</Button>
            </div>
          </section>
        </div>
      </div>
    );
  }

  const preservation = workspace.preservationMatrix;
  const trustDecision = workspace.artifactVersions.trustDecision;
  const shareUrl = buildPublishedVerificationUrl(workspace.publicVerificationSummary);
  const isIntegrityFailed = evidence.status === "FAILED_HASH_MISMATCH";
  const showManualLatestStatusCheck =
    workspace.artifactStatus.report.available &&
    workspace.artifactStatus.verificationPackage.available &&
    !isOtsTerminal(workspace.preservationMatrix.ots.effectiveStatus);

  const canSeeDiscussion =
    workspaceCaps?.discussionEnabled === true ||
    workspaceCaps?.discussionReadOnly === true;
  const visibleTabs = DETAIL_TABS.filter(
    (t) => !(t.id === "discussion" && !canSeeDiscussion),
  );

  // Single context bag passed into every tab. Adding a new field
  // here costs one assignment + one type entry in `_lib.tsx`.
  const ctx: EvidenceDetailCtx = {
    workspace,
    evidence,
    workspaceCaps,
    preservation,
    trustDecision,
    evidenceId,
    publicVerificationState,
    otsStatusPresentation,
    technicalReadinessSummary,
    reviewSignals,
    reviewReadinessItems,
    overviewMetadataItems,
    shareUrl,
    isIntegrityFailed,
    showManualLatestStatusCheck,
    initialThreadId,
    canSeeReviewerOps,
    canSeeGovernance,
    canSeeIntelligence,
    canSeeIntakeLinks,
    intelligence,
    intelligenceLoaded,
    workflowEvents,
    workflowEventsLoading,
    actionBusy,
    stalePending,
    setStalePending,
    setPollStartedAt,
    loadWorkspace,
    loadWorkflowEvents,
    openOriginal,
    downloadOriginal,
    downloadReport,
    downloadVerificationPackage,
    runRecordAction,
    restoreTrash,
    removeCase,
    handleRemoveRelationship,
    setSelectedCaseId,
    setAssignCaseOpen,
    setArchiveOpen,
    setTrashOpen,
    setWorkflowOpen,
    setRelationshipOpen,
    routerPush: (href: string) => router.push(href),
  };

  return (
    <div className="evidence-detail-page">
      <div className="evidence-detail-shell">
        {workspace.reviewWorkflow?.teamId ? (
          <RuntimeStatusBanner
            teamId={workspace.reviewWorkflow.teamId}
            forDomains={["core_evidence"]}
          />
        ) : null}
        {workspace.reviewWorkflow?.teamId ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
              marginBottom: 8,
            }}
          >
            <PresenceIndicator
              teamId={workspace.reviewWorkflow.teamId}
              resourceKind="evidence"
              resourceId={evidenceId}
            />
          </div>
        ) : null}
        <CollisionWarning
          entityLabel="Evidence record"
          initialUpdatedAtUtc={initialUpdatedAtUtc}
          currentUpdatedAtUtc={workspace.reviewWorkflow.updatedAt ?? null}
          onReload={() => void loadWorkspace()}
        />
        {isIntegrityFailed ? (
          <aside
            className="evidence-detail-integrity-banner"
            role="alert"
            aria-live="polite"
            style={{
              border: "1px solid rgba(176, 50, 50, 0.55)",
              background: "rgba(176, 50, 50, 0.06)",
              color: "#5a1414",
              borderRadius: 12,
              padding: "16px 18px",
              marginBottom: 16,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <strong style={{ fontSize: 14, letterSpacing: 0.02 }}>
              Integrity check failed
            </strong>
            <span style={{ fontSize: 13, lineHeight: 1.5 }}>
              The uploaded file&rsquo;s SHA-256 does not match the recomputed
              server-side fingerprint. This evidence record cannot be used. Re-upload or
              recapture the source material as a new evidence record. The original
              record is preserved for forensic inspection.
            </span>
          </aside>
        ) : null}

        {/* LAYER 1 — Hero. Title, status pills, legal boundary, and
            the five canonical actions (Download Report PDF / Download
            Verification Package ZIP / Copy verification link / Lock /
            Edit label). The legal boundary statement is rendered
            verbatim from the backend; copy is not altered here. */}
        <section className="evidence-detail-hero">
          <div className="evidence-detail-hero-main">
            <button
              type="button"
              className="evidence-detail-back-link"
              onClick={() => router.push("/evidence")}
            >
              <ArrowLeft size={14} strokeWidth={2.2} />
              <span>Evidence Library</span>
            </button>

            <p className="evidence-detail-kicker">Evidence record</p>

            {editingLabel ? (
              <div className="evidence-detail-label-edit">
                <input
                  value={labelDraft}
                  onChange={(event) => setLabelDraft(event.target.value)}
                />
                <Button
                  onClick={() => void handleSaveLabel()}
                  disabled={actionBusy || !labelDraft.trim()}
                >
                  Save label
                </Button>
                <Button variant="secondary" onClick={() => setEditingLabel(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <h1>{evidence.displayTitle || evidence.title}</h1>
            )}

            <p className="evidence-detail-subtitle">
              {evidence.displayDescription ||
                "Reviewer workspace for preserved evidence content, verification, custody chronology, export readiness, and review context."}
            </p>

            <div className="evidence-detail-hero-meta">
              <span className={`evidence-detail-pill ${pillTone(evidence.status)}`}>
                {evidence.status.replace(/_/g, " ")}
              </span>
              <span className="evidence-detail-pill neutral">
                {workspace.classification.evidenceTypeLabel}
              </span>
              <span className="evidence-detail-pill neutral">
                Record {shortId(evidence.id)}
              </span>
              <span className="evidence-detail-pill neutral">
                {workspace.relationships.multipart
                  ? `${workspace.relationships.itemCount} items`
                  : "Single item"}
              </span>
            </div>

            <div className="evidence-detail-boundary">{workspace.legalBoundary}</div>
          </div>

          {workspace.reviewWorkflow?.teamId ? (
            <div
              style={{
                display: "flex",
                gap: 16,
                flexWrap: "wrap",
                marginBottom: 12,
              }}
            >
              <ExportPackageEligibilityBadge
                evidenceId={evidenceId}
                teamId={workspace.reviewWorkflow.teamId}
                kind="export"
                onEligibilityChange={(s) =>
                  setExportDisabled(!s.loading && !s.unknown && !s.eligible)
                }
              />
              <ExportPackageEligibilityBadge
                evidenceId={evidenceId}
                teamId={workspace.reviewWorkflow.teamId}
                kind="package"
                onEligibilityChange={(s) =>
                  setPackageDisabled(!s.loading && !s.unknown && !s.eligible)
                }
              />
            </div>
          ) : null}
          <div className="evidence-detail-hero-actions">
            <Button
              onClick={() => void downloadReport()}
              disabled={exportDisabled || isIntegrityFailed}
            >
              Download Report PDF
            </Button>
            <Button
              onClick={() => void downloadVerificationPackage()}
              disabled={packageDisabled || isIntegrityFailed}
            >
              Download Verification Package ZIP
            </Button>
            <Button
              variant="secondary"
              onClick={() => void copyShareLink()}
              disabled={isIntegrityFailed || !shareUrl}
            >
              Copy verification link
            </Button>
            <Button
              variant="secondary"
              onClick={() => setLockOpen(true)}
              disabled={
                Boolean(evidence.lockedAt) ||
                evidence.deletedAt != null ||
                isIntegrityFailed
              }
            >
              {evidence.lockedAt ? "Record locked" : "Lock record"}
            </Button>
            <Button variant="secondary" onClick={() => setEditingLabel(true)}>
              Edit label
            </Button>
          </div>
        </section>

        {/* Phase 3 — "What needs attention" strip directly below the
            hero. Users must immediately see "is there a problem?"
            before any tab body renders. Shows top 3 risk signals,
            unassigned case, missing reviewer, missing report, missing
            package. Compact: hidden when there is nothing to act on. */}
        <WhatNeedsAttentionStrip
          ctx={ctx}
          onAssignCase={() => {
            setSelectedCaseId(workspace.relationships.caseId || "");
            setAssignCaseOpen(true);
          }}
          onAssignReviewer={() => setWorkflowOpen(true)}
          onGoToArtifacts={() => setActiveTab("artifacts")}
          onGoToReview={() => setActiveTab("review")}
        />

        <nav
          className="evidence-detail-tabs"
          aria-label="Evidence detail sections"
          data-evidence-tabs-visible-count={visibleTabs.length}
        >
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`evidence-detail-tab ${activeTab === tab.id ? "is-active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              aria-pressed={activeTab === tab.id}
              data-evidence-tab={tab.id}
            >
              <tab.icon size={15} strokeWidth={2.1} aria-hidden="true" />
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="evidence-detail-layout">
          <main className="evidence-detail-main">
            {activeTab === "overview" ? <EvidenceOverviewTab ctx={ctx} /> : null}
            {activeTab === "integrity" ? <EvidenceIntegrityTab ctx={ctx} /> : null}
            {activeTab === "custody" ? <EvidenceCustodyTab ctx={ctx} /> : null}
            {activeTab === "review" ? <EvidenceReviewTab ctx={ctx} /> : null}
            {activeTab === "artifacts" ? <EvidenceArtifactsTab ctx={ctx} /> : null}
            {activeTab === "discussion" ? <EvidenceDiscussionTab ctx={ctx} /> : null}
            {activeTab === "technical" ? (
              <EvidenceTechnicalAppendixTab ctx={ctx} />
            ) : null}
          </main>

          <aside
            className="evidence-detail-sidebar"
            data-evidence-sidebar="status-and-next-action"
          >
            <section
              className="evidence-detail-side-block"
              data-evidence-side="risk-signals"
            >
              <SectionHeading
                kicker="Risk Signals"
                title="Reviewer attention"
                icon={TriangleAlert}
              />
              {reviewSignals.length === 0 ? (
                <p className="evidence-detail-muted">
                  No advisory risk signals in the current response.
                </p>
              ) : (
                <div className="evidence-detail-signal-list">
                  {reviewSignals.slice(0, 4).map((signal) => (
                    <article
                      key={`${signal.title}-${signal.detail}`}
                      className={`evidence-detail-signal-card ${signal.severity}`}
                    >
                      <strong>{signal.title}</strong>
                      <p>{signal.detail}</p>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section
              className="evidence-detail-side-block"
              data-evidence-side="operational-summary"
            >
              <SectionHeading
                kicker="Review Workflow"
                title="Operational summary"
                icon={ShieldCheck}
              />
              <div className="evidence-detail-data-grid">
                <div className="evidence-detail-data-cell">
                  <span>Review workflow</span>
                  <strong>
                    {workspace.reviewWorkflow.status
                      ? workspace.reviewWorkflow.status.replace(/_/g, " ")
                      : "Not started"}
                  </strong>
                </div>
                <div className="evidence-detail-data-cell">
                  <span>Priority</span>
                  <strong>{workspace.reviewWorkflow.priority || "Not configured"}</strong>
                </div>
                <div className="evidence-detail-data-cell">
                  <span>Case</span>
                  <strong>{workspace.relationships.caseName || "Unassigned"}</strong>
                </div>
                <div className="evidence-detail-data-cell">
                  <span>Due date</span>
                  <strong>
                    {formatValue(formatUserDateTime(workspace.reviewWorkflow.dueAt))}
                  </strong>
                </div>
              </div>
            </section>

            {/* Phase CAPTURE-CLOSURE Part C — compact public-verification
                shortcut. Sidebar only carries the publication-state chip
                + a shortcut link (no full KeyValueGrid duplication); the
                detail counts live in the Artifacts tab. */}
            <section
              className="evidence-detail-side-block"
              data-evidence-side="public-verification-shortcut"
            >
              <SectionHeading
                kicker="Public Verification"
                title={publicVerificationState?.label ?? "State unavailable"}
                icon={Globe}
              />
              {shareUrl ? (
                <a
                  href={shareUrl}
                  className="evidence-detail-inline-link"
                  target="_blank"
                  rel="noreferrer"
                  data-evidence-side-publish-link
                >
                  Open verification surface →
                </a>
              ) : (
                <p className="evidence-detail-muted" style={{ fontSize: 12.5 }}>
                  {publicVerificationState?.detail ?? "No publication detail available."}
                </p>
              )}
            </section>
          </aside>
        </div>
      </div>

      <Modal
        isOpen={assignCaseOpen}
        onClose={() => setAssignCaseOpen(false)}
        title="Assign evidence to case"
        actions={
          <>
            <Button variant="secondary" onClick={() => setAssignCaseOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void assignCase()}
              disabled={actionBusy || !selectedCaseId}
            >
              Save assignment
            </Button>
          </>
        }
      >
        <select
          className="evidence-detail-select"
          value={selectedCaseId}
          onChange={(event) => setSelectedCaseId(event.target.value)}
        >
          <option value="">Select case</option>
          {cases.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </Modal>

      <Modal
        isOpen={workflowOpen}
        onClose={() => setWorkflowOpen(false)}
        title="Update reviewer workflow"
        actions={
          <>
            <Button variant="secondary" onClick={() => setWorkflowOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void saveWorkflow()} disabled={actionBusy}>
              Save workflow
            </Button>
          </>
        }
      >
        <div className="evidence-detail-modal-stack">
          <label className="evidence-detail-field">
            <span>Status</span>
            <select
              className="evidence-detail-select"
              value={workflowStatusDraft}
              onChange={(event) => setWorkflowStatusDraft(event.target.value)}
            >
              {[
                "NOT_STARTED",
                "IN_REVIEW",
                "NEEDS_INFO",
                "READY_FOR_EXTERNAL_REVIEW",
                "APPROVED_INTERNAL",
                "ESCALATED",
                "CLOSED",
              ].map((value) => (
                <option key={value} value={value}>
                  {value.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>

          <label className="evidence-detail-field">
            <span>Priority</span>
            <select
              className="evidence-detail-select"
              value={workflowPriorityDraft}
              onChange={(event) => setWorkflowPriorityDraft(event.target.value)}
            >
              {["LOW", "NORMAL", "HIGH", "URGENT"].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label className="evidence-detail-field">
            <span>Assigned reviewer</span>
            <select
              className="evidence-detail-select"
              value={workflowAssigneeDraft}
              onChange={(event) => setWorkflowAssigneeDraft(event.target.value)}
            >
              <option value="">Unassigned</option>
              {workspace.reviewWorkflow.assignedTo ? (
                <option value={workspace.reviewWorkflow.assignedTo.id}>
                  {workspace.reviewWorkflow.assignedTo.displayName ||
                    workspace.reviewWorkflow.assignedTo.email ||
                    workspace.reviewWorkflow.assignedTo.id}
                </option>
              ) : null}
            </select>
            <p className="evidence-detail-muted">
              Reviewer assignment uses currently accessible reviewer identities from the
              loaded workflow state.
            </p>
          </label>

          <label className="evidence-detail-field">
            <span>Due date</span>
            <input
              className="evidence-detail-input"
              type="datetime-local"
              value={workflowDueAtDraft}
              onChange={(event) => setWorkflowDueAtDraft(event.target.value)}
            />
          </label>

          <label className="evidence-detail-field">
            <span>Workflow note</span>
            <textarea
              className="evidence-detail-textarea"
              value={workflowNoteDraft}
              onChange={(event) => setWorkflowNoteDraft(event.target.value)}
            />
          </label>
        </div>
      </Modal>

      <Modal
        isOpen={relationshipOpen}
        onClose={() => setRelationshipOpen(false)}
        title="Record evidence relationship"
        actions={
          <>
            <Button variant="secondary" onClick={() => setRelationshipOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void saveRelationship()}
              disabled={actionBusy || !relationshipTargetId}
            >
              Save relationship
            </Button>
          </>
        }
      >
        <div className="evidence-detail-modal-stack">
          <p className="evidence-detail-muted">
            Enter the linked evidence record ID. The target must be an accessible
            evidence record.
          </p>
          <input
            className="evidence-detail-input"
            value={relationshipTargetId}
            onChange={(event) => setRelationshipTargetId(event.target.value)}
            placeholder="Linked evidence UUID"
          />
          <label className="evidence-detail-field">
            <span>Relationship type</span>
            <select
              className="evidence-detail-select"
              value={relationshipType}
              onChange={(event) => setRelationshipType(event.target.value)}
            >
              {[
                "RELATED",
                "SUPPORTS",
                "DUPLICATE_OF",
                "DERIVED_FROM",
                "SAME_INCIDENT",
                "CONTRADICTS",
                "REPLACES",
                "REFERENCES",
              ].map((value) => (
                <option key={value} value={value}>
                  {value.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
          <label className="evidence-detail-field">
            <span>Note</span>
            <textarea
              className="evidence-detail-textarea"
              value={relationshipNote}
              onChange={(event) => setRelationshipNote(event.target.value)}
            />
          </label>
        </div>
      </Modal>

      <Modal
        isOpen={lockOpen}
        onClose={() => setLockOpen(false)}
        title="Lock evidence record"
        actions={
          <>
            <Button variant="secondary" onClick={() => setLockOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                void runRecordAction(`/v1/evidence/${evidenceId}/lock`, "Evidence locked")
              }
              disabled={actionBusy}
            >
              Confirm lock
            </Button>
          </>
        }
      >
        <p>
          Locking preserves the current record state and prevents further mutable
          updates to the evidence record.
        </p>
      </Modal>

      <Modal
        isOpen={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        title="Archive evidence"
        actions={
          <>
            <Button variant="secondary" onClick={() => setArchiveOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                void runRecordAction(
                  `/v1/evidence/${evidenceId}/archive`,
                  "Evidence archived",
                )
              }
              disabled={actionBusy}
            >
              Archive
            </Button>
          </>
        }
      >
        <p>
          Archiving changes operational visibility. It does not change recorded
          integrity materials.
        </p>
      </Modal>

      <Modal
        isOpen={trashOpen}
        onClose={() => setTrashOpen(false)}
        title="Move evidence to trash"
        actions={
          <>
            <Button variant="secondary" onClick={() => setTrashOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void moveToTrash()} disabled={actionBusy}>
              Move to trash
            </Button>
          </>
        }
      >
        <p>
          Trash state is operational retention handling and must not be confused with
          technical integrity failure.
        </p>
      </Modal>
    </div>
  );
}

/**
 * Phase 3 — "What needs attention" strip.
 *
 * Compact, action-oriented summary directly below the hero. Surfaces:
 *   - top 3 risk signals (read from the existing buildRiskSignals);
 *   - missing case assignment;
 *   - missing reviewer (workflow status NOT_STARTED or absent);
 *   - missing report (REPORTED status but artifact not available);
 *   - missing verification package (same gate).
 *
 * Renders nothing when there is nothing to act on — avoids visual
 * noise on clean records. Existing buttons / tabs are reachable
 * elsewhere; this strip is the high-altitude "have I done X yet?"
 * surface that users requested.
 */
function WhatNeedsAttentionStrip({
  ctx,
  onAssignCase,
  onAssignReviewer,
  onGoToArtifacts,
  onGoToReview,
}: {
  ctx: EvidenceDetailCtx;
  onAssignCase: () => void;
  onAssignReviewer: () => void;
  onGoToArtifacts: () => void;
  onGoToReview: () => void;
}) {
  const { workspace, workspaceCaps, reviewSignals } = ctx;

  const needsCase = !workspace.relationships.caseId && !workspace.relationships.caseName;
  const needsReviewer =
    !workspace.reviewWorkflow?.status ||
    workspace.reviewWorkflow.status === "NOT_STARTED";
  const missingReport =
    workspaceCaps?.reportsIncluded !== false &&
    !workspace.artifactStatus.report.available;
  const missingPackage =
    workspaceCaps?.verificationPackageIncluded !== false &&
    !workspace.artifactStatus.verificationPackage.available &&
    !workspace.artifactStatus.verificationPackage.blocked &&
    !workspace.artifactStatus.verificationPackage.unavailable;

  const topRisks = reviewSignals.slice(0, 3);

  const hasAnything =
    needsCase ||
    needsReviewer ||
    missingReport ||
    missingPackage ||
    topRisks.length > 0;
  if (!hasAnything) return null;

  return (
    <section
      className="evidence-detail-section"
      data-evidence-attention-strip
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "12px 14px",
        borderLeft: "4px solid #d97706",
        background: "#fffbeb",
        borderRadius: 8,
        marginBottom: 12,
      }}
    >
      <strong style={{ fontSize: 13, color: "#7c2d12", letterSpacing: 0.02 }}>
        What needs attention
      </strong>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {topRisks.map((s) => (
          <span
            key={`${s.title}-${s.detail}`}
            className={`evidence-detail-pill ${
              s.severity === "warning" ? "warning" : s.severity === "info" ? "neutral" : "danger"
            }`}
            data-evidence-attention-risk
            title={s.detail}
          >
            {s.title}
          </span>
        ))}
        {needsCase ? (
          <button
            type="button"
            data-evidence-attention-action="assign-case"
            onClick={onAssignCase}
            style={pillButtonStyle}
          >
            No case assigned · Assign
          </button>
        ) : null}
        {needsReviewer ? (
          <button
            type="button"
            data-evidence-attention-action="assign-reviewer"
            onClick={onAssignReviewer}
            style={pillButtonStyle}
          >
            Review not started · Start
          </button>
        ) : null}
        {missingReport ? (
          <button
            type="button"
            data-evidence-attention-action="missing-report"
            onClick={onGoToArtifacts}
            style={pillButtonStyle}
          >
            Report not available · Artifacts
          </button>
        ) : null}
        {missingPackage ? (
          <button
            type="button"
            data-evidence-attention-action="missing-package"
            onClick={onGoToArtifacts}
            style={pillButtonStyle}
          >
            Verification package not available · Artifacts
          </button>
        ) : null}
      </div>
      {topRisks.length === 0 && !needsCase && !needsReviewer ? (
        <button
          type="button"
          data-evidence-attention-action="open-review"
          onClick={onGoToReview}
          style={{
            ...pillButtonStyle,
            alignSelf: "flex-start",
          }}
        >
          Open review workspace
        </button>
      ) : null}
    </section>
  );
}

const pillButtonStyle: React.CSSProperties = {
  border: "1px solid #d97706",
  background: "white",
  color: "#7c2d12",
  padding: "4px 10px",
  borderRadius: 999,
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
};
