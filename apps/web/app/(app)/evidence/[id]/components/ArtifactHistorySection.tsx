"use client";

import { Button } from "../../../../../components/ui";

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
}: {
  history: ArtifactHistory | undefined;
  onDownloadReport: () => void;
  onDownloadVerificationPackage: () => void;
  formatDateTime: (value: string | null | undefined) => string;
  formatBytes: (value: string | number | null | undefined) => string;
}) {
  const reports = history?.reports ?? [];
  const packages = history?.verificationPackages ?? [];

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
            <Button variant="secondary" onClick={onDownloadReport} disabled={reports.length === 0}>
              Download latest
            </Button>
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
            <Button
              variant="secondary"
              onClick={onDownloadVerificationPackage}
              disabled={packages.length === 0}
            >
              Download latest
            </Button>
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
