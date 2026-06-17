/**
 * Phase EVIDENCE-IA-INTEGRITY — Integrity tab.
 *
 * Verification and preservation posture (human-readable). Technical
 * detail (manifest SHA, TSA imprint, hash semantics, snapshot-boundary
 * divergence detail, forensic event counts) moves to the Technical
 * Appendix tab.
 *
 * Phase 5 — copy refinement:
 *   "Preservation Matrix"                  → "Verification & preservation"
 *   "TSA timestamp"                        → "Timestamp proof (TSA)"
 *   "Verification History" + the row block → "Snapshot timing" (plain)
 *
 * Phase 1 — duplication removal:
 *   - Forensic event COUNTS removed here (full Custody timeline in
 *     the Custody tab is the canonical home).
 *   - Multipart manifest SHA-256 / TSA accepted message imprint /
 *     hash semantics / snapshot boundary divergence detail moved to
 *     the Technical Appendix.
 */

"use client";

import { History, ImageIcon, ShieldCheck } from "lucide-react";
import { Button } from "../../../../../components/ui";
import CaptureLocationMapPanel from "../../../../../components/capture-location/CaptureLocationMapPanel";
import {
  KeyValueGrid,
  SectionHeading,
  describeClientSignalState,
  describePackageManifestStatus,
  describeReportArtifactStatus,
  describeReportPdfSignature,
  describeVerificationPackageStatus,
  formatValue,
  type EvidenceDetailCtx,
} from "./_lib";
import { formatUserDateTime } from "../../../../../lib/date";
import {
  displayCaptureMethod,
  displaySourceType,
  shouldShowContextSignal,
} from "../../../../../lib/evidence/source-display";

export function EvidenceIntegrityTab({ ctx }: { ctx: EvidenceDetailCtx }) {
  const {
    workspace,
    preservation,
    workspaceCaps,
    otsStatusPresentation,
    showManualLatestStatusCheck,
    loadWorkspace,
  } = ctx;

  return (
    <>
      <section className="evidence-detail-section">
        <div className="evidence-detail-section-header">
          <SectionHeading
            kicker="Source &amp; Capture Context"
            title="Capture provenance context"
            icon={ImageIcon}
          />
        </div>

        {(() => {
          // Strict-honesty rule: a context card renders ONLY when
          // PROOVRA has a real collected value. Missing or
          // not-collected signals are HIDDEN entirely — no
          // placeholder cards, no fallback copy, no summary row.
          // If reviewers need to know what's missing, the answer
          // is to collect it (or to not surface the signal until
          // we do).
          const sc = workspace.sourceContext;
          const items: { label: string; value: string }[] = [];

          // Source type — only push when the helper resolves to a real
          // label. Both null sourceType and unknown captureMethod
          // produce "Source not recorded", which we suppress.
          const sourceTypeLabel = displaySourceType(
            sc.sourceType,
            sc.captureMethod,
          );
          if (sourceTypeLabel && sourceTypeLabel !== "Source not recorded") {
            items.push({ label: "Source type", value: sourceTypeLabel });
          }

          // Capture method — same rule. "Capture method not recorded"
          // is the helper's fallback for unknown enum values and is
          // suppressed.
          const captureMethodLabel = displayCaptureMethod(sc.captureMethod);
          if (
            captureMethodLabel &&
            captureMethodLabel !== "Capture method not recorded"
          ) {
            items.push({ label: "Capture method", value: captureMethodLabel });
          }

          // Server-stamped timestamps. formatUserDateTime returns null
          // when the input ISO is null; formatValue then returns the
          // em-dash placeholder. We bypass formatValue and skip the
          // row entirely when no timestamp exists.
          const capturedAt = sc.capturedAtUtc
            ? formatUserDateTime(sc.capturedAtUtc)
            : null;
          if (capturedAt) {
            items.push({ label: "Captured at", value: capturedAt });
          }
          const uploadedAt = sc.uploadedAtUtc
            ? formatUserDateTime(sc.uploadedAtUtc)
            : null;
          if (uploadedAt) {
            items.push({ label: "Uploaded at", value: uploadedAt });
          }

          // Device time — only when the client actually sent one.
          if (sc.deviceTimeIso) {
            items.push({ label: "Device time", value: sc.deviceTimeIso });
          }

          // Location — only when we actually have it. The absence of
          // the row IS the message; no placeholder card is rendered.
          if (sc.locationIncluded) {
            items.push({ label: "Location included", value: "Included" });
          }

          // Client signals — DETECTED / COLLECTED_FALSE only. Every
          // NOT_COLLECTED / UNAVAILABLE state is hidden.
          if (
            shouldShowContextSignal(sc.clientSignalsSummary.screenshotLikeStatus)
          ) {
            items.push({
              label: "Screenshot indicators",
              value: describeClientSignalState(
                sc.clientSignalsSummary.screenshotLikeStatus,
              ),
            });
          }
          if (
            shouldShowContextSignal(sc.clientSignalsSummary.folderPathStatus)
          ) {
            items.push({
              label: "Folder path indicators",
              value: describeClientSignalState(
                sc.clientSignalsSummary.folderPathStatus,
              ),
            });
          }

          // If a record has truly no collected context (e.g. a stub
          // row), render nothing rather than an empty grid skeleton.
          if (items.length === 0) return null;
          return <KeyValueGrid items={items} />;
        })()}

        {workspace.sourceCaptureLocation ? (
          <div className="evidence-detail-map-shell">
            <CaptureLocationMapPanel
              lat={workspace.sourceCaptureLocation.lat ?? 0}
              lng={workspace.sourceCaptureLocation.lng ?? 0}
              accuracyMeters={workspace.sourceCaptureLocation.accuracyMeters}
              sourceLabel={workspace.sourceCaptureLocation.source}
            />
            <p className="evidence-detail-muted">{workspace.sourceCaptureLocation.legalBoundary}</p>
          </div>
        ) : null}

        <div className="evidence-detail-note-box">
          <strong>Boundary</strong>
          <p>{workspace.sourceContext.limitations[0]}</p>
        </div>
      </section>

      {/* Phase 5 — renamed kicker. The grid below stays — it lists
          recorded preservation materials in plain-English row labels.
          Technical-detail rows (multipart manifest, TSA imprint, hash
          semantics) moved to the Technical Appendix. */}
      <section className="evidence-detail-section" data-evidence-section="verification-preservation">
        <div className="evidence-detail-section-header">
          <SectionHeading
            kicker="Verification &amp; Preservation"
            title="Recorded integrity and preservation materials"
            icon={ShieldCheck}
          />
          {showManualLatestStatusCheck ? (
            <div className="evidence-detail-inline-actions">
              <Button variant="secondary" onClick={() => void loadWorkspace()}>
                Check latest status
              </Button>
            </div>
          ) : null}
        </div>

        <KeyValueGrid
          items={[
            { label: "Verification status", value: preservation.verificationStatusLabel },
            {
              label: "SHA-256 recorded",
              value: preservation.sha256Recorded ? "Recorded" : "Not recorded",
            },
            {
              label: "Fingerprint hash",
              value: preservation.fingerprintHashRecorded ? "Recorded" : "Not recorded",
            },
            {
              label: "Signature",
              value: preservation.signature.recorded
                ? preservation.signature.valid
                  ? "Recorded and validated"
                  : "Recorded"
                : "Not recorded",
            },
            {
              // Phase 5 — "Timestamp proof (TSA)" is plainer than the
              // prior "TSA timestamp" + matches the Home pass.
              label: "Timestamp proof (TSA)",
              value: preservation.tsa.timestampAvailable
                ? "Timestamp recorded"
                : preservation.tsa.status
                  ? `Status: ${preservation.tsa.status}`
                  : "Timestamp unavailable",
            },
            { label: "Public anchoring (OTS)", value: otsStatusPresentation?.label ?? "Not configured" },
            {
              label: "Public anchoring last updated",
              value: formatValue(formatUserDateTime(preservation.ots.lastUpdatedAtUtc)),
            },
            {
              label: "Storage protection",
              value: preservation.storage?.verified
                ? "Recorded"
                : "Not exposed in current API response",
            },
            {
              label: "Public anchoring detail",
              value: otsStatusPresentation?.detail ?? "No public anchoring state recorded",
            },
            {
              label: "Report artifact",
              value: `${describeReportArtifactStatus(workspace.artifactStatus)}${
                preservation.report.available
                  ? ` · Version ${preservation.report.version ?? "latest"}`
                  : ""
              }`,
            },
            {
              label: "Report PDF signature",
              value: describeReportPdfSignature(workspace.artifactStatus),
            },
            {
              label: "Verification package",
              value: `${describeVerificationPackageStatus(
                workspace.artifactStatus,
                workspaceCaps.verificationPackageIncluded ?? false,
              )}${
                preservation.verificationPackage.available
                  ? ` · Version ${preservation.verificationPackage.version ?? "latest"}`
                  : ""
              }`,
            },
            {
              label: "Package manifest",
              value: describePackageManifestStatus(
                workspace.artifactStatus,
                workspaceCaps.verificationPackageIncluded ?? false,
              ),
            },
            {
              // Phase 5 — "Record protection" is plainer than the
              // prior "Retention until" / "Object Lock" rows in the
              // Review tab. Same underlying fact; condensed.
              label: "Retention until",
              value: workspace.evidence?.retentionUntilUtc
                ? `Recorded — ${formatValue(formatUserDateTime(workspace.evidence.retentionUntilUtc))}`
                : "No record-level retention deadline recorded",
            },
            {
              label: "Object Lock retention mode",
              value: workspace.evidence?.storageObjectLockMode
                ? String(workspace.evidence.storageObjectLockMode)
                : "Not asserted (storage immutability not confirmed for this record)",
            },
            {
              label: "Object Lock retention until",
              value: workspace.evidence?.storageObjectLockRetainUntilUtc
                ? formatValue(
                    formatUserDateTime(workspace.evidence.storageObjectLockRetainUntilUtc),
                  )
                : "Not asserted",
            },
            {
              label: "Legal hold",
              value:
                workspace.evidence?.storageObjectLockLegalHoldStatus === "ON"
                  ? "Legal hold active"
                  : workspace.evidence?.storageObjectLockLegalHoldStatus === "OFF"
                    ? "Legal hold off"
                    : "No legal hold metadata recorded",
            },
          ]}
        />
      </section>

      {/* Phase 1 — kept on Integrity but pared to the user-readable
          fields (report generated at + package generated at + current
          status + chain validity). The forensic event COUNTS + access
          event counts moved to Custody/Technical Appendix; the
          snapshot-boundary DIVERGENCE detail moved to Technical
          Appendix. */}
      <section className="evidence-detail-section">
        <div className="evidence-detail-section-header">
          <SectionHeading
            kicker="Snapshot timing"
            title="When the fixed materials were generated"
            icon={History}
          />
        </div>

        <KeyValueGrid
          items={[
            {
              label: "Report generated at",
              value: formatValue(formatUserDateTime(workspace.snapshot.reportGeneratedAtUtc)),
            },
            {
              label: "Verification package generated at",
              value: formatValue(
                formatUserDateTime(workspace.snapshot.verificationPackageGeneratedAtUtc),
              ),
            },
            {
              label: "Current status",
              value: workspace.snapshot.currentStatus.replace(/_/g, " "),
            },
            {
              label: "Custody chain",
              value: preservation.custodyChain.valid
                ? `Continuous (${preservation.custodyChain.mode})`
                : `Review required (${preservation.custodyChain.reason ?? "unknown"})`,
            },
          ]}
        />

        <div className="evidence-detail-note-box">
          <strong>Record boundary noted</strong>
          <p>{workspace.snapshot.fixedArtifactNote}</p>
        </div>

        {workspace.artifactVersions.trustDecisionConsistency
          ?.consistentWithSnapshot === false ? (
          <div
            role={
              workspace.artifactVersions.trustDecisionConsistency?.tone === "danger"
                ? "alert"
                : "status"
            }
            className="evidence-detail-note-box"
            data-evidence-snapshot-divergence-summary
            style={{
              borderLeft:
                workspace.artifactVersions.trustDecisionConsistency?.tone === "danger"
                  ? "5px solid #b54738"
                  : workspace.artifactVersions.trustDecisionConsistency?.accessOnly
                    ? "5px solid #0b2e27"
                    : "5px solid #b8861f",
              background:
                workspace.artifactVersions.trustDecisionConsistency?.tone === "danger"
                  ? "#fff3f1"
                  : workspace.artifactVersions.trustDecisionConsistency?.accessOnly
                    ? "rgba(11,46,39,0.06)"
                    : "#fef7e8",
            }}
          >
            <strong>Boundary updated</strong>
            <p>
              {workspace.artifactVersions.trustDecisionConsistency?.accessOnly
                ? "No integrity mismatch detected. Live access activity now differs from the fixed report snapshot, and this is informational activity drift only."
                : workspace.artifactVersions.trustDecisionConsistency?.tone === "danger"
                  ? "A live integrity-relevant divergence was detected between the current state and the fixed report snapshot. Open the Technical Appendix tab for the full reason list."
                  : "Live verification now differs from the fixed report snapshot. Open the Technical Appendix tab for the full reason list."}
            </p>
          </div>
        ) : null}
      </section>
    </>
  );
}
