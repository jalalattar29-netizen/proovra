import { Button } from "../../../../components/ui";
import { GovernedExportAction } from "../../../../components/governance/GovernedExportAction";
import type { DetailWorkspaceState, EvidenceListItem } from "../lib/evidence-library-types";
import { buildReportAvailability, buildVerificationPackageAvailability, hasPublicVerification } from "../lib/evidence-library-helpers";
import { formatUtcDateTime } from "../lib/evidence-library-formatters";

export function ArtifactPanel({
  item,
  detail,
  onDownloadReport,
  onDownloadVerificationPackage,
  onCopyVerificationLink,
  /**
   * Phase G3 (G2.x closure) — evidenceId + teamId are required to
   * route the Report PDF / Verification Package ZIP download buttons
   * through GovernedExportAction. When omitted, the panel degrades
   * to the legacy disabled-when-unavailable behavior.
   */
  evidenceId,
  teamId,
}: {
  item: EvidenceListItem;
  detail: DetailWorkspaceState;
  onDownloadReport: () => void;
  onDownloadVerificationPackage: () => void;
  onCopyVerificationLink: () => void;
  evidenceId?: string | null;
  teamId?: string | null;
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
          <span>Report PDF readiness</span>
          <strong>{report.label}</strong>
          <p>
            {detail.report?.generatedAtUtc
              ? `Generated ${formatUtcDateTime(detail.report.generatedAtUtc)}`
              : item.latestReportVersion
                ? `Report version ${item.latestReportVersion} is recorded in list data.`
                : "No generated Report PDF is recorded in the loaded data."}
          </p>
          {/* Phase A2 — PDF artifact signature badge. Rendered ONLY
              from the bounded backend status. The badge text never
              implies the EVIDENCE is verified — it describes the PDF
              artifact's signature only. */}
          {detail.report?.pdfSignature ? (
            detail.report.pdfSignature.status === "SIGNED" ? (
              <span
                className="evidence-library-pill success"
                title="Signed PDF artifact"
              >
                Signed Report PDF
                {detail.report.pdfSignature.signedAtUtc
                  ? ` · ${formatUtcDateTime(detail.report.pdfSignature.signedAtUtc)}`
                  : ""}
              </span>
            ) : (
              <span
                className="evidence-library-pill warning"
                title={detail.report.pdfSignature.warning ?? undefined}
              >
                Unsigned Report PDF artifact
              </span>
            )
          ) : null}
        </div>

        <div className="evidence-library-key-card">
          <span>Verification Package ZIP</span>
          <strong>{verificationPackage.label}</strong>
          <p>
            {detail.verificationPackage?.generatedAtUtc
              ? `Generated ${formatUtcDateTime(detail.verificationPackage.generatedAtUtc)}`
              : "Verification Package ZIP state is confirmed only when the detail endpoint returns an artifact."}
          </p>
          {/* Phase A2 — package manifest signature badge. Distinct
              from PDF signature; the package is verified via the
              Ed25519 manifest signature in
              the ZIP, independent of any PDF artifact signature. */}
          {detail.verificationPackage?.manifestSignature ? (
            detail.verificationPackage.manifestSignature.status === "SIGNED" ? (
              <span
                className="evidence-library-pill success"
                title="Verification Package manifest carries an Ed25519 signature"
              >
                Package manifest signed
              </span>
            ) : (
              <span className="evidence-library-pill warning">
                Package manifest signature unavailable
              </span>
            )
          ) : null}
        </div>

        <div className="evidence-library-key-card">
          <span>Public verification</span>
          <strong>{canCopyLink ? "Enabled" : "Not configured"}</strong>
          <p>
            {canCopyLink
              ? "Verification link can be copied."
              : "Public verification is not configured for this record in the current workspace view."}
          </p>
        </div>
      </div>

      <div className="evidence-library-panel__actions">
        {/* Phase G3 (G2.x closure) — Report PDF + Verification Package
            ZIP downloads now route through GovernedExportAction. The
            wrapper consults `/v1/governance/export-eligibility` BEFORE
            the operator can click; blocked outcomes render the reason
            + next-step copy verbatim. A2 vocabulary preserved — Report
            PDF and Verification Package ZIP are NEVER collapsed. */}
        {evidenceId && teamId ? (
          <>
            <GovernedExportAction
              evidenceId={evidenceId}
              teamId={teamId}
              actionLabel="Download Report PDF"
              compactWhenAllowed
              onAction={onDownloadReport}
              renderAction={({ disabled, onClick }) => (
                <Button
                  onClick={onClick}
                  disabled={
                    disabled ||
                    !detail.capabilities.reportsIncluded ||
                    !report.available
                  }
                >
                  Download Report PDF
                </Button>
              )}
            />
            <GovernedExportAction
              evidenceId={evidenceId}
              teamId={teamId}
              actionLabel="Download Verification Package ZIP"
              compactWhenAllowed
              onAction={onDownloadVerificationPackage}
              renderAction={({ disabled, onClick }) => (
                <Button
                  onClick={onClick}
                  variant="secondary"
                  disabled={
                    disabled ||
                    !detail.capabilities.verificationPackageIncluded ||
                    !verificationPackage.available
                  }
                >
                  Download Verification Package ZIP
                </Button>
              )}
            />
          </>
        ) : (
          <>
            <Button
              onClick={onDownloadReport}
              disabled={!detail.capabilities.reportsIncluded || !report.available}
            >
              Download Report PDF
            </Button>
            <Button
              onClick={onDownloadVerificationPackage}
              variant="secondary"
              disabled={
                !detail.capabilities.verificationPackageIncluded ||
                !verificationPackage.available
              }
            >
              Download Verification Package ZIP
            </Button>
          </>
        )}
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
