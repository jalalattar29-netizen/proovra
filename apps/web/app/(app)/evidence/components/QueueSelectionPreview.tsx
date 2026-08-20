"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  Lock,
  MinusCircle,
  Link2Off,
  X,
} from "lucide-react";
import { Modal } from "../../../../components/cases-experience/matter-modals/Modal";
import type {
  DetailWorkspaceState,
  EvidenceContentItem,
  EvidenceListItem,
} from "../lib/evidence-library-types";
import {
  buildReportAvailability,
  buildVerificationPackageAvailability,
  hasPublicVerification,
} from "../lib/evidence-library-helpers";
import {
  formatUtcDateTime,
  shortId,
  splitUtcDateTime,
} from "../lib/evidence-library-formatters";
import {
  getDisplayTitle,
  getEvidenceTypeLabel,
  getRecordStatusLabel,
  getStatusBadgeTone,
  getVerificationStatusLabel,
} from "../lib/evidence-library-status";
import { ProovraSystemState } from "../../../../components/feedback/ProovraSystemState";
import type { AppTone } from "../../../../components/app-primitives";

/**
 * Queue selection Inspector — Evidence Library, Part 3.
 *
 * ONE implementation, TWO hosts. `presentation="panel"` renders the
 * desktop right-hand column; `presentation="hosted"` renders the SAME
 * body and footer inside the canonical app dialog
 * (`matter-modals/Modal`, `.app-dialog` anatomy) for tablet and mobile.
 * There is deliberately no second mobile Inspector and no
 * Evidence-only modal system.
 *
 * Every state below is derived from REAL projected record data:
 * capability flags, artifact projections, the anchor summary and the
 * record content-access policy. Nothing renders "ready" unless the
 * record data says so, and every absent value renders an explicit
 * placeholder instead of an invented one.
 */

/* ==========================================================================
 * Artifact state model — report / verification package / public verification
 * ======================================================================== */

type ArtifactState =
  | "available"
  | "pending"
  | "missing"
  | "failed"
  | "disabled"
  | "restricted"
  | "not-configured";

type ArtifactRow = {
  key: string;
  title: string;
  state: ArtifactState;
  detail: string;
};

const STATE_LABEL: Record<ArtifactState, string> = {
  available: "Available",
  pending: "Generating",
  missing: "Not recorded",
  failed: "Failed",
  disabled: "Not in plan",
  restricted: "Restricted",
  "not-configured": "Not configured",
};

const STATE_TONE: Record<ArtifactState, AppTone> = {
  available: "green",
  pending: "indigo",
  missing: "slate",
  failed: "red",
  disabled: "slate",
  restricted: "amber",
  "not-configured": "slate",
};

function StateIcon({ state }: { state: ArtifactState }) {
  const size = 16;
  const strokeWidth = 1.9;
  switch (state) {
    case "available":
      return <CheckCircle2 size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
    case "pending":
      return <Clock3 size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
    case "failed":
      return <AlertTriangle size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
    case "disabled":
      return <Ban size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
    case "restricted":
      return <Lock size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
    case "not-configured":
      return <Link2Off size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
    default:
      return <MinusCircle size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
  }
}

function buildReportRow(item: EvidenceListItem, detail: DetailWorkspaceState): ArtifactRow {
  const availability = buildReportAvailability(item, detail);
  const signature = detail.report?.pdfSignature ?? null;

  if (!detail.capabilities.reportsIncluded) {
    return {
      key: "report",
      title: "Report",
      state: "disabled",
      detail: "PDF reports are not included in this workspace plan.",
    };
  }

  if (signature?.status === "SIGNING_FAILED") {
    return {
      key: "report",
      title: "Report",
      state: "failed",
      detail:
        signature.warning?.trim() ||
        "The report artifact was produced but its signature step failed.",
    };
  }

  if (detail.report?.url && detail.report?.generatedAtUtc) {
    return {
      key: "report",
      title: "Report available",
      state: "available",
      detail: `Generated ${formatUtcDateTime(detail.report.generatedAtUtc)}`,
    };
  }

  if (availability.available) {
    return {
      key: "report",
      title: "Report",
      state: "pending",
      detail: "The record is marked report-ready. The artifact is not yet projected here.",
    };
  }

  return {
    key: "report",
    title: "Report",
    state: "missing",
    detail: "No generated report is recorded for this record.",
  };
}

function buildPackageRow(detail: DetailWorkspaceState): ArtifactRow {
  const availability = buildVerificationPackageAvailability(detail);

  if (!detail.capabilities.verificationPackageIncluded) {
    return {
      key: "package",
      title: "Verification package",
      state: "disabled",
      detail: "Verification packages are not included in this workspace plan.",
    };
  }

  if (availability.available) {
    const generatedAt = detail.verificationPackage?.generatedAtUtc;
    return {
      key: "package",
      title: "Verification package ready",
      state: "available",
      detail: generatedAt
        ? `Generated ${formatUtcDateTime(generatedAt)}`
        : `Package version ${detail.verificationPackage?.version ?? "recorded"}.`,
    };
  }

  if (detail.evidence?.verificationPackageGeneratedAtUtc) {
    return {
      key: "package",
      title: "Verification package",
      state: "pending",
      detail: "The record reports a package build. The artifact is not yet projected here.",
    };
  }

  return {
    key: "package",
    title: "Verification package",
    state: "missing",
    detail: "No verification package is recorded for this record.",
  };
}

function buildPublicVerificationRow(detail: DetailWorkspaceState): ArtifactRow {
  const anchor = detail.evidence?.anchor ?? null;

  if (!detail.capabilities.publicVerifyIncluded) {
    return {
      key: "public-verification",
      title: "Public verification",
      state: "disabled",
      detail: "Public verification is not included in this workspace plan.",
    };
  }

  if (!anchor?.configured || anchor.mode === "off") {
    return {
      key: "public-verification",
      title: "Public verification",
      state: "not-configured",
      detail: "Not configured for this record.",
    };
  }

  if (anchor.mode === "active" && anchor.anchoredAtUtc) {
    return {
      key: "public-verification",
      title: "Public verification",
      state: "available",
      detail: `Anchored ${formatUtcDateTime(anchor.anchoredAtUtc)}`,
    };
  }

  return {
    key: "public-verification",
    title: "Public verification",
    state: "pending",
    detail: "The anchor is configured. No anchored timestamp is recorded yet.",
  };
}

function ArtifactStatusRow({ row }: { row: ArtifactRow }) {
  return (
    <li
      className="evidence-library-artifact"
      data-evidence-artifact={row.key}
      data-state={row.state}
    >
      {/* The icon tile reuses the CANONICAL badge tone rules, so the icon and
          the badge beside it can never disagree about a state colour. */}
      <span
        className="app-status-badge evidence-library-artifact__icon"
        data-tone={STATE_TONE[row.state]}
      >
        <StateIcon state={row.state} />
      </span>
      <span className="evidence-library-artifact__text">
        <strong className="evidence-library-artifact__title">{row.title}</strong>
        <span className="app-hint">{row.detail}</span>
      </span>
      {/* The state is announced to assistive tech but is carried VISUALLY by
          the icon tone and the card treatment, matching the reference, which
          has no trailing pill on these rows. */}
      <span className="app-visually-hidden">{STATE_LABEL[row.state]}</span>
    </li>
  );
}

/* ==========================================================================
 * Preview
 * ======================================================================== */

type PreviewResolution =
  | { kind: "restricted" }
  | { kind: "unavailable" }
  | { kind: "unsupported"; item: EvidenceContentItem }
  | { kind: "renderable"; item: EvidenceContentItem; url: string };

function resolvePreview(detail: DetailWorkspaceState): PreviewResolution {
  const evidence = detail.evidence;
  const policy = evidence?.contentAccessPolicy ?? null;

  // REAL restriction signal: the record own content-access policy.
  if (policy && (policy.mode === "metadata_only" || policy.allowContentView === false)) {
    return { kind: "restricted" };
  }

  const previewItem =
    evidence?.contentItems?.find(
      (contentItem) => contentItem.id === evidence?.defaultPreviewItemId
    ) ??
    evidence?.primaryContentItem ??
    evidence?.contentItems?.find((contentItem) => contentItem.previewable) ??
    null;

  if (!previewItem) return { kind: "unavailable" };
  if (!previewItem.previewable) return { kind: "unsupported", item: previewItem };
  // The server considers the item previewable but issued no view URL,
  // so access was not granted for this projection. Reported honestly.
  if (!previewItem.viewUrl) return { kind: "restricted" };
  if (previewItem.kind === "other") return { kind: "unsupported", item: previewItem };

  return { kind: "renderable", item: previewItem, url: previewItem.viewUrl };
}

function PreviewNotice({
  tone,
  title,
  message,
  testId,
}: {
  tone: "muted" | "warn";
  title: string;
  message: string;
  testId: string;
}) {
  return (
    <div
      className="evidence-library-preview__notice"
      data-tone={tone}
      data-evidence-preview-state={testId}
    >
      <strong>{title}</strong>
      <p className="app-hint">{message}</p>
    </div>
  );
}

function PreviewMedia({
  item,
  detail,
}: {
  item: EvidenceListItem;
  detail: DetailWorkspaceState;
}) {
  const resolution = resolvePreview(detail);
  const accessibleName =
    (resolution.kind === "renderable" || resolution.kind === "unsupported"
      ? resolution.item.originalFileName?.trim() || resolution.item.label?.trim()
      : null) || getDisplayTitle(detail.evidence ?? item);

  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const renderableUrl = resolution.kind === "renderable" ? resolution.url : null;

  // A newly selected record must never inherit the previous record load state.
  useEffect(() => {
    setLoadState("loading");
  }, [renderableUrl]);

  if (resolution.kind === "restricted") {
    return (
      <PreviewNotice
        tone="warn"
        title="Preview restricted"
        message="The content-access policy on this record does not grant preserved-content preview here. Metadata and integrity state remain available."
        testId="restricted"
      />
    );
  }

  if (resolution.kind === "unavailable") {
    return (
      <PreviewNotice
        tone="muted"
        title="No preview available"
        message="No previewable preserved content is projected for this record in queue view."
        testId="unavailable"
      />
    );
  }

  if (resolution.kind === "unsupported") {
    return (
      <PreviewNotice
        tone="muted"
        title="Preview not supported"
        message={`${accessibleName} cannot be previewed in queue view. Open the evidence record for full preserved-content review.`}
        testId="unsupported"
      />
    );
  }

  if (loadState === "error") {
    return (
      <PreviewNotice
        tone="warn"
        title="Preview could not be loaded"
        message={`${accessibleName} did not load. Open the evidence record to review the preserved content directly.`}
        testId="error"
      />
    );
  }

  return (
    <div
      className="evidence-library-preview__frame"
      data-loading={loadState === "loading" ? "true" : undefined}
    >
      {loadState === "loading" ? (
        <span className="app-skeleton evidence-library-preview__skeleton" aria-hidden="true" />
      ) : null}
      {resolution.item.kind === "image" ? (
        <img
          src={resolution.url}
          alt={accessibleName}
          data-evidence-preview-state="image"
          onLoad={() => setLoadState("ready")}
          onError={() => setLoadState("error")}
        />
      ) : resolution.item.kind === "video" ? (
        <video
          src={resolution.url}
          controls
          preload="metadata"
          aria-label={accessibleName}
          data-evidence-preview-state="video"
          onLoadedMetadata={() => setLoadState("ready")}
          onError={() => setLoadState("error")}
        />
      ) : resolution.item.kind === "audio" ? (
        <audio
          src={resolution.url}
          controls
          preload="metadata"
          aria-label={accessibleName}
          data-evidence-preview-state="audio"
          onLoadedMetadata={() => setLoadState("ready")}
          onError={() => setLoadState("error")}
        />
      ) : (
        <iframe
          src={resolution.url}
          title={accessibleName}
          data-evidence-preview-state="document"
          onLoad={() => setLoadState("ready")}
          onError={() => setLoadState("error")}
        />
      )}
    </div>
  );
}

/* ==========================================================================
 * Inspector
 * ======================================================================== */

/** Stable ids so a disabled download can point at its own reason. */
const REPORT_REASON_ID = "evidence-inspector-report-reason";
const PACKAGE_REASON_ID = "evidence-inspector-package-reason";

const INSPECTOR_TITLE = "Queue selection";
const INSPECTOR_SUPPORT =
  "An operational preview of the selected record. The full review workspace opens from the Evidence record.";

export function QueueSelectionPreview({
  item,
  detail,
  loading,
  error,
  caseName,
  canSeeReviewerOps = true,
  presentation = "panel",
  onClose,
  onOpenRecord,
  onDownloadReport,
  onDownloadVerificationPackage,
  onCopyVerificationLink,
}: {
  item: EvidenceListItem | null;
  detail: DetailWorkspaceState | null;
  loading: boolean;
  error: string | null;
  caseName: string | null;
  /**
   * Phase EVIDENCE-LIBRARY-ENTERPRISE-GATE (FIX 6) — when false
   * (Personal Space / small-business workspaces without reviewer
   * ops), the preview hides the assigned-reviewer and due-date
   * rows since the user IS the reviewer there. Backend auth is
   * unchanged — this is visibility-only. Defaults to `true` for
   * back-compat with any caller that doesn't yet pass it.
   */
  canSeeReviewerOps?: boolean;
  /** "panel" = desktop right column. "hosted" = canonical dialog on compact widths. */
  presentation?: "panel" | "hosted";
  onClose: () => void;
  onOpenRecord: () => void;
  onDownloadReport: () => void;
  onDownloadVerificationPackage: () => void;
  onCopyVerificationLink: () => void;
}) {
  let body: ReactNode;
  let footer: ReactNode = null;

  if (!item) {
    body = (
      <div className="evidence-library-inspector__empty" data-evidence-inspector-state="empty">
        <strong>No record selected</strong>
        <p className="app-hint">
          Choose a record in the evidence queue to preview its status, integrity state and export
          readiness here.
        </p>
      </div>
    );
  } else if (loading) {
    body = (
      <div
        className="evidence-library-skeleton-stack evidence-library-skeleton-stack--workspace"
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label="Loading selected record"
        data-evidence-inspector-state="loading"
      >
        <span className="app-skeleton evidence-library-skeleton-block" />
        <span className="app-skeleton evidence-library-skeleton-block" />
      </div>
    );
  } else if (error || !detail) {
    body = (
      <ProovraSystemState
        kind="server-error"
        context="authenticated"
        presentation="contained"
        testId="queue-preview-error"
        title="Queue preview unavailable"
        message={error || "The selected queue record could not be previewed."}
      />
    );
  } else {
    const artifactRows: ArtifactRow[] = [
      buildReportRow(item, detail),
      buildPackageRow(detail),
      buildPublicVerificationRow(detail),
    ];
    const report = buildReportAvailability(item, detail);
    const verificationPackage = buildVerificationPackageAvailability(detail);
    const publicVerification = hasPublicVerification(detail);
    const title = getDisplayTitle(item);

    const reportDisabledReason = !detail.capabilities.reportsIncluded
      ? "PDF reports are not included in this workspace plan."
      : !report.available
        ? "No generated report is recorded for this record."
        : undefined;
    const packageDisabledReason = !detail.capabilities.verificationPackageIncluded
      ? "Verification packages are not included in this workspace plan."
      : !verificationPackage.available
        ? "No verification package is recorded for this record."
        : undefined;
    const linkDisabledReason = !detail.capabilities.publicVerifyIncluded
      ? "Public verification is not included in this workspace plan."
      : !publicVerification
        ? "No public verification anchor is configured for this record."
        : undefined;

    body = (
      <>
        <button
          type="button"
          className="app-secondary-action app-secondary-action--filled app-secondary-action--block"
          onClick={onOpenRecord}
          data-evidence-inspector-open
        >
          <ExternalLink size={16} strokeWidth={1.9} aria-hidden="true" />
          Open Evidence
        </button>

        <dl className="evidence-library-key-grid" data-evidence-inspector-metadata>
          <div className="evidence-library-key-card">
            <dt>Record</dt>
            <dd>
              <strong className="evidence-library-key-card__record" title={title}>
                {title}
              </strong>
              <p className="evidence-library-technical" dir="ltr">
                {shortId(item.id)}
              </p>
            </dd>
          </div>
          <div className="evidence-library-key-card" data-preview-status>
            <dt>Status</dt>
            <dd>
              <strong
                className="evidence-library-key-card__status"
                data-tone={getStatusBadgeTone(item)}
              >
                {getRecordStatusLabel(item.status)}
              </strong>
              {/* FIX 2 — surface the integrity verification state
                  directly in the preview. Previously only the type
                  label appeared here, so reviewers had to open the
                  record to see whether the integrity check flagged
                  anything. Data already on `item`, no new fetch. */}
              <p data-preview-integrity>{getVerificationStatusLabel(item.verificationStatus)}</p>
              <p className="app-hint">
                {getEvidenceTypeLabel(item)}
                {item.itemCount > 1 ? ` · ${item.itemCount} items` : ""}
              </p>
            </dd>
          </div>
          <div className="evidence-library-key-card" data-preview-case>
            <dt>Case</dt>
            <dd>
              <strong>{caseName ?? "Not assigned"}</strong>
              {/* FIX 6 — reviewer-assignment row only when reviewer-ops
                  is in scope. Personal Space hides it. */}
              {canSeeReviewerOps ? (
                <p data-preview-assigned-reviewer>
                  {item.reviewWorkflow?.assignedTo?.displayName ??
                    item.reviewWorkflow?.assignedTo?.email ??
                    "No reviewer assigned"}
                </p>
              ) : null}
            </dd>
          </div>
          <div className="evidence-library-key-card" data-preview-created>
            <dt>Created</dt>
            <dd>
              <strong className="evidence-library-technical" dir="ltr">
                {splitUtcDateTime(item.createdAt).date}
              </strong>
              {splitUtcDateTime(item.createdAt).time ? (
                <p className="evidence-library-technical" dir="ltr">
                  {splitUtcDateTime(item.createdAt).time}
                </p>
              ) : null}
              {/* FIX 6 — due-date row is enterprise-only, same gate. */}
              {canSeeReviewerOps ? (
                <p data-preview-due-date>
                  {item.reviewWorkflow?.dueAt
                    ? `Due ${formatUtcDateTime(item.reviewWorkflow.dueAt)}`
                    : "No due date recorded"}
                </p>
              ) : null}
            </dd>
          </div>
        </dl>

        <p className="evidence-library-inspector__section-label">Evidence Preview</p>
        <div className="evidence-library-preview" data-evidence-inspector-preview>
          <PreviewMedia item={item} detail={detail} />
        </div>

        <ul className="evidence-library-artifacts" data-evidence-inspector-artifacts>
          {artifactRows.map((row) => (
            <ArtifactStatusRow key={row.key} row={row} />
          ))}
        </ul>
      </>
    );

    footer = (
      <>
        {/* THE SAME CANONICAL ACTION as Case Details "Add evidence" and
            "Generate report": `app-secondary-action`, straight from
            app-primitives. These two carried a filled accent and a filled
            neutral instead, so the Evidence Inspector spoke a third action
            language for the same kind of operational control. The Evidence
            download icons stay; only the treatment is shared. The stacked
            full-width layout continues to come from the Inspector's own
            footer rule, not from the button. */}
        <button
          type="button"
          className="app-secondary-action"
          onClick={onDownloadReport}
          disabled={Boolean(reportDisabledReason)}
          title={reportDisabledReason}
          aria-describedby={reportDisabledReason ? REPORT_REASON_ID : undefined}
          data-evidence-inspector-download-report
        >
          <Download size={16} strokeWidth={1.9} aria-hidden="true" />
          Download Report
        </button>
        <button
          type="button"
          className="app-secondary-action"
          onClick={onDownloadVerificationPackage}
          disabled={Boolean(packageDisabledReason)}
          title={packageDisabledReason}
          aria-describedby={packageDisabledReason ? PACKAGE_REASON_ID : undefined}
          data-evidence-inspector-download-package
        >
          <Download size={16} strokeWidth={1.9} aria-hidden="true" />
          Download Verification Package
        </button>
        <button
          type="button"
          className="app-secondary-action"
          onClick={onCopyVerificationLink}
          disabled={Boolean(linkDisabledReason)}
          title={linkDisabledReason}
          data-evidence-inspector-copy-link
        >
          <Copy size={16} strokeWidth={1.9} aria-hidden="true" />
          Copy Verification Link
        </button>
        {/* A disabled download states WHY as text, not only in a `title`
            attribute a keyboard or screen-reader user never reaches. */}
        {reportDisabledReason ? (
          <p
            id={REPORT_REASON_ID}
            className="app-hint evidence-library-inspector__reason"
            data-evidence-inspector-reason="report"
          >
            {reportDisabledReason}
          </p>
        ) : null}
        {packageDisabledReason ? (
          <p
            id={PACKAGE_REASON_ID}
            className="app-hint evidence-library-inspector__reason"
            data-evidence-inspector-reason="package"
          >
            {packageDisabledReason}
          </p>
        ) : null}
      </>
    );
  }

  // The compact host is the CANONICAL dialog. Its own head supplies the
  // title and the close control, so the body never repeats them.
  if (presentation === "hosted") {
    return (
      <Modal
        open
        title={INSPECTOR_TITLE}
        description={INSPECTOR_SUPPORT}
        onClose={onClose}
        testid="evidence-queue-inspector"
        footer={footer}
      >
        <p className="app-hint evidence-library-inspector__support">{INSPECTOR_SUPPORT}</p>
        {body}
      </Modal>
    );
  }

  return (
    <aside
      className="evidence-library-inspector"
      aria-labelledby="evidence-inspector-title"
      data-evidence-inspector
      // The compact host gets Escape from the canonical dialog. The desktop
      // panel is NOT modal, so Escape only closes it while focus is inside.
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="evidence-library-inspector__head">
        <div className="evidence-library-inspector__close-row">
          <button
            type="button"
            className="app-ghost-action evidence-library-inspector__close"
            onClick={onClose}
            aria-label="Close queue selection"
            data-evidence-inspector-close
          >
            <X size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <h2 id="evidence-inspector-title" className="evidence-library-inspector__title">
          {INSPECTOR_TITLE}
        </h2>
        <p className="app-hint evidence-library-inspector__support">{INSPECTOR_SUPPORT}</p>
      </header>

      <div className="evidence-library-inspector__body">{body}</div>

      {footer ? <footer className="evidence-library-inspector__footer">{footer}</footer> : null}
    </aside>
  );
}
