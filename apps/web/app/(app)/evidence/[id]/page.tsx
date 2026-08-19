"use client";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";

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

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ClipboardCheck,
  FileText,
  History,
  LayoutGrid,
  MessageSquare,
  Package,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { useToast } from "../../../../components/ui";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import {
  useEnterpriseSurfaceAccess,
  usePlanFeatureGate,
} from "../../../../lib/platform-context";
import { apiFetch } from "../../../../lib/api";
import { captureException } from "../../../../lib/sentry";
import { formatUserDateTime } from "../../../../lib/date";
import type { CaseOption } from "../lib/evidence-library-types";
// PHASE 12 POINT 4 PASS C1 — routing statuses vs server-derived verdicts.
import { isRoutingReviewerStatus } from "../lib/reviewer-status";
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
  shortId,
  shouldPollArtifactReadiness,
  tryDownloadFile,
  type EvidenceDetailCtx,
  type EvidenceDetailTab,
  EvidenceHeroIconActions,
} from "./_tabs/_lib";
import { getRecordStatusBadgeTone } from "../lib/evidence-library-status";
import { useArtifactReadinessPoll } from "./_hooks/useArtifactReadinessPoll";
import { EvidenceOverviewTab } from "./_tabs/EvidenceOverviewTab";
import { EvidenceIntegrityTab } from "./_tabs/EvidenceIntegrityTab";
import { EvidenceCustodyTab } from "./_tabs/EvidenceCustodyTab";
import { EvidenceRecordRail } from "./_tabs/EvidenceRecordRail";
import { Modal as PortalModal } from "../../../../components/cases-experience/matter-modals/Modal";
import { AppListbox } from "../../../../components/app-primitives";
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

  // Track 1A (surface-tier removal) — reviewer-ops / governance /
  // intelligence / investigation affordances belong to the Enterprise
  // workspace experience; the gate is the SERVER-projected
  // `flags.isEnterpriseWorkspace` / `platform.isPlatformAdmin` booleans.
  const enterpriseSurfaces = useEnterpriseSurfaceAccess();
  const canSeeReviewerOps = enterpriseSurfaces;
  const canSeeGovernance = enterpriseSurfaces;
  const canSeeIntelligence = enterpriseSurfaces;
  // Intake links are a COMMERCIAL entitlement — the SERVER-projected
  // `planFeatures.intakeIncluded` boolean decides (platform admins pass).
  const canSeeIntakeLinks = usePlanFeatureGate("intakeIncluded");
  // Phase EVIDENCE-RELATIONSHIPS-GATE — Manage Relationships is an
  // evidence-graph workflow useful for enterprise / legal / investigation
  // setups, but noisy for Personal / small-team workspaces. When the user
  // isn't in the enterprise experience AND has no existing relationships
  // on this record, the Manage button + per-row Remove buttons are
  // hidden; the read-only Linked-evidence list still shows if items
  // already exist.
  const canSeeInvestigation = enterpriseSurfaces;

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
  // Phase EVIDENCE-LIFECYCLE-UNLOCK — controlled unlock UI. Reason is
  // optional but encouraged; passes through to the audit log entry.
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockReasonDraft, setUnlockReasonDraft] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  // Phase EVIDENCE-LIFECYCLE-RESTORE-ARCHIVED — modal for the restore
  // counterpart so success follows the same close-and-refresh flow as
  // every other lifecycle action (previously fired immediately on click).
  const [restoreArchivedOpen, setRestoreArchivedOpen] = useState(false);
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
  // The governance reason behind a disabled download. Kept beside the boolean
  // so the control can say WHY rather than only appearing faded.
  const [exportBlockedReason, setExportBlockedReason] = useState<string | null>(null);
  const [packageBlockedReason, setPackageBlockedReason] = useState<string | null>(null);
  const [initialUpdatedAtUtc, setInitialUpdatedAtUtc] = useState<string | null>(null);
  const [intelligence, setIntelligence] = useState<IntelligenceEvidenceResponse | null>(null);
  const [intelligenceLoaded, setIntelligenceLoaded] = useState(false);
  const [pollStartedAt, setPollStartedAt] = useState<number | null>(null);
  const [stalePending, setStalePending] = useState(false);


  const loadWorkflowEvents = useCallback(async () => {
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
  }, [evidenceId, addToast]);

  /**
   * Phase EVIDENCE-STALE-BANNER-FIX — load (or reload) the review
   * workspace. The optional `bumpBaseline` parameter is the load-
   * bearing knob that distinguishes:
   *
   *   bumpBaseline: false (default, on first mount + background
   *     polling) — `initialUpdatedAtUtc` is set only once and never
   *     moves. This is what powers the "another operator changed
   *     this record" warning — subsequent loads that surface a
   *     newer `reviewWorkflow.updatedAt` trigger CollisionWarning.
   *
   *   bumpBaseline: true (passed by saveWorkflow on success, by the
   *     CollisionWarning Reload click, and by any other action the
   *     CURRENT user initiated that they expect to advance the
   *     baseline) — `initialUpdatedAtUtc` is replaced with the new
   *     post-fetch value so the warning clears. This is what fixes
   *     the false positive where a user's own self-initiated
   *     workflow save was being interpreted as a foreign update.
   *
   * Backend conflict protection is unchanged — PATCH routes still
   * reject stale writes server-side (409). This pass only fixes
   * the client-side baseline so the warning surface stops shouting
   * at users about their own writes.
   */
  const loadWorkspace = useCallback(async (opts?: { bumpBaseline?: boolean }) => {
    if (!evidenceId) return;
    setLoading(true);
    setError(null);
    try {
      // Phase ASSIGN-CASE-ELIGIBILITY — request the eligibility-narrowed
      // case list for this specific evidence. The server-side filter
      // returns only cases in the same workspace as the evidence,
      // excluding archived/deleted cases and inactive-member teams,
      // so the dropdown can no longer offer a case the attach gate
      // would reject. The attach backend gate is unchanged and still
      // authoritative if a client bypasses the UI.
      const [workspaceResult, casesResult] = await Promise.allSettled([
        apiFetch(`/v1/evidence/${evidenceId}/review-workspace`),
        apiFetch(
          `/v1/cases?eligibleForEvidenceId=${encodeURIComponent(evidenceId)}`,
        ),
      ]);
      if (workspaceResult.status !== "fulfilled") throw workspaceResult.reason;
      const workspaceData = workspaceResult.value as ReviewWorkspaceResponse;
      setWorkspace(workspaceData);
      const newUpdatedAt = workspaceData.reviewWorkflow.updatedAt ?? null;
      if (opts?.bumpBaseline) {
        setInitialUpdatedAtUtc(newUpdatedAt);
      } else {
        setInitialUpdatedAtUtc((prev) => prev ?? newUpdatedAt);
      }
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
        toSafeUserError(loadError, { message: "Failed to load evidence review workspace" }).message;
      setError(message);
      captureException(loadError, {
        feature: "web_evidence_review_workspace_load",
        evidenceId,
      });
    } finally {
      setLoading(false);
    }
  }, [evidenceId]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    if (!evidenceId) return;
    void loadWorkflowEvents();
  }, [evidenceId, loadWorkflowEvents]);

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

  // Phase 32.5 — Artifact-readiness polling. Extracted to its own hook in
  // Phase 12 Point 4: the orchestrator holds orchestration, not mechanisms.
  useArtifactReadinessPoll({
    evidenceId,
    shouldPoll: shouldPollArtifactReadiness(workspace),
    workspace,
    pollStartedAt,
    setPollStartedAt,
    setStalePending,
    reloadWorkspace: loadWorkspace,
  });

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
          // PHASE 12 POINT 4 PASS C1 — this administrative save carries a
          // status ONLY when it is a routing state. A record already resolved
          // to a verdict keeps that derived status: editing its priority or
          // assignee here must never silently overwrite a recorded decision,
          // and the server refuses verdict statuses on this route anyway.
          ...(isRoutingReviewerStatus(workflowStatusDraft)
            ? { status: workflowStatusDraft }
            : {}),
          priority: workflowPriorityDraft,
          dueAt: workflowDueAtDraft ? new Date(workflowDueAtDraft).toISOString() : null,
          note: workflowNoteDraft || null,
        }),
      });
      addToast("Reviewer workflow updated", "success");
      setWorkflowOpen(false);
      // Phase EVIDENCE-STALE-BANNER-FIX — bump the baseline so the
      // user's own successful save is NOT interpreted by
      // CollisionWarning as "another operator changed this record".
      // External changes between this baseline-bump and the next
      // render still trip the warning because the bump only fires
      // on user-initiated paths.
      await Promise.all([
        loadWorkspace({ bumpBaseline: true }),
        loadWorkflowEvents(),
      ]);
    } catch (saveError) {
      captureException(saveError, {
        feature: "web_evidence_workflow_update",
        evidenceId,
      });
      addToast(
        toSafeUserError(saveError, { message: "Failed to update workflow" }).message,
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
        toSafeUserError(saveError, { message: "Failed to create relationship" }).message,
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
        toSafeUserError(deleteError, { message: "Failed to remove relationship" }).message,
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
        toSafeUserError(updateError, { message: "Failed to update label" }).message,
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
      // Hoisted so BOTH arguments are plain identifiers at the call site.
      // The architecture audit resolves a request primitive by walking its
      // arguments; an inline `||` or property access made the site
      // unanalysable and forced a hand-reviewed exemption.
      const originalFileName = data.originalFileName || `evidence-${evidenceId}`;
      const ok = await tryDownloadFile(url, originalFileName);
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
        // Same reason as downloadOriginal: hoist the signed URL and the file
        // name so the call site is two identifiers.
        const packageUrl = data.url;
        const packageFileName = `verification-package-${evidenceId}.zip`;
        const ok = await tryDownloadFile(packageUrl, packageFileName);
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

  /**
   * Phase EVIDENCE-LIFECYCLE-MODALS — enterprise modal close-on-success.
   *
   * Previously the action handlers fired the request + toast + reload,
   * but the parent modal stayed open and the user had to click Cancel
   * after the success toast appeared. That looks broken. The fix is
   * an optional `onSuccess` callback fired AFTER the mutation +
   * reload complete — call sites pass `() => setXxxOpen(false)` (and
   * any draft-state resets) so the modal closes only on a real
   * success. On failure the modal stays open with the error toast.
   *
   * Optional `body` lets the unlock modal pass a reason payload while
   * archive/lock/etc. continue to POST an empty body. The default
   * `{}` body matches the existing behaviour.
   */
  const runRecordAction = async (
    path: string,
    successMessage: string,
    options?: {
      onSuccess?: () => void;
      body?: Record<string, unknown>;
    },
  ) => {
    if (!evidenceId) return;
    setActionBusy(true);
    try {
      await apiFetch(path, {
        method: "POST",
        body: JSON.stringify(options?.body ?? {}),
      });
      addToast(successMessage, "success");
      await loadWorkspace();
      options?.onSuccess?.();
    } catch (runError) {
      addToast(toSafeUserError(runError, { message: "Action failed" }).message, "error");
      captureException(runError, {
        feature: "web_evidence_record_action",
        evidenceId,
        path,
      });
    } finally {
      setActionBusy(false);
    }
  };

  const moveToTrash = async (options?: { onSuccess?: () => void }) => {
    if (!evidenceId) return;
    setActionBusy(true);
    try {
      await apiFetch(`/v1/evidence/${evidenceId}`, { method: "DELETE" });
      addToast("Evidence moved to trash", "success");
      await loadWorkspace();
      options?.onSuccess?.();
    } catch (runError) {
      addToast(toSafeUserError(runError, { message: "Delete failed" }).message, "error");
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
      addToast(toSafeUserError(runError, { message: "Restore failed" }).message, "error");
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
        toSafeUserError(runError, { message: "Assignment failed" }).message,
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
      addToast(toSafeUserError(runError, { message: "Remove failed" }).message, "error");
      captureException(runError, { feature: "web_evidence_remove_case", evidenceId });
    } finally {
      setActionBusy(false);
    }
  };

  /**
   * PHASE 13 (NEW-078) — THE FULL-PAGE LOADING STATE IS FOR THE FIRST LOAD ONLY.
   *
   * `loadWorkspace()` sets `loading` unconditionally, and this branch replaced the
   * WHOLE page while it ran. `loadWorkspace` is also the `onChanged` callback
   * every mutating panel on this page calls after a SUCCESSFUL write — so each
   * success unmounted the panel that had just been given something to say.
   *
   * `PublicVerifyPublicationPanel` is the case that exposed it: it announces
   * "This record is now published to public verification." from its own
   * `role="status"` / `aria-live="polite"` region and then calls `onChanged()`.
   * The region came back mounted and EMPTY, so a screen-reader user published
   * evidence to a PUBLIC surface — or withdrew it — and was told nothing. It also
   * discarded the panel's transient state (the reason field, step-up progress)
   * and flashed a full-page spinner over a page the user was reading.
   *
   * Gating on "no workspace yet" keeps the first load exactly as it was and makes
   * a revalidation of already-rendered data non-destructive. Same defect and same
   * remedy as NEW-064 (the organization pages' `fetchAll`) and NEW-070
   * (`SurfaceGate` holding through a same-workspace refresh).
   */
  if (loading && !workspace) {
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
              <button
                type="button"
                className="app-primary-action"
                onClick={() => void loadWorkspace()}
              >
                Retry
              </button>
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
  const deleted = evidence?.deletedAt != null;
  const iconActionTitle = {
    share: !shareUrl
      ? "No verification link is available for this record."
      : isIntegrityFailed
        ? "Verification link is unavailable while integrity is failed."
        : "Copy verification link",
    lock: deleted
      ? "A deleted record cannot be locked."
      : isIntegrityFailed
        ? "Locking is unavailable while integrity is failed."
        : "Lock record",
    unlock: deleted ? "A deleted record cannot be unlocked." : "Unlock record",
    archive: deleted ? "A deleted record cannot be archived." : "Archive evidence",
    restore: deleted
      ? "A deleted record cannot be restored from archive."
      : "Restore archived evidence",
  };

  /**
   * Why a download is refused, from the authorities that already know.
   *
   * Integrity first — a failed record may not export at all, whatever the
   * governance slice says. Then the governance reason the eligibility badge
   * returns, then the artifact projection's own reason (a plan that does not
   * include the artifact). `null` means the control is enabled.
   */
  const reportDownloadBlockedReason = isIntegrityFailed
    ? "Downloads are unavailable while recorded integrity is failed."
    : exportDisabled
      ? (exportBlockedReason ?? "Governance policy currently blocks this download.")
      : !workspace.artifactStatus.report.available
        ? workspace.artifactStatus.report.pending
          ? "The report is still being generated."
          : "No report has been generated for this record yet."
        : null;

  const packageDownloadBlockedReason = isIntegrityFailed
    ? "Downloads are unavailable while recorded integrity is failed."
    : packageDisabled
      ? (packageBlockedReason ?? "Governance policy currently blocks this download.")
      : !workspace.artifactStatus.verificationPackage.available
        ? (workspace.artifactStatus.verificationPackage.blockedReason ??
          workspace.artifactStatus.verificationPackage.unavailableReason ??
          (workspace.artifactStatus.verificationPackage.pending
            ? "The verification package is still being generated."
            : "No verification package has been generated for this record yet."))
        : null;

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
    canSeeInvestigation,
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
          <div className="evidence-detail-presence-row">
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
          // Phase EVIDENCE-STALE-BANNER-FIX — clicking Reload is an
          // explicit operator consent to advance the baseline to
          // the latest server state. Without the bump, the warning
          // would stick after the user reloaded.
          onReload={() => void loadWorkspace({ bumpBaseline: true })}
        />
        {isIntegrityFailed ? (
          <aside
            className="evidence-detail-record-banner"
            data-banner-tone="danger"
            role="alert"
            aria-live="polite"
          >
            <strong className="evidence-detail-record-banner__title">
              Integrity check failed
            </strong>
            <span className="evidence-detail-record-banner__body">
              The uploaded file&rsquo;s SHA-256 does not match the recomputed
              server-side fingerprint. This evidence record cannot be used. Re-upload or
              recapture the source material as a new evidence record. The original
              record is preserved for forensic inspection.
            </span>
          </aside>
        ) : null}

        {/* Search-page-final-cleanup (B) — trash banner. When the
            evidence is soft-deleted (deletedAt set), surface a
            prominent read-only banner with a Restore action. The
            page already disables mutation buttons in the hero +
            tabs when deletedAt is set (see disabled={...deletedAt}
            guards below), so the banner is the user-facing
            communicator that the record is in trash; the action
            buttons themselves enforce the restriction.
            Permanent-delete is intentionally NOT exposed here —
            that lives behind the lifecycle DESTROYED state machine
            (out of scope; see retention runbook).
            data-evidence-trash-banner is the e2e probe. */}
        {evidence.deletedAt ? (
          <aside
            className="evidence-detail-record-banner evidence-detail-record-banner--split"
            data-banner-tone="warn"
            role="status"
            aria-live="polite"
            data-evidence-trash-banner="true"
          >
            <div className="evidence-detail-record-banner__copy">
              <strong className="evidence-detail-record-banner__title">
                This record is in trash
              </strong>
              <span className="evidence-detail-record-banner__body">
                Mutating actions (download, lock, archive, assign to
                case, generate report/package) are disabled while
                the record is in trash. Restore it to bring it back
                to the active library.
              </span>
            </div>
            <button
              type="button"
              className="app-secondary-action app-secondary-action--filled"
              onClick={() => void restoreTrash()}
              disabled={actionBusy}
              data-evidence-trash-restore="true"
            >
              {actionBusy ? "Restoring…" : "Restore from trash"}
            </button>
          </aside>
        ) : null}

        {/* LAYER 1 — Hero. Title, status pills, legal boundary, and
            the five canonical actions (Download Report PDF / Download
            Verification Package ZIP / Copy verification link / Lock /
            Edit label). The legal boundary statement is rendered
            verbatim from the backend; copy is not altered here. */}
        <section className="evidence-detail-hero">
          <div className="evidence-detail-hero-main">
            {/* Breadcrumb — a real labelled landmark. The Library crumb
                navigates; the record itself is the current page. */}
            <nav className="evidence-detail-breadcrumb" aria-label="Breadcrumb">
              <button
                type="button"
                className="evidence-detail-breadcrumb-link"
                onClick={() => router.push("/evidence")}
              >
                <ArrowLeft size={13} strokeWidth={2.2} aria-hidden="true" />
                Evidence Library
              </button>
              <span aria-hidden className="evidence-detail-breadcrumb-sep">
                /
              </span>
              <span aria-current="page" className="evidence-detail-breadcrumb-current">
                Evidence Record
              </span>
            </nav>

            {editingLabel ? (
              <div className="evidence-detail-label-edit">
                <input
                  className="app-form-input"
                  value={labelDraft}
                  onChange={(event) => setLabelDraft(event.target.value)}
                  aria-label="Evidence label"
                />
                <button
                  type="button"
                  className="app-primary-action"
                  onClick={() => void handleSaveLabel()}
                  disabled={actionBusy || !labelDraft.trim()}
                >
                  Save label
                </button>
                <button
                  type="button"
                  className="app-secondary-action"
                  onClick={() => setEditingLabel(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              // The heading clamps to two lines, so the COMPLETE filename has
              // to remain reachable — on the element itself and to assistive
              // technology, not only in a tooltip.
              <h1
                className="evidence-detail-title"
                title={evidence.displayTitle || evidence.title}
              >
                {evidence.displayTitle || evidence.title}
              </h1>
            )}

            {/* Identity line: status, package type, truncated record id and
                item count, exactly as the record header reads in the
                reference. The record id stays LTR so it is readable in RTL. */}
            <div className="evidence-detail-hero-meta">
              <span
                className="app-status-badge"
                data-tone={getRecordStatusBadgeTone(evidence.status)}
              >
                {evidence.status.replace(/_/g, " ")}
              </span>
              <span className="evidence-detail-meta-item">
                <Package size={14} strokeWidth={1.9} aria-hidden="true" />
                {workspace.classification.evidenceTypeLabel}
              </span>
              <span aria-hidden className="evidence-detail-meta-dot">
                •
              </span>
              <span className="evidence-detail-meta-item evidence-detail-technical" dir="ltr">
                Record {shortId(evidence.id)}
              </span>
              <span aria-hidden className="evidence-detail-meta-dot">
                •
              </span>
              <span className="evidence-detail-meta-item">
                {workspace.relationships.multipart
                  ? `${workspace.relationships.itemCount} items`
                  : "Single item"}
              </span>
            </div>

            <div className="evidence-detail-boundary">{workspace.legalBoundary}</div>
          </div>

          {workspace.reviewWorkflow?.teamId ? (
            <div className="evidence-detail-eligibility-row">
              <ExportPackageEligibilityBadge
                evidenceId={evidenceId}
                teamId={workspace.reviewWorkflow.teamId}
                kind="export"
                onEligibilityChange={(s) => {
                  setExportDisabled(!s.loading && !s.unknown && !s.eligible);
                  setExportBlockedReason(s.eligible ? null : s.reason);
                }}
              />
              <ExportPackageEligibilityBadge
                evidenceId={evidenceId}
                teamId={workspace.reviewWorkflow.teamId}
                kind="package"
                onEligibilityChange={(s) => {
                  setPackageDisabled(!s.loading && !s.unknown && !s.eligible);
                  setPackageBlockedReason(s.eligible ? null : s.reason);
                }}
              />
            </div>
          ) : null}
          {/* CANONICAL ACTION TOOLBAR.
              Two named actions carry the record's primary outputs; every other
              existing action keeps its behaviour and permissions but moves to
              an icon control at the logical end, matching the record header in
              the reference. Nothing new is exposed here — each control maps to
              an action this route already owned. */}
          <div className="evidence-detail-hero-actions">
            <button
              type="button"
              className="app-primary-action"
              onClick={() => void downloadReport()}
              disabled={exportDisabled || isIntegrityFailed}
              title={reportDownloadBlockedReason ?? "Download the generated report PDF"}
              aria-describedby={
                reportDownloadBlockedReason ? "evidence-download-report-reason" : undefined
              }
              data-evidence-action="download-report"
              data-evidence-disabled-reason={reportDownloadBlockedReason ?? undefined}
            >
              <FileText size={16} strokeWidth={1.9} aria-hidden="true" />
              Download Report PDF
            </button>
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => void downloadVerificationPackage()}
              disabled={packageDisabled || isIntegrityFailed}
              title={packageDownloadBlockedReason ?? "Download Verification Package ZIP"}
              aria-describedby={
                packageDownloadBlockedReason ? "evidence-download-report-reason" : undefined
              }
              data-evidence-action="download-package"
              data-evidence-disabled-reason={packageDownloadBlockedReason ?? undefined}
            >
              <ShieldCheck size={16} strokeWidth={1.9} aria-hidden="true" />
              {/* The "ZIP" suffix is a vocabulary CONTRACT (phase A2 / G5.2): it
                  disambiguates the package download from the PDF report. The
                  redesign dropped it; restored. */}
              Download Verification Package ZIP
            </button>

            {/* The reason a download is refused, stated rather than implied by
                a faded control. Rendered once for whichever action is blocked;
                both controls point at it with `aria-describedby`. */}
            {reportDownloadBlockedReason || packageDownloadBlockedReason ? (
              <p
                className="evidence-detail-action-reason"
                id="evidence-download-report-reason"
                data-evidence-download-blocked-reason
              >
                {reportDownloadBlockedReason ?? packageDownloadBlockedReason}
              </p>
            ) : null}

            <EvidenceHeroIconActions
              lockedAt={evidence.lockedAt}
              archivedAt={evidence.archivedAt}
              deleted={deleted}
              shareUrl={shareUrl}
              isIntegrityFailed={isIntegrityFailed}
              titles={iconActionTitle}
              onCopyShareLink={() => void copyShareLink()}
              onUnlock={() => {
                setUnlockReasonDraft("");
                setUnlockOpen(true);
              }}
              onLock={() => setLockOpen(true)}
              onRestoreArchived={() => setRestoreArchivedOpen(true)}
              onArchive={() => setArchiveOpen(true)}
              onEditLabel={() => setEditingLabel(true)}
            />
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

        {/* CANONICAL TABS. One authority (.app-tabs) shared with every other
            internal surface, with real tablist semantics: the previous markup
            used aria-pressed on plain buttons, which announces a toggle group
            rather than a tab set. */}
        <nav
          className="app-tabs evidence-detail-tabs"
          role="tablist"
          aria-label="Evidence detail sections"
          data-evidence-tabs-visible-count={visibleTabs.length}
        >
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`evidence-tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              aria-controls={`evidence-tabpanel-${tab.id}`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              className={`app-tab ${activeTab === tab.id ? "is-active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) => {
                const idx = visibleTabs.findIndex((t) => t.id === activeTab);
                if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                  event.preventDefault();
                  const dir = event.key === "ArrowRight" ? 1 : -1;
                  const next =
                    visibleTabs[(idx + dir + visibleTabs.length) % visibleTabs.length];
                  if (next) {
                    setActiveTab(next.id);
                    document.getElementById(`evidence-tab-${next.id}`)?.focus();
                  }
                } else if (event.key === "Home" || event.key === "End") {
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? visibleTabs[0]
                      : visibleTabs[visibleTabs.length - 1];
                  if (next) {
                    setActiveTab(next.id);
                    document.getElementById(`evidence-tab-${next.id}`)?.focus();
                  }
                }
              }}
              data-evidence-tab={tab.id}
            >
              <tab.icon size={15} strokeWidth={2.1} aria-hidden="true" />
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="evidence-detail-layout">
          <main
            className="evidence-detail-main"
            role="tabpanel"
            id={`evidence-tabpanel-${activeTab}`}
            aria-labelledby={`evidence-tab-${activeTab}`}
            tabIndex={0}
          >
            {activeTab === "overview" ? <EvidenceOverviewTab ctx={ctx} /> : null}
            {activeTab === "integrity" ? <EvidenceIntegrityTab ctx={ctx} /> : null}
            {activeTab === "custody" ? <EvidenceCustodyTab ctx={ctx} /> : null}
            {activeTab === "review" ? <EvidenceReviewTab ctx={ctx} /> : null}
            {activeTab === "artifacts" ? <EvidenceArtifactsTab ctx={ctx} /> : null}
            {activeTab === "discussion" ? <EvidenceDiscussionTab ctx={ctx} /> : null}
            {activeTab === "technical" ? (
              <EvidenceTechnicalAppendixTab
                ctx={ctx}
                onGoToCustody={() => setActiveTab("custody")}
              />
            ) : null}
          </main>

          {/* ONE shared rail for every tab — see _tabs/EvidenceRecordRail. */}
          <EvidenceRecordRail
            workspace={workspace}
            signals={reviewSignals}
            publicVerificationLabel={
              publicVerificationState?.label ?? "State unavailable"
            }
            publicVerificationDetail={
              publicVerificationState?.detail ?? "No publication detail available."
            }
            shareUrl={shareUrl}
          />
        </div>
      </div>

      <PortalModal
        open={assignCaseOpen}
        testid="evidence-assign-case"
        dismissDisabled={actionBusy}
        onClose={() => setAssignCaseOpen(false)}
        title="Assign evidence to case"
        footer={
          <>
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => setAssignCaseOpen(false)}
              disabled={actionBusy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="app-primary-action"
              onClick={() => void assignCase()}
              disabled={actionBusy || !selectedCaseId || cases.length === 0}
              data-evidence-modal-action="confirm-assign-case"
            >
              Save assignment
            </button>
          </>
        }
      >
        {/* Phase ASSIGN-CASE-ELIGIBILITY — the cases array is now the
            eligibility-narrowed list from
            `/v1/cases?eligibleForEvidenceId=...`. When the workspace
            has no attachable cases (no same-team active case, or all
            of them are archived/deleted) the dropdown collapses to a
            single read-only empty-state message and Save is disabled.
            The backend cross-workspace gate stays authoritative. */}
        {cases.length === 0 ? (
          <p
            className="evidence-detail-muted"
            data-evidence-assign-case-empty
          >
            No attachable cases are available in this workspace.
          </p>
        ) : (
          <div data-evidence-assign-case-select>
            <AppListbox
              value={selectedCaseId || null}
              placeholder="Select case"
              ariaLabel="Select case"
              options={cases.map((item) => ({ value: item.id, label: item.name }))}
              onChange={(next) => setSelectedCaseId(next)}
            />
          </div>
        )}
      </PortalModal>

      {/* Phase EVIDENCE-REVIEW-VISIBILITY — the reviewer-workflow
          modal is enterprise/team machinery (assignment, priority,
          due date, structured note). It only renders for users who
          can access the /reviewer-ops surface; on Personal Space the
          modal is unmounted entirely so a stale `workflowOpen=true`
          state can never surface enterprise controls. Self-serve
          users keep the per-record review status + notes/comments
          panels in the Review tab body. */}
      <PortalModal
        open={canSeeReviewerOps && workflowOpen}
        testid="evidence-reviewer-workflow"
        dismissDisabled={actionBusy}
        onClose={() => setWorkflowOpen(false)}
        title="Update reviewer workflow"
        footer={
          <>
            <button type="button" className="app-secondary-action" onClick={() => setWorkflowOpen(false)}>
              Cancel
            </button>
            <button type="button" className="app-primary-action" onClick={() => void saveWorkflow()} disabled={actionBusy}>
              Save workflow
            </button>
          </>
        }
      >
        <div className="evidence-detail-modal-stack">
          <label className="evidence-detail-field">
            <span>Status</span>
            <AppListbox
              value={workflowStatusDraft}
              ariaLabel="Status"
              onChange={(next) => setWorkflowStatusDraft(next)}
              // PHASE 12 POINT 4 PASS C1 — ROUTING states only. A verdict
              // (accept / reject / request more context) is recorded as a
              // DECISION on the review surface; the server derives the
              // resulting status from the immutable decision log, so this
              // administrative control can no longer assign one.
              options={
                [
                  "NOT_STARTED",
                  "IN_REVIEW",
                  "READY_FOR_EXTERNAL_REVIEW",
                  "ESCALATED",
                  "CLOSED",
                ].map((value) => ({ value, label: value.replace(/_/g, " ") }))
              }
            />
          </label>

          <label className="evidence-detail-field">
            <span>Priority</span>
            <AppListbox
              value={workflowPriorityDraft}
              ariaLabel="Priority"
              onChange={(next) => setWorkflowPriorityDraft(next)}
              options={["LOW", "NORMAL", "HIGH", "URGENT"].map((value) => ({
                value,
                label: value,
              }))}
            />
          </label>

          <label className="evidence-detail-field">
            <span>Assigned reviewer</span>
            <AppListbox
              value={workflowAssigneeDraft || null}
              placeholder="Unassigned"
              ariaLabel="Assigned reviewer"
              onChange={(next) => setWorkflowAssigneeDraft(next)}
              options={
                workspace.reviewWorkflow.assignedTo
                  ? [
                      {
                        value: workspace.reviewWorkflow.assignedTo.id,
                        label:
                          workspace.reviewWorkflow.assignedTo.displayName ||
                          workspace.reviewWorkflow.assignedTo.email ||
                          workspace.reviewWorkflow.assignedTo.id,
                      },
                    ]
                  : []
              }
            />
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
      </PortalModal>

      <PortalModal
        open={relationshipOpen}
        testid="evidence-relationship"
        dismissDisabled={actionBusy}
        onClose={() => setRelationshipOpen(false)}
        title="Record evidence relationship"
        footer={
          <>
            <button type="button" className="app-secondary-action" onClick={() => setRelationshipOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="app-primary-action"
              onClick={() => void saveRelationship()}
              disabled={actionBusy || !relationshipTargetId}
            >
              Save relationship
            </button>
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
            <AppListbox
              value={relationshipType}
              ariaLabel="Relationship type"
              onChange={(next) => setRelationshipType(next)}
              options={[
                "RELATED",
                "SUPPORTS",
                "DUPLICATE_OF",
                "DERIVED_FROM",
                "SAME_INCIDENT",
                "CONTRADICTS",
                "REPLACES",
                "REFERENCES",
              ].map((value) => ({ value, label: value.replace(/_/g, " ") }))}
            />
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
      </PortalModal>

      {/* Phase EVIDENCE-LIFECYCLE-MODALS — close-on-success + refresh.
          Each lifecycle modal now closes automatically once the
          mutation completes AND the workspace has reloaded. The
          modal stays open with the error toast on failure. */}
      <PortalModal
        open={lockOpen}
        testid="evidence-lock"
        dismissDisabled={actionBusy}
        onClose={() => setLockOpen(false)}
        title="Lock evidence record"
        footer={
          <>
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => setLockOpen(false)}
              disabled={actionBusy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="app-secondary-action app-secondary-action--filled"
              onClick={() =>
                void runRecordAction(
                  `/v1/evidence/${evidenceId}/lock`,
                  "Evidence record locked.",
                  { onSuccess: () => setLockOpen(false) },
                )
              }
              disabled={actionBusy}
              data-evidence-modal-action="confirm-lock"
            >
              Confirm lock
            </button>
          </>
        }
      >
        <p>
          Locking preserves the current record state and prevents further mutable
          updates to this evidence record.
        </p>
      </PortalModal>

      {/* Phase EVIDENCE-LIFECYCLE-UNLOCK — controlled unlock with audit
          trail. Optional reason is stored verbatim on the audit log
          entry; the backend rejects with 409 EVIDENCE_NOT_LOCKED when
          the record is not actually locked. Object Lock retention,
          legal hold, report immutability, and the custody chain are
          unaffected — unlock only restores mutable workspace updates. */}
      <PortalModal
        open={unlockOpen}
        testid="evidence-unlock"
        dismissDisabled={actionBusy}
        onClose={() => setUnlockOpen(false)}
        title="Unlock evidence record"
        footer={
          <>
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => setUnlockOpen(false)}
              disabled={actionBusy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="app-secondary-action app-secondary-action--filled"
              onClick={() =>
                void runRecordAction(
                  `/v1/evidence/${evidenceId}/unlock`,
                  "Evidence record unlocked.",
                  {
                    body: unlockReasonDraft.trim().length > 0
                      ? { reason: unlockReasonDraft.trim() }
                      : {},
                    onSuccess: () => {
                      setUnlockOpen(false);
                      setUnlockReasonDraft("");
                    },
                  },
                )
              }
              disabled={actionBusy}
              data-evidence-modal-action="confirm-unlock"
            >
              Confirm unlock
            </button>
          </>
        }
      >
        <p>
          Unlocking allows permitted workspace users to make mutable updates
          again. The unlock action is recorded in the audit trail.
        </p>
        <p className="evidence-detail-dialog-note">
          Unlocking does not change retention, legal hold, Object Lock,
          generated reports, verification packages, or the custody chain.
        </p>
        <label className="evidence-detail-dialog-field">
          <span className="evidence-detail-dialog-field__label">
            Reason for unlocking (optional)
          </span>
          <input
            type="text"
            className="app-form-input"
            value={unlockReasonDraft}
            onChange={(event) => setUnlockReasonDraft(event.target.value)}
            maxLength={500}
            placeholder="e.g. correcting label after upload"
            data-evidence-unlock-reason
          />
        </label>
      </PortalModal>

      <PortalModal
        open={archiveOpen}
        testid="evidence-archive"
        dismissDisabled={actionBusy}
        onClose={() => setArchiveOpen(false)}
        title="Archive evidence record"
        footer={
          <>
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => setArchiveOpen(false)}
              disabled={actionBusy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="app-primary-action"
              onClick={() =>
                void runRecordAction(
                  `/v1/evidence/${evidenceId}/archive`,
                  "Evidence record archived.",
                  { onSuccess: () => setArchiveOpen(false) },
                )
              }
              disabled={actionBusy}
              data-evidence-modal-action="confirm-archive"
            >
              Archive evidence
            </button>
          </>
        }
      >
        <p>
          Archive removes this record from Active evidence while preserving it
          under retention and keeping verification materials available.
        </p>
      </PortalModal>

      {/* Phase EVIDENCE-LIFECYCLE-RESTORE-ARCHIVED — confirmation modal
          for restore so it follows the same close-and-refresh pattern
          as every other lifecycle action. Backend route unchanged. */}
      <PortalModal
        open={restoreArchivedOpen}
        testid="evidence-restore-archived"
        dismissDisabled={actionBusy}
        onClose={() => setRestoreArchivedOpen(false)}
        title="Restore archived evidence"
        footer={
          <>
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => setRestoreArchivedOpen(false)}
              disabled={actionBusy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="app-secondary-action app-secondary-action--filled"
              onClick={() =>
                void runRecordAction(
                  `/v1/evidence/${evidenceId}/unarchive`,
                  "Evidence record restored to Active.",
                  { onSuccess: () => setRestoreArchivedOpen(false) },
                )
              }
              disabled={actionBusy}
              data-evidence-modal-action="confirm-restore-archived"
            >
              Restore evidence
            </button>
          </>
        }
      >
        <p>
          Restoring returns this record to Active evidence. Retention and
          verification history remain unchanged.
        </p>
      </PortalModal>

      <PortalModal
        open={trashOpen}
        testid="evidence-trash"
        dismissDisabled={actionBusy}
        onClose={() => setTrashOpen(false)}
        title="Move evidence to trash"
        footer={
          <>
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => setTrashOpen(false)}
              disabled={actionBusy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="app-secondary-action evidence-detail-destructive-action"
              onClick={() =>
                void moveToTrash({ onSuccess: () => setTrashOpen(false) })
              }
              disabled={actionBusy}
              data-evidence-modal-action="confirm-trash"
            >
              Move to trash
            </button>
          </>
        }
      >
        <p>
          Trash state is operational retention handling and must not be confused with
          technical integrity failure.
        </p>
      </PortalModal>
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
  const { workspace, workspaceCaps, reviewSignals, canSeeReviewerOps } = ctx;

  const needsCase = !workspace.relationships.caseId && !workspace.relationships.caseName;
  // Phase EVIDENCE-REVIEW-VISIBILITY — only surface the
  // "Assign reviewer" prompt when the workspace exposes the
  // reviewer-ops surface. On a Personal Space / self-serve
  // context the user IS the reviewer; pestering them to
  // assign one is misleading.
  const needsReviewer =
    canSeeReviewerOps &&
    (!workspace.reviewWorkflow?.status ||
      workspace.reviewWorkflow.status === "NOT_STARTED");
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
    <section className="evidence-detail-attention" data-evidence-attention-strip>
      <strong className="evidence-detail-attention__title">
        What needs attention
      </strong>
      <div className="evidence-detail-attention__items">
        {topRisks.map((s) => (
          <span
            key={`${s.title}-${s.detail}`}
            className={`evidence-detail-pill ${
              s.severity === "danger"
                ? "danger"
                : s.severity === "warning"
                  ? "warning"
                  : // Phase EVIDENCE-RISK-TONE — "info" and "neutral"
                    // both render with the muted pill class so advisory
                    // notes don't shout from the attention strip.
                    "neutral"
            }`}
            data-evidence-attention-risk
            data-evidence-attention-risk-severity={s.severity}
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
            className="evidence-detail-attention__action"
          >
            No case assigned · Assign
          </button>
        ) : null}
        {needsReviewer ? (
          <button
            type="button"
            data-evidence-attention-action="assign-reviewer"
            onClick={onAssignReviewer}
            className="evidence-detail-attention__action"
          >
            Review not started · Start
          </button>
        ) : null}
        {missingReport ? (
          <button
            type="button"
            data-evidence-attention-action="missing-report"
            onClick={onGoToArtifacts}
            className="evidence-detail-attention__action"
          >
            Report not available · Artifacts
          </button>
        ) : null}
        {missingPackage ? (
          <button
            type="button"
            data-evidence-attention-action="missing-package"
            onClick={onGoToArtifacts}
            className="evidence-detail-attention__action"
          >
            Verification package not available · Artifacts
          </button>
        ) : null}
      </div>
      {topRisks.length === 0 && !needsCase && !needsReviewer ? (
        <button
          type="button"
          className="evidence-detail-attention__action"
          data-evidence-attention-action="open-review"
          onClick={onGoToReview}
        >
          Open review workspace
        </button>
      ) : null}
    </section>
  );
}
