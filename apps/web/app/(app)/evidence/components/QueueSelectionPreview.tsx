import { Button, Card } from "../../../../components/ui";
import { EmptyState } from "../../../../components/ui/EmptyState";
import type { DetailWorkspaceState, EvidenceListItem } from "../lib/evidence-library-types";
import { buildReportAvailability, buildVerificationPackageAvailability, hasPublicVerification } from "../lib/evidence-library-helpers";
import { formatUtcDateTime, shortId } from "../lib/evidence-library-formatters";
import {
  getDisplayTitle,
  getEvidenceTypeLabel,
  getRecordStatusLabel,
  getVerificationStatusLabel,
} from "../lib/evidence-library-status";
import { ProovraSystemState } from "../../../../components/feedback/ProovraSystemState";

function PreviewMedia({
  item,
  detail,
  onOpenRecord,
}: {
  item: EvidenceListItem;
  detail: DetailWorkspaceState;
  onOpenRecord: () => void;
}) {
  const previewItem =
    detail.evidence?.contentItems?.find(
      (contentItem) => contentItem.id === detail.evidence?.defaultPreviewItemId
    ) ??
    detail.evidence?.primaryContentItem ??
    detail.evidence?.contentItems?.find((contentItem) => contentItem.previewable) ??
    null;

  if (!previewItem?.viewUrl) {
    return (
      <div className="evidence-library-preview-placeholder evidence-library-preview-placeholder--compact">
        <strong>Preview not available in queue view</strong>
        <p>Open the evidence record for full preserved-content review.</p>
        <Button variant="secondary" onClick={onOpenRecord}>
          Open Full Record
        </Button>
      </div>
    );
  }

  switch (previewItem.kind) {
    case "image":
      return <img src={previewItem.viewUrl} alt={getDisplayTitle(detail.evidence ?? item)} />;
    case "video":
      return <video src={previewItem.viewUrl} controls preload="metadata" />;
    case "audio":
      return <audio src={previewItem.viewUrl} controls preload="metadata" />;
    case "pdf":
    case "text":
      return <iframe src={previewItem.viewUrl} title={getDisplayTitle(detail.evidence ?? item)} />;
    default:
      return (
        <div className="evidence-library-preview-placeholder evidence-library-preview-placeholder--compact">
          <strong>Preview not available in queue view</strong>
          <p>Open the evidence record for full preserved-content review.</p>
          <Button variant="secondary" onClick={onOpenRecord}>
            Open Full Record
          </Button>
        </div>
      );
  }
}

export function QueueSelectionPreview({
  item,
  detail,
  loading,
  error,
  caseName,
  canSeeReviewerOps = true,
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
  onOpenRecord: () => void;
  onDownloadReport: () => void;
  onDownloadVerificationPackage: () => void;
  onCopyVerificationLink: () => void;
}) {
  if (!item) {
    return (
      <Card className="evidence-library-review-shell evidence-library-review-shell--compact">
        <EmptyState
          title="Select a queue record"
          purpose="Use the queue to triage records, then open the evidence detail workspace for custody, integrity, annotations, notes, and deeper review."
          compact
        />
      </Card>
    );
  }

  if (loading) {
    return (
      <Card className="evidence-library-review-shell evidence-library-review-shell--compact">
        <div className="evidence-library-skeleton-stack evidence-library-skeleton-stack--workspace">
          <div className="evidence-library-skeleton-block" />
          <div className="evidence-library-skeleton-block" />
        </div>
      </Card>
    );
  }

  if (error || !detail) {
    return (
      <Card className="evidence-library-review-shell evidence-library-review-shell--compact">
        <ProovraSystemState
          kind="server-error"
          context="authenticated"
          presentation="contained"
          testId="queue-preview-error"
          title="Queue preview unavailable"
          message={error || "The selected queue record could not be previewed."}
        />
      </Card>
    );
  }

  const report = buildReportAvailability(item, detail);
  const verificationPackage = buildVerificationPackageAvailability(detail);
  const publicVerification = hasPublicVerification(detail);

  return (
    <Card className="evidence-library-review-shell evidence-library-review-shell--compact">
      <section className="evidence-library-panel evidence-library-panel--queue-preview">
        <div className="evidence-library-panel__header">
          <div>
            <strong>Queue selection</strong>
            <p>Operational preview only. Open the evidence record for the full review workspace.</p>
          </div>
          <Button variant="secondary" onClick={onOpenRecord}>
            Open Evidence
          </Button>
        </div>

        <div className="evidence-library-key-grid">
          <div className="evidence-library-key-card">
            <span>Record</span>
            <strong>{getDisplayTitle(item)}</strong>
            <p>{shortId(item.id)}</p>
          </div>
          <div className="evidence-library-key-card" data-preview-status>
            <span>Status</span>
            <strong>{getRecordStatusLabel(item.status)}</strong>
            {/* FIX 2 — surface the integrity verification state
                directly in the preview. Previously only the type
                label appeared here, so reviewers had to open the
                record to see whether the integrity check flagged
                anything. Data already on `item`, no new fetch. */}
            <p data-preview-integrity>{getVerificationStatusLabel(item.verificationStatus)}</p>
            <p>
              {getEvidenceTypeLabel(item)}
              {item.itemCount > 1 ? ` · ${item.itemCount} items` : ""}
            </p>
          </div>
          <div className="evidence-library-key-card" data-preview-case>
            <span>Case</span>
            <strong>{caseName ?? "Unassigned"}</strong>
            {/* FIX 6 — reviewer-assignment row only when reviewer-ops
                is in scope. Personal Space hides it. */}
            {canSeeReviewerOps ? (
              <p data-preview-assigned-reviewer>
                {item.reviewWorkflow?.assignedTo?.displayName ??
                  item.reviewWorkflow?.assignedTo?.email ??
                  "No reviewer assigned"}
              </p>
            ) : null}
          </div>
          <div className="evidence-library-key-card" data-preview-created>
            <span>Created</span>
            <strong>{formatUtcDateTime(item.createdAt)}</strong>
            {/* FIX 6 — due-date row is enterprise-only, same gate. */}
            {canSeeReviewerOps ? (
              <p data-preview-due-date>
                {item.reviewWorkflow?.dueAt
                  ? `Due ${formatUtcDateTime(item.reviewWorkflow.dueAt)}`
                  : "No due date recorded"}
              </p>
            ) : null}
          </div>
        </div>

        <div className="evidence-library-preview evidence-library-preview--compact">
          <PreviewMedia item={item} detail={detail} onOpenRecord={onOpenRecord} />
        </div>

        <div className="evidence-library-key-grid evidence-library-key-grid--compact">
          <div className="evidence-library-key-card">
            <span>Report</span>
            <strong>{report.label}</strong>
            <p>
              {detail.report?.generatedAtUtc
                ? `Generated ${formatUtcDateTime(detail.report.generatedAtUtc)}`
                : "No generated report recorded in this queue preview."}
            </p>
          </div>
          <div className="evidence-library-key-card">
            <span>Verification package</span>
            <strong>{verificationPackage.label}</strong>
            <p>
              {detail.verificationPackage?.generatedAtUtc
                ? `Generated ${formatUtcDateTime(detail.verificationPackage.generatedAtUtc)}`
                : "Package availability requires the detail workspace when not generated."}
            </p>
          </div>
          <div className="evidence-library-key-card">
            <span>Public verification</span>
            <strong>{publicVerification ? "Enabled" : "Not configured"}</strong>
            <p>
              {publicVerification
                ? "Verification link available."
                : "No public verification link is configured in the loaded queue preview."}
            </p>
          </div>
        </div>

        <div className="evidence-library-panel__actions">
          <Button onClick={onDownloadReport} disabled={!detail.capabilities.reportsIncluded || !report.available}>
            Download Report
          </Button>
          <Button
            onClick={onDownloadVerificationPackage}
            variant="secondary"
            disabled={!detail.capabilities.verificationPackageIncluded || !verificationPackage.available}
          >
            Download Verification Package
          </Button>
          <Button onClick={onCopyVerificationLink} variant="secondary" disabled={!publicVerification}>
            Copy Verification Link
          </Button>
        </div>
      </section>
    </Card>
  );
}
