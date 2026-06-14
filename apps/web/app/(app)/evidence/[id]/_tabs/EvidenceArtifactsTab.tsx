/**
 * Phase EVIDENCE-IA-ARTIFACTS — Artifacts tab.
 *
 * Generated outputs only: reports, packages, public verification.
 *
 * Phase 2 — "Latest Artifact Summary" hero above the version history.
 * Shows: Latest Report / Latest Package / Latest Verification Link at
 * a glance, so the user doesn't have to read the version history to
 * answer "what's the most recent output".
 *
 * Phase 1 — Public verification counts (views / report downloads /
 * package downloads / last view) are owned here. Removed from
 * Integrity (no duplication).
 */

"use client";

import { Globe, Package } from "lucide-react";
import { Button } from "../../../../../components/ui";
import {
  KeyValueGrid,
  SectionHeading,
  describeReportArtifactStatus,
  describeVerificationPackageStatus,
  formatValue,
  type EvidenceDetailCtx,
} from "./_lib";
import { formatUserDateTime } from "../../../../../lib/date";
import { ArtifactHistorySection } from "../components/ArtifactHistorySection";
import { formatBytes } from "./_lib";

export function EvidenceArtifactsTab({ ctx }: { ctx: EvidenceDetailCtx }) {
  const {
    workspace,
    workspaceCaps,
    publicVerificationState,
    shareUrl,
    stalePending,
    setStalePending,
    setPollStartedAt,
    loadWorkspace,
    downloadReport,
    downloadVerificationPackage,
  } = ctx;

  return (
    <>
      {stalePending ? (
        <section
          className="evidence-detail-section"
          data-evidence-section="artifact-stale-pending"
          style={{
            borderLeft: "4px solid #d97706",
            background: "#fef3c7",
            padding: "12px 14px",
            borderRadius: 8,
          }}
        >
          <strong
            style={{ display: "block", marginBottom: 4, color: "#78350f", fontSize: 13.5 }}
          >
            Report generation is taking longer than expected
          </strong>
          <p
            className="evidence-detail-muted"
            style={{ margin: "0 0 8px 0", fontSize: 12.5, color: "#78350f" }}
          >
            The signed evidence record is preserved — the chain-of-custody and integrity
            columns are intact. The downstream report and verification package are still
            pending. Click refresh below to re-check status, or contact support if this
            persists.
          </p>
          <button
            type="button"
            onClick={() => {
              setStalePending(false);
              setPollStartedAt(null);
              void loadWorkspace();
            }}
            data-evidence-action="artifact-stale-refresh"
            style={{
              border: "1px solid #d97706",
              background: "white",
              color: "#78350f",
              padding: "5px 10px",
              borderRadius: 6,
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Re-check status
          </button>
        </section>
      ) : null}

      {workspaceCaps && !workspaceCaps.reportsIncluded &&
      !workspace.artifactStatus.report.available ? (
        <section
          className="evidence-detail-section"
          data-evidence-section="reports-plan-gated"
          style={{
            borderLeft: "4px solid #d97706",
            background: "#fef3c7",
            padding: "12px 14px",
            borderRadius: 8,
          }}
        >
          <strong
            style={{ display: "block", marginBottom: 4, color: "#78350f", fontSize: 13.5 }}
          >
            Reports are not included in this plan
          </strong>
          <p
            className="evidence-detail-muted"
            style={{ margin: 0, fontSize: 12.5, color: "#78350f" }}
          >
            Report PDFs and verification packages are part of Pay-Per-Evidence, Pro, and
            Team plans. Your evidence record itself is signed and preserved — the
            chain-of-custody chain remains intact — but no downloadable report artifact
            will be generated on your current plan.
          </p>
        </section>
      ) : null}

      {/* Phase 2 — Latest artifact summary. Three rows: latest
          report, latest package, latest verification link, with
          inline shortcut buttons. Version history follows below. */}
      <section className="evidence-detail-section" data-evidence-section="latest-artifacts">
        <div className="evidence-detail-section-header">
          <SectionHeading
            kicker="Latest"
            title="Latest report, package, and verification link"
            icon={Package}
          />
        </div>
        <div className="evidence-detail-data-grid">
          <div className="evidence-detail-data-cell" data-latest-artifact="report">
            <span>Latest report</span>
            <strong>
              {describeReportArtifactStatus(workspace.artifactStatus)}
              {workspace.artifactStatus.report.available ? (
                <Button
                  variant="secondary"
                  onClick={() => void downloadReport()}
                  style={{ marginLeft: 8 }}
                >
                  Download
                </Button>
              ) : null}
            </strong>
          </div>
          <div className="evidence-detail-data-cell" data-latest-artifact="package">
            <span>Latest verification package</span>
            <strong>
              {describeVerificationPackageStatus(
                workspace.artifactStatus,
                workspaceCaps.verificationPackageIncluded ?? false,
              )}
              {workspace.artifactStatus.verificationPackage.available ? (
                <Button
                  variant="secondary"
                  onClick={() => void downloadVerificationPackage()}
                  style={{ marginLeft: 8 }}
                >
                  Download
                </Button>
              ) : null}
            </strong>
          </div>
          <div className="evidence-detail-data-cell" data-latest-artifact="verify">
            <span>Latest verification link</span>
            <strong>
              {shareUrl ? (
                <a
                  href={shareUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="evidence-detail-inline-link"
                >
                  Open verification surface →
                </a>
              ) : (
                (publicVerificationState?.label ?? "Not available")
              )}
            </strong>
          </div>
        </div>
      </section>

      <ArtifactHistorySection
        history={workspace.artifactVersions.history}
        onDownloadReport={() => void downloadReport()}
        onDownloadVerificationPackage={() => void downloadVerificationPackage()}
        formatDateTime={formatUserDateTime}
        formatBytes={formatBytes}
      />

      <section className="evidence-detail-section">
        <div className="evidence-detail-section-header">
          <SectionHeading
            kicker="Public verification &amp; sharing"
            title="External verification and export activity"
            icon={Globe}
          />
        </div>
        <KeyValueGrid
          items={[
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
              value: publicVerificationState?.detail ?? "No publication detail available",
            },
            {
              label: "Public views",
              value: String(workspace.publicVerificationSummary.publicViewCount),
            },
            {
              label: "Report downloads",
              value: String(workspace.publicVerificationSummary.reportDownloadCount),
            },
            {
              label: "Package downloads",
              value: String(
                workspace.publicVerificationSummary.verificationPackageDownloadCount,
              ),
            },
            {
              label: "Last public view",
              value: formatValue(
                formatUserDateTime(workspace.publicVerificationSummary.lastPublicViewAt),
              ),
            },
          ]}
        />
      </section>
    </>
  );
}
