import { ReportViewModel } from "../types.js";
import { escapeHtml } from "../formatters.js";

export function renderCoverSection(vm: ReportViewModel): string {
  const integrityBadgeClass = vm.integrityVerified
    ? "badge-success"
    : "badge-danger";
  const integrityBadgeText = vm.integrityVerified
    ? "Recorded Integrity Verified"
    : "Recorded Integrity Review Required";

  return `
    <div class="report-header-band"></div>

    <section class="report-cover">
      <div class="brand-lockup">
        <div class="brand-name">PROOVRA</div>
        <div class="brand-report-title">Verification Report</div>
        <div class="brand-tagline">Capture truth. Prove it forever.</div>

        <div class="cover-title">${escapeHtml(vm.title)}</div>
        ${
          vm.subtitle
            ? `<div class="cover-subtitle">${escapeHtml(vm.subtitle)}</div>`
            : ""
        }
      </div>

      <div class="cover-side">
        <div class="cover-panel">
          <div class="badge ${integrityBadgeClass}">${escapeHtml(
            integrityBadgeText
          )}</div>
        </div>

        <div class="cover-panel">
          <div class="kv-label">Evidence Reference</div>
          <div class="kv-value">${escapeHtml(vm.evidenceReference)}</div>
        </div>

        <div class="cover-panel">
          <div class="kv-label">Record Status</div>
          <div class="kv-value">${escapeHtml(vm.recordStatusLabel)}</div>
        </div>

        <div class="cover-panel">
          <div class="kv-label">Verification Status</div>
          <div class="kv-value">${escapeHtml(vm.verificationStatusLabel)}</div>
        </div>

        <div class="cover-panel">
          <div class="kv-label">Generated (UTC)</div>
          <div class="kv-value">${escapeHtml(vm.generatedAtUtc)}</div>
        </div>
      </div>
    </section>
  `;
}