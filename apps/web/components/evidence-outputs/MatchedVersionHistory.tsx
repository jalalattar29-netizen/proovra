"use client";

/**
 * MATCHED VERSION HISTORY — each immutable report beside the package that
 * certifies it.
 *
 * Reports and packages used to be two separate lists, so nothing on screen said
 * which package certified which report, and package v2 could be read beside
 * report v1. Here a row IS a pair, built by the server from the database's own
 * pairing (`verification_packages.report_version`, enforced by the RGA-05
 * foreign key). A version with no package says so; it is never paired with a
 * neighbour. Every version stays independently downloadable.
 */

import { useState, type ReactNode } from "react";
import { FileText, ShieldCheck } from "lucide-react";

import type { MatchedHistory, MatchedPackage, MatchedVersion } from "./artifact-status-types";

const VISIBLE_DEFAULT = 4;

function Digest({ value, label }: { value: string | null; label: string }) {
  if (!value) return null;
  const short = `${value.slice(0, 12)}…${value.slice(-6)}`;
  return (
    <span className="rga-pair__digest" title={`${label} SHA-256 ${value}`}>
      SHA-256 <code dir="ltr" aria-label={`${label} SHA-256 ${value}`}>{short}</code>
    </span>
  );
}

function PackageCell({
  version,
  pkg,
  formatDateTime,
  formatBytes,
  onDownload,
  missingAction,
}: {
  version: MatchedVersion;
  pkg: MatchedPackage | null;
  formatDateTime: (v: string | null | undefined) => string;
  formatBytes: (v: string | number | null | undefined) => string;
  onDownload: (v: number) => void;
  missingAction: ReactNode;
}) {
  if (!pkg) {
    return (
      <div className="rga-pair__artifact rga-pair__artifact--missing" data-testid={`pair-${version.reportVersion}-package-missing`}>
        <span className="rga-pair__name">
          <ShieldCheck size={16} strokeWidth={2} aria-hidden="true" /> Verification package
        </span>
        <span className="rga-pair__meta">No verification package certifies report v{version.reportVersion}.</span>
        {missingAction}
      </div>
    );
  }
  return (
    <div className="rga-pair__artifact" data-testid={`pair-${version.reportVersion}-package`}>
      <span className="rga-pair__name">
        <ShieldCheck size={16} strokeWidth={2} aria-hidden="true" /> Verification package v{pkg.version}
      </span>
      <span className="rga-pair__meta">
        Certifies report v{version.reportVersion}
        {pkg.pairing === "LEGACY_VERSION_NUMBER" ? " (paired by version number; recorded before pairing was stored)" : ""}
        {" · "}
        {pkg.sealed ? "sealed" : "older format; anchoring not chain-checked"}
      </span>
      <span className="rga-pair__meta">
        {formatDateTime(pkg.generatedAtUtc)} · {formatBytes(pkg.sizeBytes)}
      </span>
      <Digest value={pkg.sha256} label={`Verification package v${pkg.version}`} />
      <button
        type="button"
        className="app-secondary-action rga-pair__download"
        onClick={() => onDownload(pkg.version)}
        data-testid={`download-package-v${pkg.version}`}
        data-evidence-artifact-version-download="package"
        data-evidence-artifact-version-number={pkg.version}
      >
        Download Verification Package ZIP v{pkg.version}
      </button>
    </div>
  );
}

export function MatchedVersionHistory({
  history,
  formatDateTime,
  formatBytes,
  onDownloadReportVersion,
  onDownloadPackageVersion,
  latestPackageAction,
}: {
  history: MatchedHistory;
  formatDateTime: (v: string | null | undefined) => string;
  formatBytes: (v: string | number | null | undefined) => string;
  onDownloadReportVersion: (v: number) => void;
  onDownloadPackageVersion: (v: number) => void;
  /** The server-offered Recover/Retry control for the LATEST version's missing package. */
  latestPackageAction?: ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  const versions = history.versions;
  const visible = showAll ? versions : versions.slice(0, VISIBLE_DEFAULT);
  const hidden = versions.length - visible.length;

  return (
    <section id="artifacts" className="rga-history" aria-labelledby="rga-history-title" data-testid="matched-version-history">
      <div className="rga-history__head">
        <span className="rga-history__icon" aria-hidden="true">
          <FileText size={20} strokeWidth={2} />
        </span>
        <div>
          <h2 id="rga-history-title" className="rga-history__title">
            Artifacts &amp; Versions
          </h2>
          <p className="rga-history__sub">
            Every version is immutable. A report and the verification package that certifies it are shown together.
          </p>
        </div>
      </div>

      {versions.length === 0 ? (
        <p className="rga-history__empty" data-testid="matched-history-empty">
          No report versions have been generated for this record yet.
        </p>
      ) : (
        <ol className="rga-history__list" reversed>
          {visible.map((v) => (
            <li
              key={v.reportVersion}
              className="rga-pair"
              data-testid={`pair-${v.reportVersion}`}
              data-pair-version={v.reportVersion}
              data-pair-latest={v.latest ? "true" : "false"}
              data-pair-package-version={v.package?.version ?? ""}
            >
              <div className="rga-pair__id">
                <span className="rga-pair__version">Version {v.reportVersion}</span>
                {v.latest ? (
                  <span className="rga-badge rga-badge--accent" data-testid={`pair-${v.reportVersion}-latest`}>Latest</span>
                ) : (
                  <span className="rga-badge rga-badge--muted">Previous</span>
                )}
                <span className="rga-badge">Immutable</span>
                {v.immutableRecorded ? <span className="rga-badge">Object Lock recorded</span> : null}
                {v.issueKind === "UPDATED_REPORT" ? <span className="rga-badge rga-badge--muted">Updated report</span> : null}
                {!v.package ? <span className="rga-badge rga-badge--warn">Incomplete</span> : null}
              </div>
              <div className="rga-pair__cols">
                <div className="rga-pair__artifact" data-testid={`pair-${v.reportVersion}-report`}>
                  <span className="rga-pair__name">
                    <FileText size={16} strokeWidth={2} aria-hidden="true" /> Report v{v.reportVersion}
                  </span>
                  <span className="rga-pair__meta">
                    {formatDateTime(v.generatedAtUtc)} · {formatBytes(v.sizeBytes)}
                  </span>
                  <Digest value={v.sha256} label={`Report v${v.reportVersion}`} />
                  <button
                    type="button"
                    className="app-secondary-action rga-pair__download"
                    onClick={() => onDownloadReportVersion(v.reportVersion)}
                    data-testid={`download-report-v${v.reportVersion}`}
                    data-evidence-artifact-version-download="report"
                    data-evidence-artifact-version-number={v.reportVersion}
                  >
                    Download Report PDF v{v.reportVersion}
                  </button>
                </div>
                <PackageCell
                  version={v}
                  pkg={v.package}
                  formatDateTime={formatDateTime}
                  formatBytes={formatBytes}
                  onDownload={onDownloadPackageVersion}
                  missingAction={v.latest ? latestPackageAction : null}
                />
              </div>
              {v.issueReason ? (
                <p className="rga-pair__reason">
                  <span>Reason recorded:</span> <span className="rga-pair__reason-text">{v.issueReason}</span>
                </p>
              ) : null}
              {v.digestMismatch ? (
                <p className="rga-pair__alert" role="alert">
                  The verification package&apos;s recorded report digest does not match this report&apos;s stored
                  digest. Contact support; nothing has been changed.
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {hidden > 0 || showAll ? (
        <button
          type="button"
          className="app-secondary-action rga-history__more"
          aria-expanded={showAll}
          onClick={() => setShowAll((s) => !s)}
          data-testid="matched-history-toggle"
        >
          {showAll ? "Show fewer versions" : `Show ${hidden} earlier version${hidden === 1 ? "" : "s"}`}
        </button>
      ) : null}
      {history.unpairedPackages.length > 0 ? (
        <div className="rga-history__unpaired" data-testid="matched-history-unpaired">
          <h3 className="rga-history__subtitle">Verification packages without a report record</h3>
          <p className="rga-history__sub">
            These packages are kept as they are. Their report record is absent, so they are not paired with any
            other version.
          </p>
          <ul className="rga-history__list">
            {history.unpairedPackages.map((p) => (
              <li key={p.version} className="rga-pair rga-pair--unpaired">
                <span className="rga-pair__name">Verification package v{p.version}</span>
                <span className="rga-pair__meta">
                  {formatDateTime(p.generatedAtUtc)} · {formatBytes(p.sizeBytes)}
                </span>
                <button
                  type="button"
                  className="app-secondary-action rga-pair__download"
                  onClick={() => onDownloadPackageVersion(p.version)}
                >
                  Download Verification Package ZIP v{p.version}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
