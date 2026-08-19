"use client";

import type { ReactNode } from "react";
import { FileText, ShieldCheck } from "lucide-react";
import { GovernedExportAction } from "../../../../../components/governance/GovernedExportAction";

type ReportVersion = {
  id: string;
  version: number;
  generatedAtUtc: string;
  sizeBytes: string | null;
  immutableRecorded: boolean;
  latest: boolean;
};

type PackageVersion = ReportVersion & { packageType: string | null };

type ArtifactHistory = {
  reports: ReportVersion[];
  verificationPackages: PackageVersion[];
};

/**
 * One artifact FAMILY. Reports and verification packages are different
 * materials with different provenance, so they keep separate cards, separate
 * version lists and separate download actions — but they share this single
 * anatomy so a reviewer reads them the same way.
 *
 * `downloadable` is supplied by the caller from the artifact's own status,
 * never inferred from the list being non-empty: a record can carry history
 * while the latest artifact is pending, failed or excluded by plan.
 */
function ArtifactFamilyCard({
  title,
  icon: Icon,
  testid,
  versions,
  emptyMessage,
  downloadable,
  disabledReason,
  actionLabel,
  onDownload,
  governed,
  evidenceId,
  teamId,
  renderMeta,
}: {
  title: string;
  icon: typeof FileText;
  testid: string;
  versions: ReportVersion[];
  emptyMessage: string;
  downloadable: boolean;
  disabledReason: string | null;
  actionLabel: string;
  onDownload: () => void;
  governed: boolean;
  evidenceId?: string | null;
  teamId?: string | null;
  renderMeta: (version: ReportVersion) => ReactNode;
}) {
  const downloadButton = (extraDisabled: boolean, onClick: () => void) => {
    const disabled = extraDisabled || !downloadable;
    return (
      <button
        type="button"
        className="app-primary-action"
        onClick={onClick}
        disabled={disabled}
        aria-disabled={disabled}
        aria-label={`Download latest ${title}`}
        aria-describedby={disabled && disabledReason ? `${testid}-reason` : undefined}
        title={disabled ? (disabledReason ?? undefined) : undefined}
        data-evidence-artifact-download={testid}
        data-evidence-artifact-downloadable={downloadable ? "true" : "false"}
      >
        Download latest
      </button>
    );
  };

  return (
    <article
      className="evidence-detail-artifact-card"
      data-evidence-artifact-family={testid}
    >
      <div className="evidence-detail-artifact-card__head">
        <span className="evidence-detail-artifact-card__icon" aria-hidden="true">
          <Icon size={20} strokeWidth={2} />
        </span>
        <h3 className="evidence-detail-artifact-card__title">{title}</h3>
        <div className="evidence-detail-artifact-card__action">
          {governed ? (
            <GovernedExportAction
              evidenceId={evidenceId as string}
              teamId={teamId as string}
              actionLabel={actionLabel}
              compactWhenAllowed
              onAction={onDownload}
              renderAction={({ disabled, onClick }) => downloadButton(disabled, onClick)}
            />
          ) : (
            downloadButton(false, onDownload)
          )}
        </div>
      </div>

      {/* The reason the control is disabled is exposed as text, not only as a
          title attribute, so assistive technology reaches it. */}
      {!downloadable && disabledReason ? (
        <p
          id={`${testid}-reason`}
          className="evidence-detail-artifact-card__reason"
          data-evidence-artifact-reason={testid}
        >
          {disabledReason}
        </p>
      ) : null}

      {versions.length === 0 ? (
        <p
          className="evidence-detail-artifact-card__empty"
          data-evidence-artifact-empty={testid}
        >
          {emptyMessage}
        </p>
      ) : (
        <ul className="evidence-detail-artifact-versions">
          {versions.map((item) => (
            <li
              key={item.id}
              className="evidence-detail-artifact-version"
              data-evidence-artifact-version={item.version}
              data-evidence-artifact-latest={item.latest ? "true" : "false"}
            >
              {renderMeta(item)}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

export function ArtifactHistorySection({
  history,
  onDownloadReport,
  onDownloadVerificationPackage,
  formatDateTime,
  formatBytes,
  evidenceId,
  teamId,
  reportDownloadable,
  reportDisabledReason,
  packageDownloadable,
  packageDisabledReason,
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
  /**
   * Availability comes from the artifact's OWN status, not from the length
   * of its history: a record can carry prior versions while the current one
   * is pending, failed, unavailable or excluded by plan.
   */
  reportDownloadable: boolean;
  reportDisabledReason: string | null;
  packageDownloadable: boolean;
  packageDisabledReason: string | null;
}) {
  const reports = history?.reports ?? [];
  const packages = history?.verificationPackages ?? [];
  const governed = Boolean(evidenceId && teamId);

  const metaChip = (item: ReportVersion, extra?: string | null) => (
    <>
      <span className="evidence-detail-artifact-version__label">v{item.version}</span>
      <span className="evidence-detail-artifact-version__meta">
        <span className="evidence-detail-artifact-version__text">{formatDateTime(item.generatedAtUtc)}</span>
      </span>
      {extra ? (
        <span className="evidence-detail-artifact-version__meta">
        <span className="evidence-detail-artifact-version__text">{extra}</span>
      </span>
      ) : null}
      <span className="evidence-detail-artifact-version__meta">
        <span className="evidence-detail-artifact-version__text">{formatBytes(item.sizeBytes)}</span>
      </span>
      {/* "Latest" and "Immutable recorded" are plain meta items on the same
          line, not status chips: every current version would otherwise wear a
          green badge, which reads as a quality verdict rather than a position
          in the version list. "Immutable recorded" renders ONLY when the
          backend recorded it; its absence is not a claim either way. */}
      {item.latest ? (
        <span
          className="evidence-detail-artifact-version__meta"
          data-evidence-artifact-marker="latest"
        >
          <span className="evidence-detail-artifact-version__text">Latest</span>
        </span>
      ) : null}
      {item.immutableRecorded ? (
        <span
          className="evidence-detail-artifact-version__meta"
          data-evidence-artifact-marker="immutable"
        >
          <span className="evidence-detail-artifact-version__text">Immutable recorded</span>
        </span>
      ) : null}
    </>
  );

  return (
    <section id="artifacts" className="evidence-detail-artifacts">
      <div className="evidence-detail-artifacts__head">
        <span className="evidence-detail-artifacts__icon" aria-hidden="true">
          <FileText size={20} strokeWidth={2} />
        </span>
        <div className="evidence-detail-artifacts__copy">
          <h2 className="evidence-detail-artifacts__title">Artifacts &amp; Versions</h2>
          <p className="evidence-detail-artifacts__description">
            Latest and prior generated materials
          </p>
        </div>
      </div>

      <ArtifactFamilyCard
        title="PDF reports"
        icon={FileText}
        testid="report"
        versions={reports}
        emptyMessage="No report versions are recorded in the current response."
        downloadable={reportDownloadable}
        disabledReason={reportDisabledReason}
        actionLabel="Download Report PDF"
        onDownload={onDownloadReport}
        governed={governed}
        evidenceId={evidenceId}
        teamId={teamId}
        renderMeta={(item) => metaChip(item)}
      />

      <ArtifactFamilyCard
        title="Verification Packages"
        icon={ShieldCheck}
        testid="package"
        versions={packages}
        emptyMessage="No verification package versions are recorded in the current response."
        downloadable={packageDownloadable}
        disabledReason={packageDisabledReason}
        actionLabel="Download Verification Package ZIP"
        onDownload={onDownloadVerificationPackage}
        governed={governed}
        evidenceId={evidenceId}
        teamId={teamId}
        renderMeta={(item) =>
          metaChip(
            item,
            (item as PackageVersion).packageType || "Package type not recorded",
          )
        }
      />
    </section>
  );
}
