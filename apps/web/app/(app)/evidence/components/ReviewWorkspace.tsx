import type { CaseOption, DetailWorkspaceState, EvidenceListItem } from "../lib/evidence-library-types";
import { buildReviewAlerts, buildReviewPriority } from "../lib/evidence-library-alerts";
import { hasPublicVerification } from "../lib/evidence-library-helpers";
import { ReviewWorkspaceHeader } from "./ReviewWorkspaceHeader";
import { ReviewAlerts } from "./ReviewAlerts";
import { ArtifactPanel } from "./ArtifactPanel";
import { ReviewSurface } from "./ReviewSurface";
import { IntegrityPanel } from "./IntegrityPanel";
import { CustodyPanel } from "./CustodyPanel";
import { MetadataPanel } from "./MetadataPanel";
import { ReviewerNotesPanel } from "./ReviewerNotesPanel";
import { AiReviewPanel } from "./AiReviewPanel";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { Button, Card } from "../../../../components/ui";
import { formatUtcDateTime, safeText } from "../lib/evidence-library-formatters";

export function ReviewWorkspace({
  item,
  detail,
  loading,
  error,
  availableCases,
  selectedCaseId,
  assigningCase,
  removingCase,
  onChangeCase,
  onAssignCase,
  onRemoveCase,
  onOpenRecord,
  onDownloadReport,
  onDownloadVerificationPackage,
  onCopyVerificationLink,
}: {
  item: EvidenceListItem | null;
  detail: DetailWorkspaceState | null;
  loading: boolean;
  error: string | null;
  availableCases: CaseOption[];
  selectedCaseId: string;
  assigningCase: boolean;
  removingCase: boolean;
  onChangeCase: (value: string) => void;
  onAssignCase: () => void;
  onRemoveCase: () => void;
  onOpenRecord: () => void;
  onDownloadReport: () => void;
  onDownloadVerificationPackage: () => void;
  onCopyVerificationLink: () => void;
}) {
  if (!item) {
    return (
      <Card className="evidence-library-review-shell">
        <EmptyState
          title="Select an evidence record"
          description="Review preserved content, technical integrity state, custody chronology, and export readiness without leaving the library."
        />
      </Card>
    );
  }

  if (loading) {
    return (
      <Card className="evidence-library-review-shell">
        <div className="evidence-library-skeleton-stack evidence-library-skeleton-stack--workspace">
          <div className="evidence-library-skeleton-block" />
          <div className="evidence-library-skeleton-block" />
          <div className="evidence-library-skeleton-block" />
        </div>
      </Card>
    );
  }

  if (error || !detail) {
    return (
      <Card className="evidence-library-review-shell">
        <ErrorState
          title="Review workspace unavailable"
          description={error || "The selected record could not be loaded for reviewer inspection."}
        />
      </Card>
    );
  }

  const alerts = buildReviewAlerts(item, detail);
  const reviewerDecision = detail.evidence?.evidenceIntelligence?.reviewerDecision ?? null;
  const priority = buildReviewPriority(item, detail);
  const canCopyVerificationLink = hasPublicVerification(detail);

  return (
    <Card className="evidence-library-review-shell">
      <ReviewWorkspaceHeader
        item={item}
        detail={detail}
        onOpenRecord={onOpenRecord}
        onCopyVerificationLink={onCopyVerificationLink}
        canCopyVerificationLink={canCopyVerificationLink}
      />

      <section className="evidence-library-panel">
        <div className="evidence-library-panel__header">
          <div>
            <strong>Selected evidence summary</strong>
            <p>First-screen summary is optimized for reviewer triage rather than raw forensic detail.</p>
          </div>
        </div>

        <div className="evidence-library-key-grid">
          <div className="evidence-library-key-card">
            <span>Reviewer priority</span>
            <strong>{priority.label}</strong>
            <p>{reviewerDecision?.summary ?? "No reviewer summary is recorded for this selection."}</p>
          </div>
          <div className="evidence-library-key-card">
            <span>Case assignment</span>
            <strong>{detail.caseName ?? "Unassigned"}</strong>
            <p>{detail.capabilities.workspaceName}</p>
          </div>
          <div className="evidence-library-key-card">
            <span>Review-ready marker</span>
            <strong>
              {detail.evidence?.reviewReadyAtUtc || item.reviewReadyAtUtc
                ? "Recorded"
                : "Not recorded"}
            </strong>
            <p>
              {(detail.evidence?.reviewReadyAtUtc || item.reviewReadyAtUtc)
                ? formatUtcDateTime(detail.evidence?.reviewReadyAtUtc ?? item.reviewReadyAtUtc)
                : "The backend has not recorded a review-ready timestamp for this record."}
            </p>
          </div>
        </div>
      </section>

      <ReviewAlerts
        alerts={alerts}
        nextActions={reviewerDecision?.nextActions ?? []}
      />

      <ArtifactPanel
        item={item}
        detail={detail}
        evidenceId={item.id}
        teamId={item.teamId ?? null}
        onDownloadReport={onDownloadReport}
        onDownloadVerificationPackage={onDownloadVerificationPackage}
        onCopyVerificationLink={onCopyVerificationLink}
      />

      <ReviewSurface item={item} detail={detail} onOpenRecord={onOpenRecord} />
      <IntegrityPanel item={item} detail={detail} />
      <CustodyPanel item={item} detail={detail} />
      <MetadataPanel item={item} detail={detail} />

      <section className="evidence-library-panel">
        <div className="evidence-library-panel__header">
          <div>
            <strong>Case workflow</strong>
            <p>Case assignment uses the existing cases API only.</p>
          </div>
        </div>

        <div className="evidence-library-case-toolbar">
          <select value={selectedCaseId} onChange={(event) => onChangeCase(event.target.value)}>
            <option value="">Select case</option>
            {availableCases.map((caseOption) => (
              <option key={caseOption.id} value={caseOption.id}>
                {caseOption.name}
              </option>
            ))}
          </select>
          <Button onClick={onAssignCase} disabled={!selectedCaseId || assigningCase || availableCases.length === 0}>
            {assigningCase ? "Assigning..." : "Assign Case"}
          </Button>
          <Button onClick={onRemoveCase} variant="secondary" disabled={!item.caseId || removingCase}>
            {removingCase ? "Removing..." : "Remove Case"}
          </Button>
        </div>

        {availableCases.length === 0 ? (
          <p className="evidence-library-muted">No accessible cases are available for assignment in this workspace.</p>
        ) : null}
      </section>

      <ReviewerNotesPanel item={item} detail={detail} />
      <AiReviewPanel detail={detail} />

      <section className="evidence-library-panel">
        <details className="evidence-library-technical-details">
          <summary>Raw technical details</summary>
          <div className="evidence-library-definition-grid">
            <div><span>File SHA-256</span><strong>{safeText(detail.evidence?.fileSha256, "Not recorded")}</strong></div>
            <div><span>Fingerprint hash</span><strong>{safeText(detail.evidence?.fingerprintHash, "Not recorded")}</strong></div>
            <div><span>Signing key ID</span><strong>{safeText(detail.evidence?.signingKeyId, "Not recorded")}</strong></div>
            <div><span>Verification package version</span><strong>{detail.evidence?.verificationPackageVersion ? `v${detail.evidence.verificationPackageVersion}` : "Not recorded"}</strong></div>
            <div><span>Report version</span><strong>{detail.evidence?.latestReportVersion ? `v${detail.evidence.latestReportVersion}` : "Not recorded"}</strong></div>
            <div><span>Retention until</span><strong>{formatUtcDateTime(detail.evidence?.retentionUntilUtc ?? null)}</strong></div>
          </div>
        </details>
      </section>
    </Card>
  );
}
