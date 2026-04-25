// D:\digital-witness\services\worker\src\report-v2\sections\cover.ts
import { ReportViewModel } from "../types.js";
import { escapeHtml, safe } from "../formatters.js";
import { renderInlineQrBlock } from "../ui.js";

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

function statusTone(value: string, positiveWords: string[]): "success" | "warning" {
  const normalized = value.toLowerCase();
  return positiveWords.some((word) => normalized.includes(word))
    ? "success"
    : "warning";
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
  tone: "success" | "warning";
}): string {
  return `
    <div class="cover-decision-indicator tone-${params.tone}">
      <div class="cover-decision-mark">${params.tone === "success" ? "✓" : "!"}</div>
      <div class="cover-decision-copy">
        <div class="cover-decision-label">${escapeHtml(params.label)}</div>
        <div class="cover-decision-value">${escapeHtml(params.value)}</div>
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
  const integrityBadgeClass = vm.integrityVerified
    ? "badge-success"
    : "badge-warning";

  const integrityBadgeText = vm.integrityVerified ? "Verified" : "Review Required";

  const primaryHash =
    vm.primaryContentItem?.sha256 ||
    vm.technicalAppendix.fileSha256 ||
    "Not recorded";

  const evidenceType = titleCaseEvidenceType(
    vm.meta.publicEvidenceTypeLabel || "Digital evidence record"
  );

  const storageLabel = findRowValue(vm.storageRows, "Immutable Storage");
  const timestampLabel = findRowValue(vm.storageRows, "RFC 3161 Status");
  const anchoringLabel = findRowValue(vm.storageRows, "Public Anchoring Status");

  const timestampTone = statusTone(timestampLabel, [
    "recorded",
    "granted",
    "verified",
    "valid",
    "success",
    "trusted timestamp",
  ]);

  const storageTone = statusTone(storageLabel, [
    "verified",
    "protected",
    "immutable",
    "compliance",
    "governance",
    "locked",
  ]);

  const custodyLabel =
    vm.forensicRows.length > 0
      ? `${vm.forensicRows.length} forensic event${
          vm.forensicRows.length === 1 ? "" : "s"
        } recorded`
      : "No custody events recorded";

  const leadItemLabel = safe(
    vm.primaryContentItem?.originalFileName || vm.primaryContentItem?.label,
    "No identified lead item"
  );

  const reportMode =
    vm.presentationMode === "simple"
      ? "Compact review report"
      : vm.presentationMode === "medium"
        ? "Balanced review report"
        : "Full forensic report";

  const verifyUrl = vm.verifyUrl.trim();

  const verificationBlock = `
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
      <a
        class="cover-verify-url"
        href="${escapeHtml(verifyUrl)}"
        target="_blank"
        rel="noopener noreferrer"
      >${escapeHtml(verifyUrl)}</a>
    </div>
  `;

  return `
    <section class="report-cover report-cover-premium">
      <div class="cover-certificate-card">
        <div class="cover-certificate-top">
          <div class="cover-brand-row">
            <span class="cover-brand-icon" aria-hidden="true"></span>
            <div class="cover-brand-lockup">
              <div class="cover-brand-mini">PROOVRA</div>
              <div class="cover-brand-sub">Evidence Verification Report</div>
            </div>
          </div>

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
              <span>${vm.integrityVerified ? "✓" : "!"}</span>
              <strong>${escapeHtml(
                vm.integrityVerified
                  ? "Integrity Verified"
                  : "Technical Review Required"
              )}</strong>
            </div>

            <div class="cover-status-subtitle">
              ${escapeHtml(
                vm.integrityVerified
                  ? "No post-recording modification detected in the preserved evidence state."
                  : "Manual technical review is required before relying on this evidence state."
              )}
            </div>
          </div>

          <div class="cover-decision-grid">
            ${renderDecisionIndicator({
              label: "Integrity",
              value: vm.integrityVerified ? "No mismatch detected" : "Review required",
              tone: vm.integrityVerified ? "success" : "warning",
            })}
            ${renderDecisionIndicator({
              label: "Timestamp",
              value:
                timestampTone === "success"
                  ? "External trusted timestamp recorded"
                  : timestampLabel,
              tone: timestampTone,
            })}
            ${renderDecisionIndicator({
              label: "Storage",
              value:
                storageTone === "success"
                  ? "Immutable retention verified"
                  : storageLabel,
              tone: storageTone,
            })}
            ${renderDecisionIndicator({
              label: "Custody",
              value: custodyLabel,
              tone: vm.forensicRows.length > 0 ? "success" : "warning",
            })}
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
                    <div class="cover-meta-label">Lead Item</div>
                    <div class="cover-meta-value">${escapeHtml(leadItemLabel)}</div>
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
              <div class="cover-meta-value">${escapeHtml(vm.generatedAtUtc)}</div>
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
              <div class="cover-meta-label">Record Status</div>
              <div class="cover-meta-value">${escapeHtml(vm.recordStatusLabel)}</div>
            </div>

            <div class="cover-meta-card cover-meta-card-wide">
              <div class="cover-meta-label">Primary SHA-256 / Recorded Digest</div>
              <div class="cover-meta-value cover-meta-value-code cover-primary-hash">
                ${escapeHtml(primaryHash)}
              </div>
            </div>
          </div>

<div class="cover-meta-card cover-meta-card-wide">
  <div class="cover-meta-label">Primary SHA-256 / Recorded Digest</div>
  <div class="cover-meta-value cover-meta-value-code cover-primary-hash">
    ${escapeHtml(primaryHash)}
  </div>
</div>

<div class="cover-boundary-note cover-boundary-inline">
  <strong>Report Boundary.</strong>
  This report verifies integrity state, preservation controls, timestamps,
  storage state, and custody records. It does not independently prove truth,
  authorship, context, intent, admissibility, or evidentiary weight.
  <span class="cover-boundary-followup">
    For technical validation, use the verification page and appendix.
  </span>
</div>
        </div>

        <div class="cover-certificate-bottom cover-certificate-bottom-premium">
          <span>System Signed</span>
          <span>Fingerprint Recorded</span>
          <span>Custody Preserved</span>
          <span>Timestamped</span>
          <span>Storage Protected</span>
        </div>
      </div>
    </section>
  `;
}