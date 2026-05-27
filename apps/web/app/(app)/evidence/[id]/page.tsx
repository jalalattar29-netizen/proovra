"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  ClipboardCheck,
  FileText,
  Globe,
  History,
  ImageIcon,
  LayoutGrid,
  Package,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import {
  PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE,
  PROOVRA_MULTIPART_RECOMPUTATION_NOTE,
  PROOVRA_MULTIPART_REVIEWER_EXPLANATION,
} from "@proovra/shared-evidence-presentation";
import { getReviewerArtifactRoleLabel } from "@proovra/shared";
import { Button, Modal, useToast } from "../../../../components/ui";
import CaptureLocationMapPanel from "../../../../components/capture-location/CaptureLocationMapPanel";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";
import { captureException } from "../../../../lib/sentry";
import { formatUserDateTime } from "../../../../lib/date";
import { ReviewerCommentsPanel } from "../components/ReviewerCommentsPanel";
import { LegalNotesPanel } from "../components/LegalNotesPanel";
import { AnnotationPanel } from "../components/AnnotationPanel";
import { ComparisonPanel } from "../components/ComparisonPanel";
import { DuplicateDetectionPanel } from "../components/DuplicateDetectionPanel";
import { AiCategorizationPanel } from "../components/AiCategorizationPanel";
import type { CaseOption } from "../lib/evidence-library-types";
import type {
  ReviewWorkspaceResponse,
  ReviewerAlert,
  SourceContext,
  TimelineEvent,
} from "./review-workspace-types";
import { ReviewerWorkflowCard } from "./components/ReviewerWorkflowCard";
import { EvidenceReviewActionsPanel } from "./components/EvidenceReviewActionsPanel";
import { EvidenceRelationshipsSection } from "./components/EvidenceRelationshipsSection";
import { ArtifactHistorySection } from "./components/ArtifactHistorySection";
import { ReviewerAuditTrailSection } from "./components/ReviewerAuditTrailSection";
// Phase 6 — surfaces "Source: External intake" + safe reviewer status
// controls when (and only when) the evidence row arrived via the external
// intake pipeline. Returns null for every other evidence record, so this
// import is a no-op for the authenticated capture path.
import ExternalIntakeSourceCard from "./components/ExternalIntakeSourceCard";
// Phase 7 — surfaces linked EvidenceRequests with deliverables + responses
// + reviewer actions. Renders an empty-state CTA when no requests exist,
// so it never visually clutters records that have no operational
// coordination need.
import EvidenceRequestPanel from "./components/EvidenceRequestPanel";
// Phase 9.5 — workspace governance indicators (legal hold, retention,
// policy gates). Renders null when no constraint is active.
import GovernanceIndicators from "./components/GovernanceIndicators";
import {
  ExportPackageEligibilityBadge,
  GovernanceSnapshotPanel,
  OperationalTimelinePanel,
  RuntimeStatusBanner,
} from "../../../../components/operational";
import "./evidence-detail.css";

type EvidenceDetailTab =
  | "overview"
  | "integrity"
  | "custody"
  | "review"
  | "artifacts"
  | "technical";

const DETAIL_TABS: Array<{ id: EvidenceDetailTab; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "Overview", icon: LayoutGrid },
  { id: "integrity", label: "Integrity", icon: ShieldCheck },
  { id: "custody", label: "Custody", icon: History },
  { id: "review", label: "Review", icon: ClipboardCheck },
  { id: "artifacts", label: "Artifacts", icon: Package },
  { id: "technical", label: "Technical Appendix", icon: FileText },
];

function SectionHeading({
  kicker,
  title,
  icon: Icon,
}: {
  kicker: string;
  title: string;
  icon: LucideIcon;
}) {
  return (
    <div className="evidence-detail-heading">
      <span className="evidence-detail-heading-icon" aria-hidden="true">
        <Icon size={16} strokeWidth={2} />
      </span>
      <div className="evidence-detail-heading-copy">
        <p className="evidence-detail-kicker">{kicker}</p>
        <h2>{title}</h2>
      </div>
    </div>
  );
}

function shortId(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (!text) return "Not available";
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}…${text.slice(-6)}`;
}

function formatBytes(sizeBytes: string | number | null | undefined) {
  const numeric =
    typeof sizeBytes === "number"
      ? sizeBytes
      : typeof sizeBytes === "string"
        ? Number(sizeBytes)
        : Number.NaN;

  if (!Number.isFinite(numeric) || numeric <= 0) return "Not recorded";

  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = numeric;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not recorded";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function describeContentItemRole(item: {
  isPrimary: boolean;
  artifactRole?: "primary_evidence" | "supporting_evidence" | "attachment" | null;
  artifactRoleLabel?: string | null;
  checklistStepLabel?: string | null;
}) {
  const roleLabel =
    item.artifactRoleLabel ??
    (item.artifactRole ? getReviewerArtifactRoleLabel(item.artifactRole) : null) ??
    (item.isPrimary ? "Primary evidence" : "Supporting evidence");
  const checklistLabel =
    typeof item.checklistStepLabel === "string" && item.checklistStepLabel.trim()
      ? item.checklistStepLabel.trim()
      : null;

  return checklistLabel ? `${roleLabel} • ${checklistLabel}` : roleLabel;
}

function buildShareUrl(path: string | null | undefined): string | null {
  const normalized = path?.trim();
  if (!normalized) return null;

  const base =
    (typeof window !== "undefined" ? window.location.origin : null) ??
    process.env.NEXT_PUBLIC_APP_BASE?.trim() ??
    process.env.NEXT_PUBLIC_WEB_BASE?.trim() ??
    "";

  return `${base.replace(/\/+$/, "")}${normalized.startsWith("/") ? normalized : `/${normalized}`}`;
}

async function tryDownloadFile(url: string, filename: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Download fetch failed");

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
    return true;
  } catch {
    return false;
  }
}

function pillTone(status: string) {
  const normalized = status.trim().toUpperCase();

  if (
    normalized.includes("READY") ||
    normalized.includes("VERIFIED") ||
    normalized.includes("ACTIVE") ||
    normalized.includes("AVAILABLE") ||
    normalized.includes("RECORDED") ||
    normalized.includes("ANCHORED")
  ) {
    return "success";
  }

  if (
    normalized.includes("WARNING") ||
    normalized.includes("LIMIT") ||
    normalized.includes("PENDING") ||
    normalized.includes("REVIEW") ||
    normalized.includes("SUPPORTED")
  ) {
    return "warning";
  }

  if (
    normalized.includes("FAILED") ||
    normalized.includes("DANGER") ||
    normalized.includes("DELETED") ||
    normalized.includes("TRASH")
  ) {
    return "danger";
  }

  return "neutral";
}

function PreviewWorkspace({
  workspace,
  onOpenOriginal,
  onDownloadOriginal,
}: {
  workspace: ReviewWorkspaceResponse;
  onOpenOriginal: () => void;
  onDownloadOriginal: () => void;
}) {
  const privateItemNotesById = useMemo(
    () =>
      new Map(
        workspace.parts.map((part) => [part.id, part.privateNote ?? null] as const)
      ),
    [workspace.parts]
  );

  const defaultItem =
    workspace.evidence.contentItems?.find(
      (item) => item.id === workspace.evidence.defaultPreviewItemId
    ) ??
    workspace.evidence.contentItems?.find((item) => item.previewable && item.viewUrl) ??
    workspace.evidence.primaryContentItem ??
    null;

  const renderPreview = () => {
    if (!defaultItem || !defaultItem.viewUrl) {
      return (
        <div className="evidence-detail-preview-placeholder">
          <strong>Open the original evidence record to review preserved content.</strong>
          <p>Reviewer-facing preview is not available for this selection in the current response.</p>
        </div>
      );
    }

    if (defaultItem.kind === "image") {
      return (
        <img
          src={defaultItem.viewUrl}
          alt={defaultItem.label}
          className="evidence-detail-preview-media"
        />
      );
    }

    if (defaultItem.kind === "video") {
      return (
        <video
          controls
          preload="metadata"
          className="evidence-detail-preview-media"
          src={defaultItem.viewUrl}
        >
          Your browser could not load this video preview.
        </video>
      );
    }

    if (defaultItem.kind === "audio") {
      return (
        <div className="evidence-detail-preview-audio">
          <audio controls preload="metadata" src={defaultItem.viewUrl}>
            Your browser could not load this audio preview.
          </audio>
        </div>
      );
    }

    if (defaultItem.kind === "pdf") {
      return (
        <iframe
          title={defaultItem.label}
          src={defaultItem.viewUrl}
          className="evidence-detail-preview-frame"
        />
      );
    }

    return (
      <div className="evidence-detail-preview-placeholder">
        <strong>Preview is not available for this file type.</strong>
        <p>Use the original access actions to review the preserved material directly.</p>
      </div>
    );
  };

  return (
    <section className="evidence-detail-section">
      <div className="evidence-detail-section-header">
        <SectionHeading
          kicker="Evidence Preview"
          title="Primary review surface"
          icon={ImageIcon}
        />
        <div className="evidence-detail-inline-actions">
          <Button variant="secondary" onClick={onOpenOriginal}>
            Open original
          </Button>
          <Button variant="secondary" onClick={onDownloadOriginal}>
            Download
          </Button>
        </div>
      </div>

      <div className="evidence-detail-preview-shell">{renderPreview()}</div>

      <div className="evidence-detail-item-grid">
        {workspace.evidence.contentItems?.map((item) => {
          const privateItemNote = privateItemNotesById.get(item.id);
          return (
            <div key={item.id} className="evidence-detail-item-card">
              <div className="evidence-detail-item-row">
                <strong>{item.label}</strong>
                <span className={`evidence-detail-pill ${pillTone(item.kind)}`}>{item.kind}</span>
              </div>
              <p>{item.originalFileName || "Original filename not recorded"}</p>
              <div className="evidence-detail-definition-inline">
                <span>Size</span>
                <strong>{item.displaySizeLabel || formatBytes(item.sizeBytes)}</strong>
              </div>
              <div className="evidence-detail-definition-inline">
                <span>Role</span>
                <strong>{describeContentItemRole(item)}</strong>
              </div>
              {privateItemNote ? (
                <div className="evidence-detail-definition-inline">
                  <span>Private item note</span>
                  <strong>{privateItemNote}</strong>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function KeyValueGrid({ items }: { items: Array<{ label: string; value: string }> }) {
  return (
    <div className="evidence-detail-data-grid">
      {items.map((item) => (
        <div key={item.label} className="evidence-detail-data-cell">
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

function EventTimeline({
  title,
  subtitle,
  events,
  icon,
}: {
  title: string;
  subtitle: string;
  events: TimelineEvent[];
  icon: LucideIcon;
}) {
  return (
    <section className="evidence-detail-section">
      <div className="evidence-detail-section-header">
        <SectionHeading kicker={title} title={subtitle} icon={icon} />
      </div>

      {events.length === 0 ? (
        <p className="evidence-detail-muted">No events recorded in the current API response.</p>
      ) : (
        <div className="evidence-detail-timeline">
          {events.map((event) => (
            <article key={`${event.sequence}-${event.eventType}`} className="evidence-detail-timeline-item">
              <div className="evidence-detail-timeline-dot" aria-hidden="true" />
              <div>
                <div className="evidence-detail-item-row">
                  <strong>{event.eventType.replace(/_/g, " ")}</strong>
                  <span>{formatUserDateTime(event.atUtc)}</span>
                </div>
                <p>{event.payloadSummary || "No event summary recorded."}</p>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function buildRiskSignals(sourceContext: SourceContext, alerts: ReviewerAlert[]) {
  const signals = alerts.map((alert) => ({
    severity: alert.severity,
    title: alert.label,
    detail: alert.detail,
  }));

  if (sourceContext.clientSignalsSummary.screenshotLike) {
    signals.push({
      severity: "warning",
      title: "Screenshot-like signal",
      detail:
        "Metadata-derived advisory signal. Requires human review and does not determine factual or legal outcome.",
    });
  }

  if (sourceContext.clientSignalsSummary.genericMime) {
    signals.push({
      severity: "info",
      title: "Generic MIME type",
      detail: "Generic file typing was recorded in client signals. Review source context separately.",
    });
  }

  if (sourceContext.clientSignalsSummary.oldLastModified) {
    signals.push({
      severity: "warning",
      title: "Old last-modified signal",
      detail: "Client metadata indicates an older modification timestamp. This is advisory only.",
    });
  }

  if (sourceContext.importedUpload) {
    signals.push({
      severity: "info",
      title: "Imported upload",
      detail:
        "Imported upload means PROOVRA preserved the uploaded file and recorded integrity state. It does not independently prove original capture source.",
    });
  }

  return signals;
}

// Phase 38.13 — wrap in canonical PageRouteGate inheriting from parent
// `workspace.evidence` route.
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
  const { addToast } = useToast();
  const evidenceId = params?.id ?? "";

  const [activeTab, setActiveTab] = useState<EvidenceDetailTab>("overview");
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
  // Phase 28-H hotfix — eligibility badge is informational only. The
  // download routes already run enforceSensitiveAction(...) server-side,
  // which is the authoritative gate. Disable the button ONLY when the
  // snapshot has loaded and reports a confirmed non-eligible decision.
  // Loading / unknown / missing-teamId / 403 → leave the button enabled
  // and let the backend respond.
  const [exportDisabled, setExportDisabled] = useState(false);
  const [packageDisabled, setPackageDisabled] = useState(false);

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

      if (workspaceResult.status !== "fulfilled") {
        throw workspaceResult.reason;
      }

      const workspaceData = workspaceResult.value as ReviewWorkspaceResponse;

      setWorkspace(workspaceData);
      setLabelDraft(workspaceData.evidence.displayTitle || workspaceData.evidence.title);
      setWorkflowStatusDraft(workspaceData.reviewWorkflow.status || "NOT_STARTED");
      setWorkflowPriorityDraft(workspaceData.reviewWorkflow.priority || "NORMAL");
      setWorkflowAssigneeDraft(workspaceData.reviewWorkflow.assignedTo?.id || "");
      setWorkflowDueAtDraft(
        workspaceData.reviewWorkflow.dueAt ? workspaceData.reviewWorkflow.dueAt.slice(0, 16) : ""
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

  // Phase 32.5 — Artifact-readiness polling.
  //
  // Background:
  //   Evidence transitions to SIGNED synchronously at finalize time.
  //   The report worker then runs asynchronously (~1-5s) and updates
  //   evidence.status to REPORTED + creates the Report row.
  //
  //   Previously the page did a one-shot fetch on mount, so users
  //   saw SIGNED state with disabled download buttons and had to
  //   manually refresh to see REPORTED. That created the impression
  //   "downloads are broken" — even though the routes worked.
  //
  // Fix:
  //   Poll the side-effect-free /v1/evidence/:id/artifacts/status
  //   endpoint every 3s while:
  //     * evidence is finalized (SIGNED or REPORTED), AND
  //     * either the report is still pending OR the verification
  //       package is still pending.
  //
  //   When the polling sees the pending → ready transition, it
  //   triggers a single loadWorkspace() so the page re-hydrates
  //   with the new state + the download buttons enable.
  //
  // Side-effect contract:
  //   The artifact-status endpoint NEVER creates custody events,
  //   reviewer audit events, or download counters (verified by the
  //   route's contract test). Polling it is safe.
  //
  //   Polling pauses when the tab is hidden (document.hidden) so
  //   inactive tabs don't burn API calls.
  useEffect(() => {
    if (!evidenceId) return;
    if (!workspace?.evidence?.status) return;
    const status = workspace.evidence.status;
    // Only poll while we expect a transition.
    const finalized = status === "SIGNED" || status === "REPORTED";
    if (!finalized) return;

    let cancelled = false;
    let priorReportAvailable = workspace.artifactVersions?.latestReport?.available ?? false;
    let priorPackageAvailable =
      workspace.artifactVersions?.latestVerificationPackage?.available ?? false;

    type ArtifactStatusResponse = {
      report: { available: boolean; pending: boolean };
      verificationPackage: {
        available: boolean;
        pending: boolean;
        unavailable?: boolean;
        unavailableReason?: string | null;
      };
    };

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
        }
        // Decide whether to keep polling.
        const reportStillPending = r.report?.pending === true;
        const packageStillPending = r.verificationPackage?.pending === true;
        return reportStillPending || packageStillPending;
      } catch {
        // Best-effort. A transient network error keeps polling
        // alive on the next tick; we never surface an error toast
        // from the polling path.
        return true;
      }
    };

    let timer: ReturnType<typeof setInterval> | null = null;
    let shouldContinue = true;
    // Kick the first poll immediately, then settle into the interval.
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
    workspace?.artifactVersions?.latestReport?.available,
    workspace?.artifactVersions?.latestVerificationPackage?.available,
  ]);

  const evidence = workspace?.evidence ?? null;
  const workspaceCaps = workspace?.workspaceCapabilitySnapshot ?? null;

  const reviewSignals = useMemo(
    () => (workspace ? buildRiskSignals(workspace.sourceContext, workspace.reviewerAlerts) : []),
    [workspace]
  );

  const reviewReadinessItems = useMemo(() => {
    if (!workspace) return [];

    return [
      {
        label: "Report artifact",
        value: workspace.artifactVersions.latestReport.available ? "Available" : "Not generated",
      },
      {
        label: "Verification package",
        value: workspace.artifactVersions.latestVerificationPackage.available
          ? "Available"
          : workspaceCaps?.verificationPackageIncluded
            ? "Not generated"
            : "Not included on plan",
      },
      {
        label: "Public verification",
        value: workspace.publicVerificationSummary.enabled
          ? workspace.publicVerificationSummary.published
            ? "Enabled"
            : "Supported but not published"
          : "Not included on plan",
      },
      {
        label: "Case assignment",
        value: workspace.relationships.caseName || "Unassigned",
      },
    ];
  }, [workspace, workspaceCaps]);

  const overviewMetadataItems = useMemo(() => {
    if (!workspace) return [];

    return [
      {
        label: "Created",
        value: formatUserDateTime(workspace.evidence.createdAt),
      },
      {
        label: "Captured",
        value: formatValue(formatUserDateTime(workspace.evidence.capturedAtUtc)),
      },
      {
        label: "MIME type",
        value: workspace.evidence.mimeType || "Not recorded",
      },
      {
        label: "File size",
        value: formatBytes(workspace.evidence.sizeBytes),
      },
      {
        label: "Workspace",
        value: workspaceCaps?.workspaceName || "Not recorded",
      },
      {
        label: "Case",
        value: workspace.relationships.caseName || "Unassigned",
      },
      {
        label: "Workflow",
        value: workspace.reviewWorkflow.status
          ? workspace.reviewWorkflow.status.replace(/_/g, " ")
          : "Not configured",
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
      addToast(saveError instanceof Error ? saveError.message : "Failed to update workflow", "error");
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
      addToast(saveError instanceof Error ? saveError.message : "Failed to create relationship", "error");
    } finally {
      setActionBusy(false);
    }
  };

  // Phase 2.1 — Evidence relationship removal. The DELETE endpoint
  // already existed (services/api/src/routes/evidence.routes.ts:6739)
  // with full audit emission, but had no UI affordance. Confirmation
  // is done in the child component before this handler fires.
  const handleRemoveRelationship = async (relationshipId: string) => {
    if (!evidenceId) return;
    setActionBusy(true);
    try {
      await apiFetch(
        `/v1/evidence/${evidenceId}/relationships/${relationshipId}`,
        { method: "DELETE" },
      );
      addToast("Relationship removed", "success");
      await loadWorkspace();
    } catch (deleteError) {
      captureException(deleteError, {
        feature: "web_evidence_relationship_delete",
        evidenceId,
        relationshipId,
      });
      addToast(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to remove relationship",
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
      addToast(updateError instanceof Error ? updateError.message : "Failed to update label", "error");
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
      if (!ok) {
        window.open(url, "_blank", "noopener,noreferrer");
      }

      addToast("Original downloaded", "success");
    } catch (downloadError) {
      addToast("Failed to download original", "error");
      captureException(downloadError, { feature: "web_evidence_download_original", evidenceId });
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
      captureException(downloadError, { feature: "web_evidence_download_report", evidenceId });
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

    // Phase 32.6.4 — map the backend's Phase 32.6.1 state machine
    // onto bounded, enterprise-safe user-facing messages.
    //
    // Backend status codes (services/api/src/routes/evidence.routes.ts):
    //   200 → { url, version, ... }                         → download
    //   202 verification_package_pending                    → "still being generated"
    //   403 PACKAGE_BLOCKED_BY_POLICY                       → "blocked by governance policy"
    //   404 verification_package_not_found                  → "not found"
    //   409 verification_package_blocked                    → "blocked by governance policy"
    //   410 verification_package_unavailable                → "unavailable for this workspace context"
    //   503 GOVERNANCE_CHECK_FAILED                         → "governance check temporarily unavailable"
    //
    // We deliberately do NOT expose `reason`, `outcome`, `blockedAtUtc`,
    // signed URLs, bucket names, or any other internal storage detail.
    // Backend is authoritative.
    try {
      // The 200 path returns a JSON body containing `url`. The 202
      // path also returns 2xx (so `apiFetch` resolves) but with no
      // `url` — instead it carries `{ code, message }`.
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
        if (!ok) {
          window.open(data.url, "_blank", "noopener,noreferrer");
        }
        return;
      }

      // 2xx without a URL — most likely a 202 "pending" body.
      if (data && data.code === "verification_package_pending") {
        addToast(
          "Verification package is still being generated. Retry shortly.",
          "info",
        );
        return;
      }

      // Defensive: a 2xx with neither url nor pending code should
      // never reach us under the current backend contract, but we
      // still surface a bounded message rather than a hang.
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

      // Map by code first (more specific than status), then by status.
      switch (e?.code) {
        case "verification_package_pending":
          userMessage =
            "Verification package is still being generated. Retry shortly.";
          tone = "info";
          break;
        case "verification_package_blocked":
        case "PACKAGE_BLOCKED_BY_POLICY":
          userMessage =
            "Verification package is blocked by governance policy.";
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
          userMessage =
            "Governance check is temporarily unavailable. Retry shortly.";
          tone = "info";
          break;
        default:
          // Fall through to status-based mapping.
          switch (e?.statusCode) {
            case 401:
              userMessage = "Sign-in required to download this package.";
              tone = "info";
              break;
            case 403:
              userMessage =
                "Verification package is blocked by governance policy.";
              tone = "info";
              break;
            case 404:
              userMessage = "Verification package was not found.";
              tone = "info";
              break;
            case 409:
              userMessage =
                "Verification package is blocked by governance policy.";
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

      // Only surface a Sentry breadcrumb for genuinely unexpected
      // failures (network / parsing / 5xx that aren't the bounded
      // governance-unavailable case). The bounded governance / state
      // codes are expected operator-visible signals, not bugs.
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
    const url =
      buildShareUrl(workspace?.publicVerificationSummary.sharePath) ||
      workspace?.publicVerificationSummary.publicUrl ||
      null;

    if (!url) {
      addToast("Public verification link is not available in the current response", "info");
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      addToast("Verification link copied", "success");
    } catch (copyError) {
      addToast("Failed to copy verification link", "error");
      captureException(copyError, { feature: "web_evidence_copy_share_link", evidenceId });
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
      captureException(runError, { feature: "web_evidence_record_action", evidenceId, path });
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
      addToast(runError instanceof Error ? runError.message : "Assignment failed", "error");
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
            <p className="evidence-detail-kicker">Evidence Review Workspace</p>
            <h1>Unable to load the record</h1>
            <p>{error || "The evidence review workspace is unavailable right now."}</p>
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
  const shareUrl =
    buildShareUrl(workspace.publicVerificationSummary.sharePath) ||
    workspace.publicVerificationSummary.publicUrl;

  return (
    <div className="evidence-detail-page">
      <div className="evidence-detail-shell">
        {workspace.reviewWorkflow?.teamId ? (
          // Phase 32.7 — scope to the core_evidence domain so a
          // degraded reviewer/search/governance subsystem doesn't
          // poison the evidence detail page.
          <RuntimeStatusBanner
            teamId={workspace.reviewWorkflow.teamId}
            forDomains={["core_evidence"]}
          />
        ) : null}
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

            <p className="evidence-detail-kicker">Evidence Review &amp; Defensibility Workspace</p>

            {editingLabel ? (
              <div className="evidence-detail-label-edit">
                <input value={labelDraft} onChange={(event) => setLabelDraft(event.target.value)} />
                <Button onClick={() => void handleSaveLabel()} disabled={actionBusy || !labelDraft.trim()}>
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
                "Authoritative reviewer workspace for preserved evidence content, technical verification, custody chronology, export readiness, and internal review context."}
            </p>

            <div className="evidence-detail-hero-meta">
              <span className={`evidence-detail-pill ${pillTone(evidence.status)}`}>
                {evidence.status.replace(/_/g, " ")}
              </span>
              <span className="evidence-detail-pill neutral">{workspace.classification.evidenceTypeLabel}</span>
              <span className="evidence-detail-pill neutral">Record {shortId(evidence.id)}</span>
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
              disabled={exportDisabled}
            >
              Download report
            </Button>
            <Button
              onClick={() => void downloadVerificationPackage()}
              disabled={packageDisabled}
            >
              Download package
            </Button>
            <Button variant="secondary" onClick={() => void copyShareLink()}>
              Copy verification link
            </Button>
            <Button
              variant="secondary"
              onClick={() => setLockOpen(true)}
              disabled={Boolean(evidence.lockedAt) || evidence.deletedAt != null}
            >
              {evidence.lockedAt ? "Record locked" : "Lock record"}
            </Button>
            <Button variant="secondary" onClick={() => setEditingLabel(true)}>
              Edit label
            </Button>
          </div>
        </section>

        <nav className="evidence-detail-tabs" aria-label="Evidence detail sections">
          {DETAIL_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`evidence-detail-tab ${activeTab === tab.id ? "is-active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              aria-pressed={activeTab === tab.id}
            >
              <tab.icon size={15} strokeWidth={2.1} aria-hidden="true" />
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="evidence-detail-layout">
          <main className="evidence-detail-main">
            {activeTab === "overview" ? (
              <>
                <GovernanceIndicators
                  evidenceId={evidenceId}
                  teamId={workspace.reviewWorkflow?.teamId ?? null}
                />
                {workspace.reviewWorkflow?.teamId ? (
                  <GovernanceSnapshotPanel
                    evidenceId={evidenceId}
                    teamId={workspace.reviewWorkflow.teamId}
                  />
                ) : null}
                <ExternalIntakeSourceCard evidenceId={evidenceId} />
                <EvidenceRequestPanel
                  evidenceId={evidenceId}
                  teamId={workspace.reviewWorkflow?.teamId ?? null}
                />
                <section className="evidence-detail-section">
                  <div className="evidence-detail-section-header">
                    <SectionHeading
                      kicker="Overview"
                      title={workspace.reviewDecision.label}
                      icon={ClipboardCheck}
                    />
                  </div>

                  <p>{workspace.reviewDecision.summary}</p>

                  <div className="evidence-detail-overview-grid">
                    <div className="evidence-detail-overview-panel">
                      <p className="evidence-detail-kicker">Review Readiness</p>
                      <KeyValueGrid items={reviewReadinessItems} />
                    </div>

                    <div className="evidence-detail-overview-panel">
                      <p className="evidence-detail-kicker">Verification Proof</p>
                      <KeyValueGrid
                        items={[
                          {
                            label: "Integrity",
                            value: preservation.verificationStatusLabel,
                          },
                          {
                            label: "Custody chain",
                            value: preservation.custodyChain.valid
                              ? "Chain continuity recorded"
                              : "Review required",
                          },
                          {
                            label: "Signature",
                            value: preservation.signature.valid
                              ? "Signature applied and validated"
                              : preservation.signature.recorded
                                ? "Signature recorded"
                                : "Not recorded",
                          },
                          {
                            label: "OTS",
                            value: formatValue(preservation.ots.effectiveStatus),
                          },
                        ]}
                      />
                    </div>
                  </div>

                  {workspace.reviewDecision.nextActions.length > 0 ? (
                    <div className="evidence-detail-note-box">
                      <strong>Recommended next actions</strong>
                      <ul className="evidence-detail-flat-list">
                        {workspace.reviewDecision.nextActions.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </section>

                <PreviewWorkspace
                  workspace={workspace}
                  onOpenOriginal={() => void openOriginal()}
                  onDownloadOriginal={() => void downloadOriginal()}
                />

                <section className="evidence-detail-section">
                  <div className="evidence-detail-section-header">
                    <SectionHeading
                      kicker="Core Metadata"
                      title="Record state at a glance"
                      icon={FileText}
                    />
                  </div>
                  <KeyValueGrid items={overviewMetadataItems} />
                </section>
              </>
            ) : null}

            {activeTab === "integrity" ? (
              <>
                <section className="evidence-detail-section">
                  <div className="evidence-detail-section-header">
                    <SectionHeading
                      kicker="Source &amp; Capture Context"
                      title="Capture provenance context"
                      icon={ImageIcon}
                    />
                  </div>

                  <KeyValueGrid
                    items={[
                      {
                        label: "Source type",
                        value: workspace.sourceContext.sourceType.replace(/_/g, " "),
                      },
                      { label: "Capture method", value: workspace.sourceContext.captureMethodLabel },
                      { label: "Device time", value: formatValue(workspace.sourceContext.deviceTimeIso) },
                      {
                        label: "Captured at",
                        value: formatValue(formatUserDateTime(workspace.sourceContext.capturedAtUtc)),
                      },
                      {
                        label: "Uploaded at",
                        value: formatValue(formatUserDateTime(workspace.sourceContext.uploadedAtUtc)),
                      },
                      {
                        label: "Location included",
                        value: workspace.sourceContext.locationIncluded ? "Included" : "Not included",
                      },
                      {
                        label: "Screenshot-like signal",
                        value: workspace.sourceContext.clientSignalsSummary.screenshotLike
                          ? "Recorded"
                          : "Not recorded",
                      },
                      {
                        label: "Folder path signal",
                        value: workspace.sourceContext.clientSignalsSummary.folderPathPresent
                          ? "Recorded"
                          : "Not recorded",
                      },
                    ]}
                  />

                  {workspace.sourceCaptureLocation ? (
                    <div className="evidence-detail-map-shell">
                      <CaptureLocationMapPanel
                        lat={workspace.sourceCaptureLocation.lat ?? 0}
                        lng={workspace.sourceCaptureLocation.lng ?? 0}
                        accuracyMeters={workspace.sourceCaptureLocation.accuracyMeters}
                      />
                      <p className="evidence-detail-muted">{workspace.sourceCaptureLocation.legalBoundary}</p>
                    </div>
                  ) : null}

                  <div className="evidence-detail-note-box">
                    <strong>Boundary</strong>
                    <p>{workspace.sourceContext.limitations[0]}</p>
                  </div>
                </section>

                <section className="evidence-detail-section">
                  <div className="evidence-detail-section-header">
                    <SectionHeading
                      kicker="Preservation Matrix"
                      title="Recorded integrity and preservation materials"
                      icon={ShieldCheck}
                    />
                  </div>

                  <KeyValueGrid
                    items={[
                      { label: "Verification status", value: preservation.verificationStatusLabel },
                      {
                        label: "SHA-256 recorded",
                        value: preservation.sha256Recorded ? "Recorded" : "Not recorded",
                      },
                      {
                        label: "Fingerprint hash",
                        value: preservation.fingerprintHashRecorded ? "Recorded" : "Not recorded",
                      },
                      {
                        label: "Signature",
                        value: preservation.signature.recorded
                          ? preservation.signature.valid
                            ? "Recorded and validated"
                            : "Recorded"
                          : "Not recorded",
                      },
                      {
                        label: "TSA timestamp",
                        value: preservation.tsa.timestampAvailable
                          ? "Timestamp recorded"
                          : preservation.tsa.status
                            ? `Status: ${preservation.tsa.status}`
                            : "Timestamp unavailable",
                      },
                      { label: "OTS status", value: formatValue(preservation.ots.effectiveStatus) },
                      {
                        label: "Storage protection",
                        value: preservation.storage?.verified
                          ? "Recorded"
                          : "Not exposed in current API response",
                      },
                      {
                        label: "Public anchoring",
                        // The anchor.published flag indicates the anchor was
                        // submitted; without a Bitcoin transaction id field on
                        // this surface we cannot truthfully assert
                        // "Bitcoin anchoring verified", so we use the more
                        // conservative published-vs-pending phrasing.
                        value: preservation.anchor?.published
                          ? "Anchor publication recorded"
                          : preservation.anchor?.configured
                            ? "OpenTimestamps proof present; public anchoring pending"
                            : "OpenTimestamps not configured",
                      },
                      {
                        label: "Report artifact",
                        value: preservation.report.available
                          ? `Version ${preservation.report.version ?? "latest"}`
                          : "Not generated",
                      },
                      {
                        label: "Verification package",
                        value: preservation.verificationPackage.available
                          ? `Version ${preservation.verificationPackage.version ?? "latest"}`
                          : "Not generated",
                      },
                      // Phase C #10 — retention visibility on the
                      // authenticated evidence detail surface.
                      {
                        label: "Retention until",
                        value: workspace.evidence?.retentionUntilUtc
                          ? `Recorded — ${formatValue(formatUserDateTime(workspace.evidence.retentionUntilUtc))}`
                          : "No record-level retention deadline recorded",
                      },
                      {
                        label: "Object Lock retention mode",
                        value: workspace.evidence?.storageObjectLockMode
                          ? String(workspace.evidence.storageObjectLockMode)
                          : "Not asserted (storage immutability not confirmed for this record)",
                      },
                      {
                        label: "Object Lock retention until",
                        value: workspace.evidence?.storageObjectLockRetainUntilUtc
                          ? formatValue(
                              formatUserDateTime(
                                workspace.evidence.storageObjectLockRetainUntilUtc
                              )
                            )
                          : "Not asserted",
                      },
                      {
                        label: "Legal hold",
                        value:
                          workspace.evidence?.storageObjectLockLegalHoldStatus ===
                          "ON"
                            ? "Legal hold active"
                            : workspace.evidence?.storageObjectLockLegalHoldStatus ===
                                "OFF"
                              ? "Legal hold off"
                              : "No legal hold metadata recorded",
                      },
                    ]}
                  />
                </section>

                <section className="evidence-detail-section">
                  <div className="evidence-detail-section-header">
                    <SectionHeading
                      kicker="Verification History"
                      title="Fixed artifacts and post-report activity"
                      icon={History}
                    />
                  </div>

                  <KeyValueGrid
                    items={[
                      {
                        label: "Report generated at",
                        value: formatValue(formatUserDateTime(workspace.snapshot.reportGeneratedAtUtc)),
                      },
                      {
                        label: "Verification package generated at",
                        value: formatValue(
                          formatUserDateTime(workspace.snapshot.verificationPackageGeneratedAtUtc)
                        ),
                      },
                      {
                        label: "Forensic events at report time",
                        value: String(workspace.custodyDisplayCounts.forensicAtReportGeneration),
                      },
                      {
                        label: "Current forensic events",
                        value: String(workspace.custodyDisplayCounts.currentForensicEvents),
                      },
                      {
                        label: "Access events after report",
                        value: String(workspace.custodyDisplayCounts.accessAfterReportGeneration),
                      },
                      {
                        label: "Current status",
                        value: workspace.snapshot.currentStatus.replace(/_/g, " "),
                      },
                    ]}
                  />

                  <div className="evidence-detail-note-box">
                    <strong>Snapshot boundary</strong>
                    <p>{workspace.snapshot.fixedArtifactNote}</p>
                  </div>

                  <div className="evidence-detail-note-box">
                    <strong>Integrity drift</strong>
                    <p>{workspace.integrityDrift.note}</p>
                  </div>

                  {/*
                    Phase C #2 — surface the snapshot/live divergence on the
                    authenticated evidence detail surface too. The verify page
                    has the same callout for public viewers; this one is for
                    the reviewer.
                  */}
                  {workspace.artifactVersions.trustDecisionConsistency
                    ?.consistentWithSnapshot === false ? (
                    <div
                      role={
                        workspace.artifactVersions.trustDecisionConsistency
                          ?.tone === "danger"
                          ? "alert"
                          : "status"
                      }
                      className="evidence-detail-note-box"
                      style={{
                        borderLeft:
                          workspace.artifactVersions.trustDecisionConsistency
                            ?.tone === "danger"
                            ? "5px solid #b54738"
                            : workspace.artifactVersions
                                  .trustDecisionConsistency?.accessOnly
                              ? "5px solid #0b2e27"
                              : "5px solid #b8861f",
                        background:
                          workspace.artifactVersions.trustDecisionConsistency
                            ?.tone === "danger"
                            ? "#fff3f1"
                            : workspace.artifactVersions
                                  .trustDecisionConsistency?.accessOnly
                              ? "rgba(11,46,39,0.06)"
                              : "#fef7e8",
                      }}
                    >
                      <strong>Snapshot boundary update</strong>
                      <p>
                        {workspace.artifactVersions.trustDecisionConsistency
                          ?.accessOnly
                          ? "No integrity mismatch detected. Live access activity now differs from the fixed report snapshot, and this is informational activity drift only."
                          : workspace.artifactVersions.trustDecisionConsistency
                            ?.tone === "danger"
                              ? "A live integrity-relevant divergence was detected between the current state and the fixed report snapshot. Review the current technical materials to understand the exact issue."
                              : "Live verification now differs from the fixed report snapshot. Review current technical materials to understand the nature of the change."}
                      </p>
                      <p>
                        The trust decision shown here is sourced from the fixed
                        snapshot taken at report or package generation time.
                        The reasons below explain what changed later in the live
                        state.
                      </p>
                      {workspace.artifactVersions.trustDecisionConsistency
                        ?.reasons?.length ? (
                        <ul>
                          {workspace.artifactVersions.trustDecisionConsistency.reasons.map(
                            (reason, index) => (
                              <li key={`${reason.code ?? "reason"}-${index}`}>
                                <strong>
                                  {reason.label ?? "Snapshot difference detected"}.
                                </strong>{" "}
                                {reason.detail ??
                                  "Review the live technical materials for the current state."}
                              </li>
                            )
                          )}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}
                </section>

                {/*
                  Phase C #11 — concise reviewer audit drilldown. Surfaces the
                  forensic vs access split, custody chain validity, and the
                  hash-semantics flag in one spot so reviewers don't have to
                  spelunk through the raw JSON appendix.
                */}
                <section className="evidence-detail-section">
                  <div className="evidence-detail-section-header">
                    <SectionHeading
                      kicker="Reviewer Audit Drilldown"
                      title="Forensic chain, access analytics, and hash semantics"
                      icon={ShieldCheck}
                    />
                  </div>

                  <KeyValueGrid
                    items={[
                      {
                        label: "Custody chain validity",
                        value: preservation.custodyChain.valid
                          ? `Continuous (${preservation.custodyChain.mode})`
                          : `Review required (${preservation.custodyChain.reason ?? "unknown"})`,
                      },
                      {
                        label: "Forensic events at report time",
                        value: String(
                          workspace.custodyDisplayCounts.forensicAtReportGeneration
                        ),
                      },
                      {
                        label: "Forensic events now",
                        value: String(
                          workspace.custodyDisplayCounts.currentForensicEvents
                        ),
                      },
                      {
                        label: "Access / view events after report",
                        value: String(
                          workspace.custodyDisplayCounts.accessAfterReportGeneration
                        ),
                      },
                      ...(() => {
                        // technicalMaterials is loosely typed (Record<string, unknown>);
                        // narrow to a small reader to make the rendering clean.
                        const tm = (workspace.artifactVersions
                          .technicalMaterials ?? {}) as {
                          hashSemantics?: string | null;
                          multipartManifestSha256?: string | null;
                          tsaInputDigestHex?: string | null;
                        };
                        return [
                          {
                            label: "Hash semantics",
                            value:
                              tm.hashSemantics === "single_file"
                                ? "Single-file SHA-256"
                                : tm.hashSemantics === "multipart_composite"
                                  ? "Multipart composite (with reproducible manifest digest)"
                                  : tm.hashSemantics ===
                                      "multipart_composite_legacy"
                                    ? "Multipart composite (legacy record — reproduce from per-part hashes in the verification package)"
                                    : "Not specified",
                          },
                          {
                            label: "Multipart manifest SHA-256",
                            value:
                              tm.multipartManifestSha256 ??
                              "Not applicable / not stored",
                          },
                          {
                            label: "TSA accepted message imprint",
                            value:
                              tm.tsaInputDigestHex ?? "TSA token not present",
                          },
                        ];
                      })(),
                    ]}
                  />

                  <p className="evidence-detail-muted">
                    Forensic custody events are technical chain events
                    (creation, signature, retention, timestamp). Access events
                    are read-only views and downloads. The two are kept
                    separate so the chain is not diluted by analytics traffic.
                  </p>
                  {(() => {
                    const tm = (workspace.artifactVersions.technicalMaterials ??
                      {}) as {
                      hashSemantics?: string | null;
                    };
                    return tm.hashSemantics === "multipart_composite" ||
                      tm.hashSemantics === "multipart_composite_legacy" ? (
                      <p className="evidence-detail-muted">
                        {PROOVRA_MULTIPART_REVIEWER_EXPLANATION}{" "}
                        {PROOVRA_MULTIPART_RECOMPUTATION_NOTE}{" "}
                        {PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE}
                      </p>
                    ) : null;
                  })()}
                </section>
              </>
            ) : null}

            {activeTab === "custody" ? (
              <>
                <EventTimeline
                  title="Forensic Custody Timeline"
                  subtitle="Integrity-relevant lifecycle chronology"
                  events={workspace.custodyLifecycle.forensicEvents}
                  icon={History}
                />

                <EventTimeline
                  title="Access & Security Activity"
                  subtitle="Viewing, download, and verification access activity"
                  events={workspace.custodyLifecycle.accessEvents}
                  icon={Globe}
                />

                {workspace.reviewWorkflow?.teamId ? (
                  <OperationalTimelinePanel
                    evidenceId={evidenceId}
                    teamId={workspace.reviewWorkflow.teamId}
                  />
                ) : null}
              </>
            ) : null}

            {activeTab === "review" ? (
              <>
                <EvidenceRelationshipsSection
                  caseName={workspace.relationships.caseName}
                  relatedEvidenceCount={workspace.relationships.relatedEvidenceCount}
                  multipart={workspace.relationships.multipart}
                  itemCount={workspace.relationships.itemCount}
                  note={workspace.relationships.note}
                  items={workspace.relationships.items}
                  actionBusy={actionBusy}
                  onAssignCase={() => {
                    setSelectedCaseId(workspace.relationships.caseId || "");
                    setAssignCaseOpen(true);
                  }}
                  onRemoveCase={workspace.relationships.caseId ? () => void removeCase() : null}
                  onOpenRelationshipEditor={() => setRelationshipOpen(true)}
                  onOpenLinkedEvidence={(id) => router.push(`/evidence/${id}`)}
                  onRemoveRelationship={handleRemoveRelationship}
                />

                <ReviewerWorkflowCard
                  workflow={workspace.reviewWorkflow}
                  events={workflowEvents}
                  eventsLoading={workflowEventsLoading}
                  actionBusy={actionBusy}
                  onRefreshEvents={() => void loadWorkflowEvents()}
                  onOpenEditor={() => setWorkflowOpen(true)}
                  formatDateTime={formatUserDateTime}
                />

                {/* Phase 13.5 — compact review decisions panel.
                    Stage-aware action buttons calling the Phase 13
                    `/v1/review-operations/*` endpoints. */}
                <EvidenceReviewActionsPanel
                  evidenceId={evidenceId}
                  teamId={workspace.reviewWorkflow?.teamId ?? null}
                  currentStatus={workspace.reviewWorkflow.status ?? null}
                  assignedToUserId={
                    workspace.reviewWorkflow.assignedTo?.id ?? null
                  }
                  currentUserId={null}
                  onChanged={() => void loadWorkflowEvents()}
                />

                <section className="evidence-detail-section">
                  <div className="evidence-detail-section-header">
                    <SectionHeading
                      kicker="Notes &amp; Reviewer Collaboration"
                      title="Private review materials"
                      icon={ClipboardCheck}
                    />
                  </div>

                  <div className="evidence-detail-note-box">
                    <strong>Boundary</strong>
                    <p>
                      Private review notes are not included in public verification or external packages unless
                      explicitly exported.
                    </p>
                  </div>

                  {workspace.governance ? (
                    <div className="evidence-detail-note-box">
                      <strong>Governance</strong>
                      <p>
                        {workspace.governance.reviewerComments.label},{" "}
                        {workspace.governance.legalNotes.label}, and{" "}
                        {workspace.governance.annotations.label} are internal workspace materials. They are not
                        included in public verification, the fixed PDF report, or the verification package.
                      </p>
                    </div>
                  ) : null}

                  {evidence.internalNotes ? (
                    <div className="evidence-detail-note-box">
                      <strong>Private session note</strong>
                      <p>{evidence.internalNotes}</p>
                    </div>
                  ) : null}

                  <div className="evidence-detail-embedded-panels">
                    <ReviewerCommentsPanel evidenceId={evidence.id} />
                    <LegalNotesPanel evidenceId={evidence.id} />
                    <AnnotationPanel evidenceId={evidence.id} defaultPartId={workspace.parts[0]?.id ?? null} />
                  </div>
                </section>

                <section className="evidence-detail-section">
                  <div className="evidence-detail-section-header">
                    <SectionHeading
                      kicker="Retention &amp; Compliance"
                      title="Workspace and record retention state"
                      icon={ShieldCheck}
                    />
                  </div>

                  <KeyValueGrid
                    items={[
                      { label: "Workspace type", value: workspaceCaps.workspaceType },
                      { label: "Billing status", value: formatValue(workspaceCaps.billingStatus) },
                      { label: "Storage used", value: formatValue(workspaceCaps.storageUsedLabel) },
                      { label: "Storage remaining", value: formatValue(workspaceCaps.storageRemainingLabel) },
                      { label: "Locked at", value: formatValue(formatUserDateTime(evidence.lockedAt)) },
                      { label: "Archived at", value: formatValue(formatUserDateTime(evidence.archivedAt)) },
                      { label: "Deleted at", value: formatValue(formatUserDateTime(evidence.deletedAt)) },
                      {
                        label: "Delete scheduled for",
                        value: formatValue(formatUserDateTime(evidence.deleteScheduledForUtc)),
                      },
                      {
                        label: "Object lock",
                        value: preservation.storage?.mode || "Not exposed in current API response",
                      },
                      {
                        label: "Legal hold",
                        value: preservation.storage?.legalHold || "Not exposed in current API response",
                      },
                    ]}
                  />

                  <div className="evidence-detail-inline-actions">
                    {evidence.archivedAt ? (
                      <Button
                        variant="secondary"
                        onClick={() =>
                          void runRecordAction(
                            `/v1/evidence/${evidence.id}/unarchive`,
                            "Evidence restored from archive"
                          )
                        }
                      >
                        Restore archive
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        onClick={() => setArchiveOpen(true)}
                        disabled={evidence.deletedAt != null}
                      >
                        Archive
                      </Button>
                    )}

                    {evidence.deletedAt ? (
                      <Button variant="secondary" onClick={() => void restoreTrash()}>
                        Restore from trash
                      </Button>
                    ) : (
                      <Button variant="secondary" onClick={() => setTrashOpen(true)}>
                        Move to trash
                      </Button>
                    )}
                  </div>
                </section>
              </>
            ) : null}

            {activeTab === "artifacts" ? (
              <>
                <ArtifactHistorySection
                  history={workspace.artifactVersions.history}
                  onDownloadReport={() => void downloadReport()}
                  onDownloadVerificationPackage={() => void downloadVerificationPackage()}
                  formatDateTime={formatUserDateTime}
                  formatBytes={formatBytes}
                />

                <section className="evidence-detail-section">
                  <div className="evidence-detail-section-header">
                    <SectionHeading
                      kicker="Public Verification &amp; Sharing"
                      title="External verification and export activity"
                      icon={Globe}
                    />
                  </div>
                  <KeyValueGrid
                    items={[
                      {
                        label: "Verification status",
                        value: workspace.publicVerificationSummary.enabled
                          ? workspace.publicVerificationSummary.published
                            ? "Enabled"
                            : "Supported but not published"
                          : "Not included on plan",
                      },
                      {
                        label: "Verification link",
                        value: shareUrl ? "Available" : "Not available",
                      },
                      {
                        label: "Public views",
                        value: String(workspace.publicVerificationSummary.publicViewCount),
                      },
                      {
                        label: "Report downloads",
                        value: String(workspace.publicVerificationSummary.reportDownloadCount),
                      },
                      {
                        label: "Package downloads",
                        value: String(workspace.publicVerificationSummary.verificationPackageDownloadCount),
                      },
                      {
                        label: "Last public view",
                        value: formatValue(
                          formatUserDateTime(workspace.publicVerificationSummary.lastPublicViewAt)
                        ),
                      },
                    ]}
                  />
                </section>
              </>
            ) : null}

            {activeTab === "review" ? (
              <>
                <ComparisonPanel evidenceId={evidence.id} />
                <DuplicateDetectionPanel evidenceId={evidence.id} />
                <AiCategorizationPanel evidenceId={evidence.id} />

                <ReviewerAuditTrailSection
                  items={workspace.reviewerAudit ?? []}
                  formatDateTime={formatUserDateTime}
                />
              </>
            ) : null}

            {activeTab === "technical" ? (
              <section className="evidence-detail-section">
                <div className="evidence-detail-section-header">
                  <SectionHeading
                    kicker="Technical Appendix"
                    title="Structured technical materials"
                    icon={FileText}
                  />
                </div>
                <details open>
                  <summary className="evidence-detail-raw-summary">Raw technical appendix</summary>
                  <pre className="evidence-detail-raw-block">
                    {JSON.stringify(
                      {
                        trustDecision,
                        trustDecisionConsistency: workspace.artifactVersions.trustDecisionConsistency,
                        technicalMaterials: workspace.artifactVersions.technicalMaterials,
                        preservationMatrix: preservation,
                      },
                      null,
                      2
                    )}
                  </pre>
                </details>
              </section>
            ) : null}
          </main>

          <aside className="evidence-detail-sidebar">
            <section className="evidence-detail-side-block">
              <SectionHeading
                kicker="Reviewer Decision"
                title={workspace.reviewDecision.label}
                icon={ClipboardCheck}
              />
              <p>{workspace.reviewDecision.summary}</p>
            </section>

            <section className="evidence-detail-side-block">
              <SectionHeading kicker="Risk Signals" title="Reviewer attention" icon={TriangleAlert} />
              {reviewSignals.length === 0 ? (
                <p className="evidence-detail-muted">No advisory risk signals in the current response.</p>
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

            <section className="evidence-detail-side-block">
              <SectionHeading
                kicker="Review Readiness"
                title="Operational summary"
                icon={ShieldCheck}
              />
              <KeyValueGrid
                items={[
                  {
                    label: "Workflow",
                    value: workspace.reviewWorkflow.status
                      ? workspace.reviewWorkflow.status.replace(/_/g, " ")
                      : "Not configured",
                  },
                  {
                    label: "Priority",
                    value: workspace.reviewWorkflow.priority || "Not configured",
                  },
                  {
                    label: "Case",
                    value: workspace.relationships.caseName || "Unassigned",
                  },
                  {
                    label: "Due date",
                    value: formatValue(formatUserDateTime(workspace.reviewWorkflow.dueAt)),
                  },
                ]}
              />
            </section>

            <section className="evidence-detail-side-block">
              <SectionHeading
                kicker="Public Verification"
                title="External verification summary"
                icon={Globe}
              />
              <KeyValueGrid
                items={[
                  {
                    label: "Status",
                    value: workspace.publicVerificationSummary.enabled
                      ? workspace.publicVerificationSummary.published
                        ? "Enabled"
                        : "Supported but not published"
                      : "Not included on plan",
                  },
                  {
                    label: "Public views",
                    value: String(workspace.publicVerificationSummary.publicViewCount),
                  },
                  {
                    label: "Report downloads",
                    value: String(workspace.publicVerificationSummary.reportDownloadCount),
                  },
                  {
                    label: "Package downloads",
                    value: String(workspace.publicVerificationSummary.verificationPackageDownloadCount),
                  },
                ]}
              />

              {shareUrl ? (
                <a href={shareUrl} className="evidence-detail-inline-link" target="_blank" rel="noreferrer">
                  Open verification surface
                </a>
              ) : null}
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
            <Button onClick={() => void assignCase()} disabled={actionBusy || !selectedCaseId}>
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
              Reviewer assignment uses currently accessible reviewer identities from the loaded workflow state.
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
            <Button onClick={() => void saveRelationship()} disabled={actionBusy || !relationshipTargetId}>
              Save relationship
            </Button>
          </>
        }
      >
        <div className="evidence-detail-modal-stack">
          <p className="evidence-detail-muted">
            Enter the linked evidence record ID. The target must be an accessible evidence record.
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
              onClick={() => void runRecordAction(`/v1/evidence/${evidenceId}/lock`, "Evidence locked")}
              disabled={actionBusy}
            >
              Confirm lock
            </Button>
          </>
        }
      >
        <p>Locking preserves the current record state and prevents further mutable updates to the evidence record.</p>
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
              onClick={() => void runRecordAction(`/v1/evidence/${evidenceId}/archive`, "Evidence archived")}
              disabled={actionBusy}
            >
              Archive
            </Button>
          </>
        }
      >
        <p>Archiving changes operational visibility. It does not change recorded integrity materials.</p>
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
        <p>Trash state is operational retention handling and must not be confused with technical integrity failure.</p>
      </Modal>
    </div>
  );
}
