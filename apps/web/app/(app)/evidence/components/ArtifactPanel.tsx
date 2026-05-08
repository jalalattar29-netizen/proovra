import { Button } from "../../../../components/ui";
import type { DetailWorkspaceState, EvidenceListItem } from "../lib/evidence-library-types";
import { buildReportAvailability, buildVerificationPackageAvailability, hasPublicVerification } from "../lib/evidence-library-helpers";
import { formatUtcDateTime, safeText } from "../lib/evidence-library-formatters";

export function ArtifactPanel({
  item,
  detail,
  onDownloadReport,
  onDownloadVerificationPackage,
  onCopyVerificationLink,
}: {
  item: EvidenceListItem;
  detail: DetailWorkspaceState;
  onDownloadReport: () => void;
  onDownloadVerificationPackage: () => void;
  onCopyVerificationLink: () => void;
}) {
  const report = buildReportAvailability(item, detail);
  const verificationPackage = buildVerificationPackageAvailability(detail);
  const canCopyLink = hasPublicVerification(detail);

  return (
    <section className="evidence-library-panel">
      <div className="evidence-library-panel__header">
        <div>
          <strong>Export and share readiness</strong>
          <p>Only supported artifacts and public verification states are surfaced as active controls.</p>
        </div>
      </div>

      <div className="evidence-library-key-grid">
        <div className="evidence-library-key-card">
          <span>Report readiness</span>
          <strong>{report.label}</strong>
          <p>
            {detail.report?.generatedAtUtc
              ? `Generated ${formatUtcDateTime(detail.report.generatedAtUtc)}`
              : item.latestReportVersion
                ? `Report version ${item.latestReportVersion} is recorded in list data.`
                : "No generated report is recorded in the loaded data."}
          </p>
        </div>

        <div className="evidence-library-key-card">
          <span>Verification package</span>
          <strong>{verificationPackage.label}</strong>
          <p>
            {detail.verificationPackage?.generatedAtUtc
              ? `Generated ${formatUtcDateTime(detail.verificationPackage.generatedAtUtc)}`
              : "Package state is confirmed only when the detail endpoint returns an artifact."}
          </p>
        </div>

        <div className="evidence-library-key-card">
          <span>Public verification</span>
          <strong>{canCopyLink ? "Enabled" : "Not configured"}</strong>
          <p>
            {canCopyLink
              ? safeText(detail.evidence?.anchor?.publicUrl, "Verification link can be copied.")
              : "Public verification is not configured for this record in the current workspace view."}
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
        <Button onClick={onCopyVerificationLink} variant="secondary" disabled={!canCopyLink}>
          Copy Verification Link
        </Button>
      </div>

      <div className="evidence-library-disabled-placeholder">
        <strong>Saved reviewer workflows</strong>
        <p>Saved views, bulk actions, and review queues are not configured for this workspace yet.</p>
      </div>
    </section>
  );
}
