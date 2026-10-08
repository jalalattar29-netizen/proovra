// D:\digital-witness\services\worker\src\report-v2\sections\cover.ts
import { reportAssetDataUrl } from "../asset-data-url.js";
import type { ReportViewModel } from "../types.js";
import { escapeHtml, safe } from "../formatters.js";
import { renderInlineQrBlock, verificationStatusTone } from "../ui.js";
import { formatTimestampForReportUtc } from "@proovra/shared";
const coverBrandIconUrl = reportAssetDataUrl("icon-192.png");
const coverHeaderLockupUrl = reportAssetDataUrl("report-header.png");
// `coverBrandIconUrl` is retained for any legacy section that may still reference
// it. The cover header itself uses the inline lockup image below.
void coverBrandIconUrl;

function findRowValue(
  rows: Array<{ label: string; value: string }>,
  label: string,
  fallback = "Not recorded"
): string {
  return rows.find((row) => row.label === label)?.value ?? fallback;
}

function hasMeaningfulValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return Boolean(
    normalized &&
      normalized !== "n/a" &&
      normalized !== "not recorded" &&
      normalized !== "not reported" &&
      normalized !== "off"
  );
}

function titleCaseEvidenceType(value: string): string {
  if (!value.trim()) return "Digital evidence record";

  return value
    .replace(/\bMedia\b/g, "media")
    .replace(/\bEvidence\b/g, "evidence")
    .replace(/\bPackage\b/g, "package")
    .replace(/\bRecord\b/g, "record");
}

function buildCoverSubtitle(vm: ReportViewModel): string {
  const summary = vm.contentSummary;

  const kinds = [
    summary.videoCount > 0 ? "Video" : null,
    summary.imageCount > 0 ? "Image" : null,
    summary.pdfCount > 0 ? "PDF" : null,
    summary.audioCount > 0 ? "Audio" : null,
    summary.textCount > 0 ? "Text" : null,
    summary.otherCount > 0 ? "Other" : null,
  ].filter(Boolean) as string[];

  const structure =
    summary.itemCount > 1 ? "Multipart evidence package" : "Single evidence item";

  const itemLabel = `${summary.itemCount} item${
    summary.itemCount === 1 ? "" : "s"
  }`;

  const kindLabel = kinds.length > 0 ? kinds.join(", ") : "Digital evidence";
  const sizeLabel =
    summary.totalSizeDisplay || vm.meta.fileSizeLabel || "Size not recorded";

  return `${structure} • ${itemLabel} • ${kindLabel} • ${sizeLabel}`;
}

function renderDecisionIndicator(params: {
  label: string;
  value: string;
  tone: "success" | "warning" | "danger";
}): string {
  // The compact value is THE canonical layer/state label (getTrustLayerStateLabel),
  // passed in by the caller: only the PASSED state of a layer reads as verified or anchored.
  const compactValue = params.value;

  return `
    <div class="cover-decision-indicator tone-${params.tone}">
      <div class="cover-decision-line">
        <span class="cover-decision-mark">
          ${params.tone === "success" ? "✓" : "!"}
        </span>
        <span class="cover-decision-label">
          ${escapeHtml(params.label)}
        </span>
      </div>

      <div class="cover-decision-value">
        ${escapeHtml(compactValue)}
      </div>
    </div>
  `;
}

function renderCoverEvidenceVisual(vm: ReportViewModel): string {
  const hero = vm.presentation.buckets.heroItem;

  if (!hero) {
    return `
      <div class="cover-evidence-visual cover-evidence-placeholder">
        <div class="cover-evidence-placeholder-kind">EVIDENCE</div>
        <div class="cover-evidence-placeholder-note">
          Evidence represented by preserved metadata and technical references.
        </div>
      </div>
    `;
  }

  const asset = hero.asset;
  const fileName = safe(
    asset.originalFileName || asset.label,
    "Unnamed evidence item"
  );

  if (asset.previewDataUrl) {
    return `
      <div class="cover-evidence-visual">
        <img src="${asset.previewDataUrl}" alt="${escapeHtml(fileName)}" />
      </div>
    `;
  }

  return `
    <div class="cover-evidence-visual cover-evidence-placeholder">
      <div class="cover-evidence-placeholder-kind">${escapeHtml(
        hero.previewRenderKind.toUpperCase()
      )}</div>
      <div class="cover-evidence-placeholder-note">
        Evidence represented by preserved metadata and technical references.
      </div>
    </div>
  `;
}

export function renderCoverSection(vm: ReportViewModel): string {
  // The cover states the per-signal matrix and its bounded summary — never an
  // overall verdict, a confidence or a score. Its tone follows file integrity:
  // FAILED is danger, VERIFIED with nothing unchecked is success.
  const matrix = vm.verificationMatrix;
  const statusOf = (key: string) => matrix.rows.find((row) => row.key === key)?.status ?? "UNAVAILABLE";
  const fileIntegrity = statusOf("file_integrity");
  const anyFailed = matrix.rows.some((row) => row.status === "FAILED");
  const presentationTone = anyFailed
    ? "danger"
    : fileIntegrity === "VERIFIED" && !matrix.rows.some((row) => row.status === "NOT_CHECKED")
      ? "success"
      : "warning";

  const integrityBadgeClass =
    presentationTone === "success"
      ? "badge-success"
      : presentationTone === "danger"
        ? "badge-danger"
        : "badge-warning";

  const integrityBadgeText = `File integrity ${fileIntegrity}`;
  const primaryItemCount = vm.contentItems.filter(
    (item) => item.artifactRole === "primary_evidence"
  ).length;

  const primaryHash =
    vm.primaryContentItem?.sha256 ||
    vm.technicalAppendix.fileSha256 ||
    "Not recorded";

  const evidenceType = titleCaseEvidenceType(
    vm.meta.publicEvidenceTypeLabel || "Digital evidence record"
  );

  const anchoringLabel = findRowValue(vm.storageRows, "Bitcoin Anchoring Status");

  const leadItemLabel = safe(
    vm.primaryContentItem?.originalFileName || vm.primaryContentItem?.label,
    "No identified lead item"
  );
  const leadItemDisplayLabel =
    primaryItemCount > 1
      ? `Primary evidence set (${primaryItemCount} items)`
      : leadItemLabel;

  const reportMode =
    vm.presentationMode === "simple"
      ? "Compact review report"
      : vm.presentationMode === "medium"
        ? "Balanced review report"
        : "Full forensic report";

  const verifyUrl = vm.verifyUrl.trim();

  // UC-TRUST-008 — the report says which stored bytes it certifies, and as
  // of when; it is not a statement about the stored object afterwards.
  const certified = vm.certifiedOriginal;
  const certifiedBlock = certified
    ? `<div class="cover-verify-hint" data-certified-original>
        Certifies the original with SHA-256 ${escapeHtml(certified.recordedSha256)}
        (stored object version${certified.objectVersionIds.length === 1 ? "" : "s"}
        ${escapeHtml(certified.objectVersionIds.map((v) => v ?? "unversioned").join(", "))}),
        re-read from storage and matched to the signed fingerprint at ${escapeHtml(certified.rereadAtUtc)}.
        Later changes to the stored object are not covered by this report; check Public Verify for its current state.
      </div>`
    : "";

  // UC-OUT-001 — a private record's report prints no verification link: the
  // page would answer "not found" to every reader. It says so, and who can
  // change it.
  const verificationBlock = vm.publicVerificationPublished === false
    ? `
    <div class="cover-verify-texts" data-public-verification="not-published">
      <div class="cover-verify-title">Public Verification</div>
      <div class="cover-verify-hint">Not published — the owner can create a verification link</div>
      <div class="cover-verify-hint">This record was private when this report was issued, so no public verification link is printed. Its owner can publish it and share a verification link.</div>
      ${certifiedBlock}
    </div>
  `
    : `
    <div class="cover-verify-qr-wrap">
      ${
        vm.qr.publicDataUrl
          ? renderInlineQrBlock(vm.qr.publicDataUrl, vm.qr.publicLabel)
          : `<div class="cover-verify-placeholder">QR unavailable</div>`
      }
    </div>
    <div class="cover-verify-texts">
      <div class="cover-verify-title">Public Verification</div>
      <div class="cover-verify-hint">Scan QR code or open verification page</div>
      ${certifiedBlock}
      <a
        class="cover-verify-url"
        href="${escapeHtml(verifyUrl)}"
        target="_blank"
        rel="noopener noreferrer"
      >${escapeHtml(verifyUrl)}</a>
    </div>
  `;


  return `
    <section class="report-cover report-cover-premium cover-tone-${presentationTone}">
      <div class="cover-certificate-card cover-tone-${presentationTone}">
        <div class="cover-certificate-top">
          <img
            class="cover-header-lockup"
            src="${escapeHtml(coverHeaderLockupUrl)}"
            alt="PROOVRA — Integrity in Every Evidence"
          />

          <div class="cover-top-badge badge ${integrityBadgeClass}">
            ${escapeHtml(integrityBadgeText)}
          </div>
        </div>

        <div class="cover-certificate-body cover-premium-body">
          <div class="cover-decision-hero">
            <div class="cover-eyebrow">Decision Page</div>

            <h1 class="cover-certificate-title">
              Digital Evidence Verification Record
            </h1>

            <div class="cover-certificate-subtitle">
              ${escapeHtml(buildCoverSubtitle(vm))}
            </div>

            <div class="cover-status-stamp ${integrityBadgeClass}">
              <span>${presentationTone === "success" ? "✓" : "!"}</span>
              <strong>File integrity ${escapeHtml(fileIntegrity)} · PROOVRA custody chain ${escapeHtml(statusOf("custody_chain"))}</strong>
            </div>

            <div class="cover-status-subtitle" data-verification-summary>
              ${escapeHtml(matrix.summary)}
            </div>
          </div>

          <div class="cover-decision-grid cover-trust-signal-grid">
            ${matrix.rows
              .filter((row) =>
                ["file_integrity", "record_signature", "tsa_token", "ots_anchoring", "storage_protection"].includes(row.key)
              )
              .map((row) => {
                const tone = verificationStatusTone(row.status);
                return renderDecisionIndicator({
                  label: row.label,
                  value: row.status,
                  tone: tone === "neutral" ? "warning" : tone,
                });
              })
              .join("")}
          </div>
                    <div class="cover-main-grid">
            <div class="cover-evidence-panel">
              ${renderCoverEvidenceVisual(vm)}

              <div class="cover-evidence-meta">
                <div class="cover-panel-title">Evidence Snapshot</div>

                <div class="cover-snapshot-grid">
                  <div>
                    <div class="cover-meta-label">Evidence Type</div>
                    <div class="cover-meta-value">${escapeHtml(evidenceType)}</div>
                  </div>
                  <div>
                    <div class="cover-meta-label">Structure</div>
                    <div class="cover-meta-value">${escapeHtml(vm.structureLabel)}</div>
                  </div>
                  <div>
                    <div class="cover-meta-label">Item Count</div>
                    <div class="cover-meta-value">${escapeHtml(
                      String(vm.contentSummary.itemCount)
                    )}</div>
                  </div>
                  <div>
<div class="cover-meta-label">${
  primaryItemCount > 1 ? "Primary Evidence Set" : "Lead Item"
}</div>
<div class="cover-meta-value">${escapeHtml(leadItemDisplayLabel)}</div>
                  </div>
                </div>
              </div>
            </div>

            <div class="cover-verify-box cover-verify-box-premium">
              ${verificationBlock}
            </div>
          </div>

          <div class="cover-meta-grid">
            <div class="cover-meta-card">
              <div class="cover-meta-label">Evidence Reference</div>
              <div class="cover-meta-value">${escapeHtml(vm.evidenceReference)}</div>
            </div>

            <div class="cover-meta-card">
              <div class="cover-meta-label">Generated UTC</div>
              <div class="cover-meta-value">${escapeHtml(formatTimestampForReportUtc(vm.generatedAtUtc))}</div>
            </div>

            <div class="cover-meta-card">
              <div class="cover-meta-label">Report Mode</div>
              <div class="cover-meta-value">${escapeHtml(reportMode)}</div>
            </div>

            <div class="cover-meta-card">
              <div class="cover-meta-label">Verification Status</div>
              <div class="cover-meta-value">${escapeHtml(vm.verificationStatusLabel)}</div>
            </div>
            ${
              hasMeaningfulValue(anchoringLabel)
                ? `
                  <div class="cover-meta-card">
                    <div class="cover-meta-label">Anchoring</div>
                    <div class="cover-meta-value">${escapeHtml(anchoringLabel)}</div>
                  </div>
                `
                : ""
            }

            <div class="cover-meta-card">
              <div class="cover-meta-label">Evidence Status At Report Generation</div>
              <div class="cover-meta-value">${escapeHtml(vm.recordStatusLabel)}</div>
            </div>

            <div class="cover-meta-card cover-meta-card-wide">
<div class="cover-meta-label">${
  vm.contentSummary.itemCount > 1
    ? "Lead item SHA-256 (multipart package — per-part hashes follow)"
    : "Original file SHA-256"
}</div>
              <div class="cover-meta-value cover-meta-value-code cover-primary-hash">
                ${escapeHtml(primaryHash)}
              </div>
            </div>
          </div>

<div class="cover-boundary-note cover-boundary-inline">
  <div class="cover-boundary-title">Report Boundary.</div>
  <div class="cover-boundary-body">
    ${escapeHtml(vm.canonicalMaterials.legalBoundary.reportBoundary)}
  </div>
  <div class="cover-boundary-followup">
    For technical validation, use the verification page and appendix.
  </div>
</div>
      </div>
    </section>
  `;
}
