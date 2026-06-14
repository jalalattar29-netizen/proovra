/**
 * Phase EVIDENCE-IA-DECOMPOSE — shared helpers + context type for the
 * Evidence Detail tab decomposition.
 *
 * The page.tsx orchestrator owns ALL state, callbacks, and effects. The
 * extracted tab components are pure presentation — they receive the
 * single `EvidenceDetailCtx` prop bag and destructure what they need.
 *
 * This file collects every helper that more than one tab + the page
 * shell would otherwise duplicate. Helpers are unchanged from their
 * original page-internal definitions (Phase 0 is mechanical extraction
 * only — no behavior, copy, or UI changes).
 */

"use client";

import { useMemo } from "react";
import { ImageIcon, type LucideIcon } from "lucide-react";
import { getReviewerArtifactRoleLabel } from "@proovra/shared";
import { Button } from "../../../../../components/ui";
import { formatUserDateTime } from "../../../../../lib/date";
import type {
  ReviewWorkspaceResponse,
  ReviewerAlert,
  SourceContext,
  TimelineEvent,
} from "../review-workspace-types";

// ---------------------------------------------------------------------------
// Tab identifier
// ---------------------------------------------------------------------------

export type EvidenceDetailTab =
  | "overview"
  | "integrity"
  | "custody"
  | "review"
  | "artifacts"
  | "discussion"
  | "technical";

// ---------------------------------------------------------------------------
// Single-prop "context" the orchestrator passes into every extracted
// tab. Adding a new field here costs one prop in the orchestrator and
// one destructure in the tab that needs it — far cleaner than ad-hoc
// per-tab prop signatures.
// ---------------------------------------------------------------------------

export type EvidenceDetailCtx = {
  // Core API envelope
  workspace: ReviewWorkspaceResponse;
  evidence: ReviewWorkspaceResponse["evidence"];
  workspaceCaps: NonNullable<ReviewWorkspaceResponse["workspaceCapabilitySnapshot"]>;
  preservation: ReviewWorkspaceResponse["preservationMatrix"];
  trustDecision: unknown;
  evidenceId: string;

  // Derived / memoized values from the orchestrator
  publicVerificationState: { label: string; detail: string } | null;
  otsStatusPresentation: { label: string; detail: string } | null;
  technicalReadinessSummary: string;
  reviewSignals: Array<{ severity: string; title: string; detail: string }>;
  reviewReadinessItems: Array<{ label: string; value: string }>;
  overviewMetadataItems: Array<{ label: string; value: string }>;
  shareUrl: string | null;
  isIntegrityFailed: boolean;
  showManualLatestStatusCheck: boolean;
  initialThreadId: string | null;

  // Surface gates (Phase IA-self-serve-completion)
  canSeeReviewerOps: boolean;
  canSeeGovernance: boolean;
  canSeeIntelligence: boolean;
  canSeeIntakeLinks: boolean;

  // Intelligence projection
  intelligence:
    | (Pick<
        import("../../../../../lib/api/intelligence").IntelligenceEvidenceResponse,
        "entities" | "extractedTexts" | "disclaimer"
      > | null);
  intelligenceLoaded: boolean;

  // Workflow drilldown state (for ReviewerWorkflowCard)
  workflowEvents: Array<{
    id: string;
    eventType: string;
    note: string | null;
    previousValue: unknown;
    nextValue: unknown;
    createdAt: string;
    actor: { id: string; email: string | null; displayName: string | null } | null;
  }>;
  workflowEventsLoading: boolean;
  actionBusy: boolean;

  // Artifact stale-pending state (Phase CAPTURE-ARTIFACT-PIPELINE)
  stalePending: boolean;
  setStalePending: (next: boolean) => void;
  setPollStartedAt: (next: number | null) => void;

  // Callbacks
  loadWorkspace: () => Promise<void> | void;
  loadWorkflowEvents: () => Promise<void> | void;
  openOriginal: () => Promise<void> | void;
  downloadOriginal: () => Promise<void> | void;
  downloadReport: () => Promise<void> | void;
  downloadVerificationPackage: () => Promise<void> | void;
  runRecordAction: (path: string, successMessage: string) => Promise<void> | void;
  restoreTrash: () => Promise<void> | void;
  removeCase: () => Promise<void> | void;
  handleRemoveRelationship: (relationshipId: string) => Promise<void> | void;

  // Modal openers
  setSelectedCaseId: (id: string) => void;
  setAssignCaseOpen: (open: boolean) => void;
  setArchiveOpen: (open: boolean) => void;
  setTrashOpen: (open: boolean) => void;
  setWorkflowOpen: (open: boolean) => void;
  setRelationshipOpen: (open: boolean) => void;

  // Router
  routerPush: (href: string) => void;
};

// ---------------------------------------------------------------------------
// SectionHeading
// ---------------------------------------------------------------------------

export function SectionHeading({
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

// ---------------------------------------------------------------------------
// Primitive value formatters
// ---------------------------------------------------------------------------

export function shortId(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (!text) return "Not available";
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}…${text.slice(-6)}`;
}

export function formatBytes(sizeBytes: string | number | null | undefined) {
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

export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not recorded";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export function describeContentItemRole(item: {
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

export function pillTone(status: string) {
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

// ---------------------------------------------------------------------------
// Status / availability describers (kept canonical; tests pin output strings)
// ---------------------------------------------------------------------------

export function buildShareUrl(path: string | null | undefined): string | null {
  const normalized = path?.trim();
  if (!normalized) return null;

  const base =
    (typeof window !== "undefined" ? window.location.origin : null) ??
    process.env.NEXT_PUBLIC_APP_BASE?.trim() ??
    process.env.NEXT_PUBLIC_WEB_BASE?.trim() ??
    "";

  return `${base.replace(/\/+$/, "")}${normalized.startsWith("/") ? normalized : `/${normalized}`}`;
}

export function buildPublishedVerificationUrl(
  summary: ReviewWorkspaceResponse["publicVerificationSummary"] | null | undefined
): string | null {
  if (!summary || summary.state !== "PUBLISHED") return null;
  return buildShareUrl(summary.sharePath);
}

export function describePublicVerificationState(
  summary: ReviewWorkspaceResponse["publicVerificationSummary"]
): { label: string; detail: string } {
  switch (summary.state) {
    case "NOT_INCLUDED":
      return {
        label: "Not included on plan",
        detail:
          summary.disabledReason ||
          "Public verification is not included in the current workspace capability set.",
      };
    case "NOT_CONFIGURED":
      return {
        label: "Not configured",
        detail:
          summary.disabledReason ||
          "Public verification is supported for this workspace, but this evidence record does not have a publishable verification surface configured.",
      };
    case "CONFIGURED_NOT_PUBLISHED":
      return {
        label: "Configured but not published",
        detail:
          summary.disabledReason ||
          "Public verification is configured for this evidence record, but it has not been published yet.",
      };
    case "PUBLISHED":
      return {
        label: "Published",
        detail: "Public verification is published and the public route should resolve.",
      };
    case "SUSPENDED":
      return {
        label: "Suspended",
        detail:
          summary.disabledReason ||
          "Public verification was suspended and the public route is intentionally unavailable.",
      };
    case "UNPUBLISHED":
      return {
        label: "Unpublished",
        detail:
          summary.disabledReason ||
          "Public verification was unpublished and no public verification link is currently active.",
      };
    default:
      return {
        label: "State unavailable",
        detail:
          summary.disabledReason ||
          "The publication state could not be resolved from the current evidence record.",
      };
  }
}

export function describeClientSignalState(
  status: "NOT_COLLECTED" | "COLLECTED_FALSE" | "DETECTED" | "UNAVAILABLE"
): string {
  switch (status) {
    case "NOT_COLLECTED":
      return "Client signal not collected";
    case "COLLECTED_FALSE":
      return "Collected: no signal detected";
    case "DETECTED":
      return "Signal detected";
    case "UNAVAILABLE":
      return "Unavailable for this evidence type";
    default:
      return "Not recorded";
  }
}

export function describeReportArtifactStatus(
  artifactStatus: ReviewWorkspaceResponse["artifactStatus"]
): string {
  if (artifactStatus.report.available) return "Available";
  if (artifactStatus.report.pending) return "Pending";
  return "Not generated";
}

export function describeReportPdfSignature(
  artifactStatus: ReviewWorkspaceResponse["artifactStatus"]
): string {
  if (!artifactStatus.report.available || !artifactStatus.report.pdfSignature) {
    return artifactStatus.report.pending ? "Pending" : "Unknown";
  }

  switch (artifactStatus.report.pdfSignature.status) {
    case "SIGNED":
      return "Signed";
    case "UNSIGNED_OPT_OUT":
      return "Unsigned";
    case "SIGNING_UNAVAILABLE":
      return "Signing unavailable";
    case "SIGNING_FAILED":
      return "Signing failed";
    case "NOT_APPLICABLE":
      return "Not applicable";
    default:
      return "Unknown";
  }
}

export function describeVerificationPackageStatus(
  artifactStatus: ReviewWorkspaceResponse["artifactStatus"],
  included: boolean
): string {
  if (artifactStatus.verificationPackage.available) return "Available";
  if (artifactStatus.verificationPackage.blocked) return "Blocked";
  if (artifactStatus.verificationPackage.pending) return "Pending";
  if (artifactStatus.verificationPackage.unavailable) return "Unavailable";
  return included ? "Not generated" : "Not included on plan";
}

export function describePackageManifestStatus(
  artifactStatus: ReviewWorkspaceResponse["artifactStatus"],
  included: boolean
): string {
  if (artifactStatus.verificationPackage.available) {
    return artifactStatus.verificationPackage.manifestSignature?.status === "SIGNED"
      ? "Signed manifest present"
      : "Unknown";
  }
  if (artifactStatus.verificationPackage.blocked) return "Blocked";
  if (artifactStatus.verificationPackage.pending) return "Pending";
  return included ? "Unknown" : "Not included on plan";
}

export function describeOtsStatus(
  workspace: ReviewWorkspaceResponse
): { label: string; detail: string } {
  const ots = workspace.preservationMatrix.ots;

  switch (ots.effectiveStatus) {
    case "ANCHORED":
      return {
        label: "Anchored",
        detail: "OpenTimestamps anchoring is recorded for this evidence item.",
      };
    case "FAILED":
      return {
        label: "Failed",
        detail:
          ots.failureReason || "OpenTimestamps anchoring failed for this evidence item.",
      };
    case "DISABLED":
      return {
        label: "Disabled",
        detail: "OpenTimestamps anchoring is disabled for this evidence item.",
      };
    case "PENDING":
      return {
        label: "Pending public anchoring",
        detail:
          ots.pendingReason ||
          "OpenTimestamps proof is recorded, but public anchoring has not finalized yet.",
      };
    default:
      return {
        label: "Not configured",
        detail: "No OpenTimestamps anchoring state is recorded in the current response.",
      };
  }
}

export function isOtsTerminal(status: string | null | undefined): boolean {
  return (
    status === null ||
    status === "ANCHORED" ||
    status === "FAILED" ||
    status === "DISABLED"
  );
}

export function shouldPollArtifactReadiness(
  workspace: ReviewWorkspaceResponse | null | undefined
): boolean {
  if (!workspace?.evidence?.status) return false;

  const status = workspace.evidence.status;
  const finalized = status === "SIGNED" || status === "REPORTED";
  if (!finalized) return false;

  const caps = workspace.workspaceCapabilitySnapshot;
  const reportReachable =
    caps?.reportsIncluded !== false ||
    workspace.artifactStatus.report.available === true;
  const packageReachable =
    caps?.verificationPackageIncluded !== false ||
    workspace.artifactStatus.verificationPackage.available === true;

  const reportNeedsRefresh =
    reportReachable && !workspace.artifactStatus.report.available;
  const verificationPackage = workspace.artifactStatus.verificationPackage;
  const packageNeedsRefresh =
    packageReachable &&
    !verificationPackage.available &&
    !verificationPackage.blocked &&
    !verificationPackage.unavailable;

  return reportNeedsRefresh || packageNeedsRefresh;
}

export function buildTechnicalReadinessSummary(workspace: ReviewWorkspaceResponse): string {
  if (
    workspace.reviewDecision.label === "Ready for review" &&
    !workspace.reviewWorkflow.status
  ) {
    return "Evidence is technically ready; no reviewer workflow has started yet.";
  }

  return workspace.reviewDecision.summary;
}

export async function tryDownloadFile(url: string, filename: string) {
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

export function buildRiskSignals(sourceContext: SourceContext, alerts: ReviewerAlert[]) {
  const signals: Array<{ severity: string; title: string; detail: string }> = alerts.map(
    (alert) => ({
      severity: alert.severity,
      title: alert.label,
      detail: alert.detail,
    }),
  );

  if (sourceContext.clientSignalsSummary.screenshotLikeStatus === "DETECTED") {
    signals.push({
      severity: "warning",
      title: "Screenshot filename heuristic",
      detail:
        "Filename and client-metadata heuristic only. This is advisory, not image-forensic or AI proof.",
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

// ---------------------------------------------------------------------------
// Reusable display components (PreviewWorkspace, KeyValueGrid,
// CaptureTemplateCard, EventTimeline). Logic verbatim from the
// pre-decomposition page.tsx.
// ---------------------------------------------------------------------------

export function PreviewWorkspace({
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
          const itemWithMeta = item as typeof item & {
            privateRole?: string | null;
            sourceLabel?: string | null;
          };
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
              {itemWithMeta.privateRole ? (
                <div
                  className="evidence-detail-definition-inline"
                  data-content-item-private-role
                >
                  <span>Capture role (private)</span>
                  <strong>{itemWithMeta.privateRole}</strong>
                </div>
              ) : null}
              {itemWithMeta.sourceLabel ? (
                <div
                  className="evidence-detail-definition-inline"
                  data-content-item-source-label
                >
                  <span>Source</span>
                  <strong>{itemWithMeta.sourceLabel}</strong>
                </div>
              ) : null}
              {privateItemNote ? (
                <div
                  className="evidence-detail-definition-inline"
                  data-content-item-private-note
                >
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

export function KeyValueGrid({ items }: { items: Array<{ label: string; value: string }> }) {
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

export function CaptureTemplateCard({
  intakePlanJson,
  contentItems,
}: {
  intakePlanJson: unknown;
  contentItems: Array<{ checklistStepId?: string | null }>;
}) {
  if (!intakePlanJson || typeof intakePlanJson !== "object") return null;
  const plan = intakePlanJson as Record<string, unknown>;
  const templateName =
    typeof plan.templateName === "string" ? plan.templateName : null;
  const templateId =
    typeof plan.templateId === "string" ? plan.templateId : null;
  const mode = typeof plan.mode === "string" ? plan.mode : null;
  const locationRequirement =
    typeof plan.locationRequirement === "string"
      ? plan.locationRequirement
      : null;
  const required = Array.isArray(plan.requiredSteps)
    ? (plan.requiredSteps as Array<{ id?: string; title?: string }>)
    : [];
  const optional = Array.isArray(plan.optionalSteps)
    ? (plan.optionalSteps as Array<{ id?: string; title?: string }>)
    : [];

  if (!templateName && !templateId && required.length === 0 && optional.length === 0) {
    return null;
  }

  const mappedIds = new Set<string>();
  for (const it of contentItems) {
    if (it.checklistStepId) mappedIds.add(it.checklistStepId);
  }
  const requiredMappedCount = required.filter(
    (s) => s.id && mappedIds.has(s.id),
  ).length;
  const requiredMissing = required.filter(
    (s) => s.id && !mappedIds.has(s.id),
  );

  return (
    <section
      className="evidence-detail-section"
      data-evidence-section="capture-template"
    >
      <div className="evidence-detail-section-header">
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 650 }}>
          Capture template
        </h3>
      </div>
      <KeyValueGrid
        items={[
          { label: "Template", value: templateName || templateId || "Not recorded" },
          {
            label: "Mode",
            value:
              mode === "CHECKLIST_REQUIRED"
                ? "Checklist required"
                : mode === "FLEXIBLE"
                  ? "Flexible"
                  : (mode ?? "Not recorded"),
          },
          {
            label: "Required steps mapped",
            value:
              required.length === 0
                ? "None declared"
                : `${requiredMappedCount} of ${required.length}`,
          },
          {
            label: "Optional steps declared",
            value: optional.length === 0 ? "None" : String(optional.length),
          },
          {
            label: "Location",
            value:
              locationRequirement === "required"
                ? "Required"
                : locationRequirement === "recommended"
                  ? "Recommended"
                  : locationRequirement === "optional"
                    ? "Optional"
                    : "Not recorded",
          },
        ]}
      />
      {requiredMissing.length > 0 ? (
        <div
          data-capture-template-missing
          style={{
            marginTop: 8,
            padding: "8px 10px",
            background: "#fef3c7",
            border: "1px solid #fcd34d",
            borderRadius: 6,
            fontSize: 12.5,
            color: "#78350f",
          }}
        >
          <strong>Unmapped required step{requiredMissing.length === 1 ? "" : "s"}:</strong>{" "}
          {requiredMissing.map((s) => s.title || s.id || "Untitled").join(" · ")}
        </div>
      ) : null}
    </section>
  );
}

export function EventTimeline({
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

/**
 * Phase EVIDENCE-IA — grouped lifecycle timeline view.
 *
 * Default summary buckets repeated event types by day so the user
 * doesn't see "REPORT_DOWNLOADED × 47" as 47 rows. The raw event log
 * remains accessible via a "Show raw events" `<details>` expander
 * (Phase 1 deduplication + Custody recommendation in the audit).
 */
export function GroupedEventTimeline({
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
  const grouped = useMemo(() => {
    const buckets = new Map<
      string,
      Map<string, { count: number; lastAtUtc: string }>
    >();

    for (const ev of events) {
      // Day key derived from atUtc; falls back to "Undated" if the
      // event has no timestamp. The ISO date prefix (YYYY-MM-DD) is
      // stable and sortable.
      const day = ev.atUtc?.slice(0, 10) || "Undated";
      const byType = buckets.get(day) ?? new Map();
      const prev = byType.get(ev.eventType);
      byType.set(ev.eventType, {
        count: (prev?.count ?? 0) + 1,
        lastAtUtc: prev?.lastAtUtc && prev.lastAtUtc > (ev.atUtc ?? "")
          ? prev.lastAtUtc
          : ev.atUtc ?? "",
      });
      buckets.set(day, byType);
    }

    // Sort days descending (newest first).
    return Array.from(buckets.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [events]);

  return (
    <section className="evidence-detail-section">
      <div className="evidence-detail-section-header">
        <SectionHeading kicker={title} title={subtitle} icon={icon} />
      </div>

      {events.length === 0 ? (
        <p className="evidence-detail-muted">No events recorded in the current API response.</p>
      ) : (
        <div className="evidence-detail-timeline" data-grouped-timeline>
          {grouped.map(([day, byType]) => (
            <article key={day} className="evidence-detail-timeline-item">
              <div className="evidence-detail-timeline-dot" aria-hidden="true" />
              <div>
                <div className="evidence-detail-item-row">
                  <strong>
                    {day === "Undated"
                      ? "Undated"
                      : formatUserDateTime(`${day}T00:00:00Z`).split(",")[0]}
                  </strong>
                  <span>{Array.from(byType.values()).reduce((s, b) => s + b.count, 0)} events</span>
                </div>
                <ul style={{ margin: "4px 0 0 0", paddingLeft: 18, fontSize: 13 }}>
                  {Array.from(byType.entries()).map(([type, b]) => (
                    <li key={type}>
                      {type.replace(/_/g, " ")} × {b.count}
                      {b.lastAtUtc ? (
                        <span className="evidence-detail-muted" style={{ marginLeft: 6 }}>
                          (most recent {formatUserDateTime(b.lastAtUtc)})
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
        </div>
      )}

      {events.length > 0 ? (
        <details data-grouped-timeline-raw style={{ marginTop: 10 }}>
          <summary className="evidence-detail-raw-summary">Show raw events</summary>
          <div className="evidence-detail-timeline" style={{ marginTop: 8 }}>
            {events.map((event) => (
              <article
                key={`${event.sequence}-${event.eventType}`}
                className="evidence-detail-timeline-item"
              >
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
        </details>
      ) : null}
    </section>
  );
}
