import { Button, Card } from "../../../../components/ui";
import type { DetailWorkspaceState, EvidenceListItem } from "../lib/evidence-library-types";
import { buildReportAvailability, buildVerificationPackageAvailability, hasPublicVerification } from "../lib/evidence-library-helpers";
import { formatUtcDateTime, shortId } from "../lib/evidence-library-formatters";
import { getDisplayTitle, getEvidenceTypeLabel, getRecordStatusLabel } from "../lib/evidence-library-status";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";

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
          description="Use the queue to triage records, then open the evidence detail workspace for custody, integrity, annotations, notes, and deeper review."
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
        <ErrorState
          title="Queue preview unavailable"
          description={error || "The selected queue record could not be previewed."}
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
          <div className="evidence-library-key-card">
            <span>Status</span>
            <strong>{getRecordStatusLabel(item.status)}</strong>
            <p>{getEvidenceTypeLabel(item)}</p>
          </div>
          <div className="evidence-library-key-card">
            <span>Case</span>
            <strong>{caseName ?? "Unassigned"}</strong>
            <p>
              {item.reviewWorkflow?.assignedTo?.displayName ??
                item.reviewWorkflow?.assignedTo?.email ??
                "No reviewer assigned"}
            </p>
          </div>
          <div className="evidence-library-key-card">
            <span>Created</span>
            <strong>{formatUtcDateTime(item.createdAt)}</strong>
            <p>{item.reviewWorkflow?.dueAt ? `Due ${formatUtcDateTime(item.reviewWorkflow.dueAt)}` : "No due date recorded"}</p>
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
                ? detail.evidence?.anchor?.publicUrl || "Verification link available."
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
