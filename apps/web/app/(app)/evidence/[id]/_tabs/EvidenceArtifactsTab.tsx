/**
 * Phase EVIDENCE-IA-ARTIFACTS — Artifacts tab.
 *
 * Generated outputs only: reports, packages, public verification.
 *
 * The "Latest" hero carries only the verification link. The earlier
 * Latest-Report and Latest-Package cards were removed because the
 * ArtifactHistorySection rendered immediately below already lists every
 * version (v1, v2, …) and exposes "Download latest".
 *
 * Phase 1 — Public verification counts (views / report downloads / package
 * downloads / last view) are owned here. Removed from Integrity (no
 * duplication).
 *
 * Phase EVIDENCE-DETAIL-REDESIGN — presentation only, with two truthfulness
 * corrections that the previous build got wrong:
 *
 *   1. DOWNLOAD GATING. "Download latest" used to be enabled whenever the
 *      history array was non-empty. A record can carry prior versions while
 *      the current artifact is pending, failed, unavailable or excluded by
 *      plan — so the control could offer a download that could not succeed.
 *      It now derives from `artifactStatus`, and carries the reason.
 *
 *   2. ZERO vs UNAVAILABLE. Public-verification counters were stringified
 *      unconditionally, so a workspace with no analytics read as "0 views".
 *      They now honour `analyticsAvailable`: a real zero shows "0", and
 *      absent analytics say so instead of claiming no activity.
 */

"use client";

import { ChevronRight, Globe, ShieldCheck } from "lucide-react";
import { formatValue, type EvidenceDetailCtx } from "./_lib";
import { formatUserDateTime } from "../../../../../lib/date";
import { ArtifactHistorySection } from "../components/ArtifactHistorySection";
import { formatBytes } from "./_lib";

export function EvidenceArtifactsTab({ ctx }: { ctx: EvidenceDetailCtx }) {
  const {
    workspace,
    workspaceCaps,
    evidenceId,
    publicVerificationState,
    shareUrl,
    stalePending,
    setStalePending,
    setPollStartedAt,
    loadWorkspace,
    downloadReport,
    downloadVerificationPackage,
  } = ctx;

  const summary = workspace.publicVerificationSummary;
  const reportStatus = workspace.artifactStatus.report;
  const packageStatus = workspace.artifactStatus.verificationPackage;
  const reportsIncluded = workspaceCaps?.reportsIncluded !== false;
  const packageIncluded = workspaceCaps?.verificationPackageIncluded !== false;

  // The download control is enabled only when the CURRENT artifact is
  // available; each blocked state carries the reason the server gave.
  const reportDownloadable = reportStatus.available === true;
  const reportDisabledReason = reportDownloadable
    ? null
    : reportStatus.pending
      ? "The report is still being generated. Re-check status once it completes."
      : !reportsIncluded
        ? "Report PDFs are not included in the current plan."
        : "No report has been generated for this record yet.";

  const packageDownloadable = packageStatus.available === true;
  const packageDisabledReason = packageDownloadable
    ? null
    : packageStatus.pending
      ? "The verification package is still being generated. Re-check status once it completes."
      : packageStatus.blocked
        ? (packageStatus.blockedReason ??
          "Verification package export is blocked by an export-governance gate.")
        : packageStatus.unavailable
          ? (packageStatus.unavailableReason ??
            "The verification package is unavailable for this record.")
          : !packageIncluded
            ? "Verification packages are not included in the current plan."
            : "No verification package has been generated for this record yet.";

  // A counter is a real number only when analytics are actually available.
  // Otherwise the honest answer is that we do not know — never "0".
  const counter = (value: number): string =>
    summary.analyticsAvailable ? String(value) : "Not available";

  return (
    <>
      {stalePending ? (
        <div
          className="app-alert app-alert--warn"
          role="status"
          data-evidence-section="artifact-stale-pending"
        >
          <strong>Report generation is taking longer than expected</strong>
          <p>
            The signed evidence record is preserved — the chain-of-custody and
            integrity columns are intact. The downstream report and verification
            package are still pending. Re-check status below, or contact support
            if this persists.
          </p>
          <button
            type="button"
            className="app-secondary-action"
            onClick={() => {
              setStalePending(false);
              setPollStartedAt(null);
              void loadWorkspace();
            }}
            data-evidence-action="artifact-stale-refresh"
          >
            Re-check status
          </button>
        </div>
      ) : null}

      {workspaceCaps && !workspaceCaps.reportsIncluded && !reportStatus.available ? (
        <div
          className="app-alert app-alert--warn"
          role="status"
          data-evidence-section="reports-plan-gated"
        >
          <strong>Reports are not included in this plan</strong>
          <p>
            Report PDFs and verification packages are part of Pay-Per-Evidence,
            Pro, and Team plans. Your evidence record itself is signed and
            preserved — the chain-of-custody chain remains intact — but no
            downloadable report artifact will be generated on your current plan.
          </p>
        </div>
      ) : null}

      {/* Latest verification link. `shareUrl` is derived from the SAME
          publicVerificationSummary the rail reads, so the tab and the rail can
          never disagree about publication state. The link is never
          synthesised: without a real share path the card shows the state
          label and its reason instead of an action. */}
      <section
        className="evidence-detail-verify-card"
        data-evidence-section="latest-artifacts"
      >
        <span className="evidence-detail-verify-card__icon" aria-hidden="true">
          <ShieldCheck size={20} strokeWidth={2} />
        </span>
        <h2 className="evidence-detail-verify-card__title">
          Latest verification link
        </h2>
        <div className="evidence-detail-verify-card__action" data-latest-artifact="verify">
          {shareUrl ? (
            <a
              href={shareUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="evidence-detail-inline-link evidence-detail-verify-link"
              data-evidence-verify-link
            >
              Open verification surface
              <ChevronRight size={16} strokeWidth={2.5} aria-hidden="true" />
            </a>
          ) : (
            <span
              className="evidence-detail-verify-card__unavailable"
              data-evidence-verify-unavailable
            >
              {publicVerificationState?.label ?? "Not available"}
            </span>
          )}
        </div>
        {!shareUrl && publicVerificationState?.detail ? (
          <p className="evidence-detail-verify-card__reason">
            {publicVerificationState.detail}
          </p>
        ) : null}
      </section>

      <ArtifactHistorySection
        history={workspace.artifactVersions.history}
        onDownloadReport={() => void downloadReport()}
        onDownloadVerificationPackage={() => void downloadVerificationPackage()}
        formatDateTime={formatUserDateTime}
        formatBytes={formatBytes}
        evidenceId={evidenceId}
        teamId={workspace.evidence.teamId}
        reportDownloadable={reportDownloadable}
        reportDisabledReason={reportDisabledReason}
        packageDownloadable={packageDownloadable}
        packageDisabledReason={packageDisabledReason}
      />

      <section
        className="evidence-detail-sharing"
        data-evidence-section="public-verification-sharing"
      >
        <div className="evidence-detail-sharing__head">
          <span className="evidence-detail-sharing__icon" aria-hidden="true">
            <Globe size={20} strokeWidth={2} />
          </span>
          <div className="evidence-detail-sharing__copy">
            <h2 className="evidence-detail-sharing__title">
              Public verification &amp; sharing
            </h2>
            <p className="evidence-detail-sharing__description">
              External verification and export activity
            </p>
          </div>
        </div>

        {/* One bare row of label/value pairs inside the card, not a grid of
            sub-cards: these are columns of one activity summary. */}
        <div className="evidence-detail-sharing-grid" data-evidence-facts-grid>
          {[
            {
              label: "Verification status",
              value: publicVerificationState?.label ?? "State unavailable",
            },
            {
              label: "Verification link",
              value: shareUrl ? "Available" : "Not available",
            },
            {
              label: "Publication detail",
              value:
                publicVerificationState?.detail ?? "No publication detail available",
              wide: true,
            },
            { label: "Public views", value: counter(summary.publicViewCount) },
            {
              label: "Report downloads",
              value: counter(summary.reportDownloadCount),
            },
            {
              label: "Package downloads",
              value: counter(summary.verificationPackageDownloadCount),
            },
            {
              label: "Last public view",
              value: formatValue(formatUserDateTime(summary.lastPublicViewAt)),
            },
          ].map((item) => (
            <div
              key={item.label}
              className="evidence-detail-sharing-fact"
              data-wide={item.wide ? "true" : undefined}
            >
              <span className="evidence-detail-sharing-fact__label">{item.label}</span>
              <span className="evidence-detail-sharing-fact__value">{item.value}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
