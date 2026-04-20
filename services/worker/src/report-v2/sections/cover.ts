import { ReportViewModel } from "../types.js";
import { escapeHtml } from "../formatters.js";
import { renderInlineQrBlock } from "../ui.js";

export function renderCoverSection(vm: ReportViewModel): string {
  const integrityBadgeClass = vm.integrityVerified
    ? "badge-success"
    : "badge-danger";
  const integrityBadgeText = vm.integrityVerified
    ? "VERIFIED AUTHENTIC"
    : "REVIEW REQUIRED";

  const shortHash =
    vm.meta.primaryHashShort && vm.meta.primaryHashShort !== "N/A"
      ? vm.meta.primaryHashShort
      : vm.evidenceReference;

  const storageLabel =
    vm.storageRows.find((row) => row.label === "Immutable Storage")?.value ??
    "Not recorded";

  const timestampLabel =
    vm.meta.timestampRows.find((row) => row.label === "Timestamp Status")?.value ??
    "Not recorded";

  const verificationBlock = vm.qr.publicDataUrl
    ? `
      ${renderInlineQrBlock(vm.qr.publicDataUrl, vm.qr.publicLabel)}
      <div class="cover-verify-title">Verification Access</div>
      <div class="cover-verify-url">${escapeHtml(vm.verifyUrl)}</div>
    `
    : `
      <div class="cover-verify-placeholder">QR unavailable</div>
      <div class="cover-verify-title">Verification Access</div>
      <div class="cover-verify-url">${escapeHtml(vm.verifyUrl)}</div>
    `;

  return `
    <div class="report-header-band"></div>

    <section class="report-cover report-cover-certificate">
      <div class="cover-certificate-card">
        <div class="cover-certificate-top">
          <div class="cover-brand-mini">PROOVRA</div>
        </div>

        <div class="cover-certificate-body">
          <div class="cover-certificate-title">VERIFIABLE EVIDENCE REPORT</div>

          <div class="cover-certificate-divider"></div>

          <div class="cover-certificate-subtitle">
            ${escapeHtml(vm.title)}
          </div>

          <div class="cover-status-wrap">
            <div class="badge ${integrityBadgeClass}">
              ${escapeHtml(integrityBadgeText)}
            </div>
          </div>

          <div class="cover-meta-stack">
            <div class="cover-meta-line">
              <span class="cover-meta-label">Generated on</span>
              <span class="cover-meta-value">${escapeHtml(vm.generatedAtUtc)}</span>
            </div>

            <div class="cover-meta-line">
              <span class="cover-meta-label">Evidence Ref</span>
              <span class="cover-meta-value">${escapeHtml(vm.evidenceReference)}</span>
            </div>

            <div class="cover-meta-line">
              <span class="cover-meta-label">Hash</span>
              <span class="cover-meta-value">${escapeHtml(shortHash)}</span>
            </div>
          </div>

          <div class="cover-verify-box">
            ${verificationBlock}
          </div>
        </div>

        <div class="cover-certificate-bottom">
          <span>Signed</span>
          <span>Timestamped</span>
          <span>Custody Recorded</span>
          <span>${escapeHtml(storageLabel)}</span>
          <span>${escapeHtml(timestampLabel)}</span>
        </div>
      </div>
    </section>
  `;
}