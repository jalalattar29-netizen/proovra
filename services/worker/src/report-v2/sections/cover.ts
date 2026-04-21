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

function renderCoverEvidenceIdentity(vm: ReportViewModel): string {
  const hero = vm.presentation.buckets.heroItem;
  if (!hero) return "";

  const asset = hero.asset;
  const fileName = safe(
    asset.originalFileName || asset.label,
    "Unnamed evidence item"
  );

  const visualBlock = `
    <div class="cover-evidence-visual cover-evidence-placeholder">
      <div class="cover-evidence-placeholder-kind">${escapeHtml(
        hero.previewRenderKind.toUpperCase()
      )}</div>
      <div class="cover-evidence-placeholder-note">
        Lead evidence preview appears once in Evidence Presentation to keep the PDF compact.
      </div>
    </div>
  `;

  return `
    <div class="cover-evidence-panel">
      ${visualBlock}
      <div class="cover-evidence-meta">
        <div class="cover-meta-label">Lead Evidence Identity</div>
        <div class="cover-evidence-name">${escapeHtml(fileName)}</div>
        <div class="cover-evidence-facts">
          <span>${escapeHtml(safe(asset.kind, "Not recorded"))}</span>
          <span>${escapeHtml(safe(asset.displaySizeLabel, "N/A"))}</span>
        </div>
      </div>
    </div>
  `;
}

export function renderCoverSection(vm: ReportViewModel): string {
  const integrityBadgeClass = vm.integrityVerified
    ? "badge-success"
    : "badge-danger";
  const integrityBadgeText = vm.integrityVerified
    ? "Recorded Integrity Verified"
    : "Recorded Integrity Review Required";

  const primaryHash = vm.primaryContentItem?.sha256 || vm.technicalAppendix.fileSha256;

  const evidenceType = vm.meta.publicEvidenceTypeLabel || "Digital Evidence Record";
  const itemCount = String(vm.contentSummary.itemCount);
  const storageLabel = findRowValue(vm.storageRows, "Immutable Storage");
  const timestampLabel = findRowValue(vm.storageRows, "RFC 3161 Status");
  const anchoringLabel = findRowValue(vm.storageRows, "Public Anchoring Status");
  const leadItemLabel = safe(
    vm.primaryContentItem?.originalFileName || vm.primaryContentItem?.label,
    "No identified lead item"
  );

  const verificationBlock = vm.qr.publicDataUrl
    ? `
      <div class="cover-verify-qr-wrap">
        ${renderInlineQrBlock(vm.qr.publicDataUrl, vm.qr.publicLabel)}
      </div>
      <div class="cover-verify-texts">
        <div class="cover-verify-title">Verification Access</div>
        <div class="cover-verify-url">${escapeHtml(vm.verifyUrl)}</div>
      </div>
    `
    : `
      <div class="cover-verify-qr-wrap">
        <div class="cover-verify-placeholder">QR unavailable</div>
      </div>
      <div class="cover-verify-texts">
        <div class="cover-verify-title">Verification Access</div>
        <div class="cover-verify-url">${escapeHtml(vm.verifyUrl)}</div>
      </div>
    `;

  return `
    <div class="report-header-band"></div>

    <section class="report-cover report-cover-premium">
      <div class="cover-certificate-card">
        <div class="cover-certificate-top">
          <div class="cover-brand-lockup">
            <div class="cover-brand-mini">PROOVRA</div>
            <div class="cover-brand-sub">Verifiable Evidence Report</div>
          </div>

          <div class="cover-top-badge badge ${integrityBadgeClass}">
            ${escapeHtml(integrityBadgeText)}
          </div>
        </div>

        <div class="cover-certificate-body cover-premium-body">
          <div class="cover-left-column">
            <div class="cover-eyebrow">Digital Evidence Integrity Record</div>

            <h1 class="cover-certificate-title">
              ${escapeHtml(vm.title)}
            </h1>

            ${
              vm.subtitle
                ? `<div class="cover-certificate-subtitle">${escapeHtml(vm.subtitle)}</div>`
                : ""
            }

            <div class="cover-hero-summary">
              <div class="cover-hero-summary-item">
                <span class="cover-hero-summary-label">Evidence Type</span>
                <span class="cover-hero-summary-value">${escapeHtml(evidenceType)}</span>
              </div>
              <div class="cover-hero-summary-item">
                <span class="cover-hero-summary-label">Package Structure</span>
                <span class="cover-hero-summary-value">${escapeHtml(vm.structureLabel)}</span>
              </div>
              <div class="cover-hero-summary-item">
                <span class="cover-hero-summary-label">Item Count</span>
                <span class="cover-hero-summary-value">${escapeHtml(itemCount)}</span>
              </div>
              <div class="cover-hero-summary-item">
                <span class="cover-hero-summary-label">Lead Review Item</span>
                <span class="cover-hero-summary-value">${escapeHtml(leadItemLabel)}</span>
              </div>
            </div>

            <div class="cover-meta-grid">
              <div class="cover-meta-card">
                <div class="cover-meta-label">Generated (UTC)</div>
                <div class="cover-meta-value">${escapeHtml(vm.generatedAtUtc)}</div>
              </div>

              <div class="cover-meta-card">
                <div class="cover-meta-label">Evidence Reference</div>
                <div class="cover-meta-value">${escapeHtml(vm.evidenceReference)}</div>
              </div>

              <div class="cover-meta-card">
                <div class="cover-meta-label">Report Mode</div>
                <div class="cover-meta-value">${escapeHtml(
                  vm.presentationMode === "simple"
                    ? "Compact evidentiary report"
                    : vm.presentationMode === "medium"
                      ? "Balanced evidentiary report"
                      : "Full forensic report"
                )}</div>
              </div>

              <div class="cover-meta-card cover-meta-card-wide">
                <div class="cover-meta-label">Primary SHA-256 / Recorded Digest</div>
                <div class="cover-meta-value cover-meta-value-code">${escapeHtml(primaryHash)}</div>
              </div>
            </div>

            ${renderCoverEvidenceIdentity(vm)}
          </div>

          <div class="cover-right-column">
            <div class="cover-verify-box cover-verify-box-premium">
              ${verificationBlock}
            </div>

            <div class="cover-status-panel">
              <div class="cover-status-row">
                <span class="cover-status-name">Storage Protection</span>
                <span class="cover-status-value">${escapeHtml(storageLabel)}</span>
              </div>
              <div class="cover-status-row">
                <span class="cover-status-name">Trusted Timestamp</span>
                <span class="cover-status-value">${escapeHtml(timestampLabel)}</span>
              </div>
              <div class="cover-status-row">
                <span class="cover-status-name">Public Anchoring</span>
                <span class="cover-status-value">${escapeHtml(anchoringLabel)}</span>
              </div>
              <div class="cover-status-row">
                <span class="cover-status-name">Record Status</span>
                <span class="cover-status-value">${escapeHtml(vm.recordStatusLabel)}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="cover-certificate-bottom cover-certificate-bottom-premium">
          <span>System Signed</span>
          <span>Fingerprint Recorded</span>
          <span>Custody Recorded</span>
          <span>Timestamp State Preserved</span>
          <span>Storage State Preserved</span>
        </div>
      </div>
    </section>
  `;
}
