"use client";

import { Button } from "../../../../../components/ui";
import { GovernedExportAction } from "../../../../../components/governance/GovernedExportAction";

type ArtifactHistory = {
  reports: Array<{
    id: string;
    version: number;
    generatedAtUtc: string;
    sizeBytes: string | null;
    immutableRecorded: boolean;
    latest: boolean;
  }>;
  verificationPackages: Array<{
    id: string;
    version: number;
    generatedAtUtc: string;
    packageType: string | null;
    sizeBytes: string | null;
    immutableRecorded: boolean;
    latest: boolean;
  }>;
};

export function ArtifactHistorySection({
  history,
  onDownloadReport,
  onDownloadVerificationPackage,
  formatDateTime,
  formatBytes,
  evidenceId,
  teamId,
}: {
  history: ArtifactHistory | undefined;
  onDownloadReport: () => void;
  onDownloadVerificationPackage: () => void;
  formatDateTime: (value: string | null | undefined) => string;
  formatBytes: (value: string | number | null | undefined) => string;
  /**
   * Phase 12 Point 4 (Pass E) — export-governance preflight. Both
   * "Download latest" actions consult `/v1/governance/export-eligibility`
   * BEFORE the operator can click; blocked outcomes render the gate
   * that blocked them plus its next-step copy verbatim.
   *
   * This wrapping used to live on the evidence-library `ArtifactPanel`,
   * which had been unmounted when the library preview pane moved to
   * `QueueSelectionPreview` — so evidence exports were reaching the
   * download path with no governance preflight at all. The capability
   * is re-attached here, on the canonical Artifacts surface that owns
   * the real download buttons. When the ids are unavailable the panel
   * degrades to the plain buttons (server authorization is unchanged
   * either way).
   */
  evidenceId?: string | null;
  teamId?: string | null;
}) {
  const reports = history?.reports ?? [];
  const packages = history?.verificationPackages ?? [];
  const governed = Boolean(evidenceId && teamId);

  return (
    <section id="artifacts" className="evidence-detail-card">
      <div className="evidence-detail-card-header">
        <div>
          <p className="evidence-detail-kicker">Artifacts &amp; Versions</p>
          <h2>Latest and prior generated materials</h2>
        </div>
      </div>

      <div className="evidence-detail-related-list">
        <article className="evidence-detail-related-card">
          <div className="evidence-detail-item-row">
            <strong>PDF reports</strong>
            {governed ? (
              <GovernedExportAction
                evidenceId={evidenceId as string}
                teamId={teamId as string}
                actionLabel="Download Report PDF"
                compactWhenAllowed
                onAction={onDownloadReport}
                renderAction={({ disabled, onClick }) => (
                  <Button
                    variant="secondary"
                    onClick={onClick}
                    disabled={disabled || reports.length === 0}
                  >
                    Download latest
                  </Button>
                )}
              />
            ) : (
              <Button
                variant="secondary"
                onClick={onDownloadReport}
                disabled={reports.length === 0}
              >
                Download latest
              </Button>
            )}
          </div>
          {reports.length === 0 ? (
            <p>No artifact history available beyond latest artifact.</p>
          ) : (
            reports.map((item) => (
              <p key={item.id}>
                v{item.version} • {formatDateTime(item.generatedAtUtc)} • {formatBytes(item.sizeBytes)}
                {item.latest ? " • Latest" : ""}
                {item.immutableRecorded ? " • Immutable recorded" : ""}
              </p>
            ))
          )}
        </article>

        <article className="evidence-detail-related-card">
          <div className="evidence-detail-item-row">
            <strong>Verification packages</strong>
            {governed ? (
              <GovernedExportAction
                evidenceId={evidenceId as string}
                teamId={teamId as string}
                actionLabel="Download Verification Package ZIP"
                compactWhenAllowed
                onAction={onDownloadVerificationPackage}
                renderAction={({ disabled, onClick }) => (
                  <Button
                    variant="secondary"
                    onClick={onClick}
                    disabled={disabled || packages.length === 0}
                  >
                    Download latest
                  </Button>
                )}
              />
            ) : (
              <Button
                variant="secondary"
                onClick={onDownloadVerificationPackage}
                disabled={packages.length === 0}
              >
                Download latest
              </Button>
            )}
          </div>
          {packages.length === 0 ? (
            <p>No artifact history available beyond latest artifact.</p>
          ) : (
            packages.map((item) => (
              <p key={item.id}>
                v{item.version} • {formatDateTime(item.generatedAtUtc)} •{" "}
                {item.packageType || "Package type not recorded"} • {formatBytes(item.sizeBytes)}
                {item.latest ? " • Latest" : ""}
                {item.immutableRecorded ? " • Immutable recorded" : ""}
              </p>
            ))
          )}
        </article>
      </div>
    </section>
  );
}
