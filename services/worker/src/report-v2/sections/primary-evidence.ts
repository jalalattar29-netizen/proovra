import { ReportViewModel } from "../types.js";
import { escapeHtml } from "../formatters.js";
import { renderPageSection } from "../ui.js";

function renderPreview(vm: ReportViewModel): string {
  const item = vm.primaryContentItem;
  if (!item) {
    return `<div class="gallery-thumb-placeholder">No primary evidence item identified.</div>`;
  }

  if (item.previewDataUrl) {
    return `<img src="${item.previewDataUrl}" alt="${escapeHtml(item.label)}" />`;
  }

  return `
    <div class="gallery-thumb-placeholder">
      ${escapeHtml(item.kind.toUpperCase())}<br>
      Preview unavailable in embedded report
    </div>
  `;
}

export function renderPrimaryEvidenceSection(vm: ReportViewModel): string {
  if (!vm.primaryContentItem) return "";

  const item = vm.primaryContentItem;

  return renderPageSection(
    "Primary Evidence Spotlight",
    `
      <div class="hero-evidence">
        <div class="hero-preview">
          ${renderPreview(vm)}
        </div>
        <div class="hero-meta">
          <div class="hero-title">${escapeHtml(item.label)}</div>
          <div class="hero-note">
            This primary evidence item is surfaced as the lead reviewer reference.
            The preserved original remains authoritative, while any embedded representation
            in this report is provided only to support human review.
          </div>

          <div class="kv-grid">
            <div class="kv-item">
              <div class="kv-label">Kind</div>
              <div class="kv-value">${escapeHtml(item.kind)}</div>
            </div>
            <div class="kv-item">
              <div class="kv-label">MIME Type</div>
              <div class="kv-value">${escapeHtml(item.mimeType ?? "N/A")}</div>
            </div>
            <div class="kv-item">
              <div class="kv-label">Display Size</div>
              <div class="kv-value">${escapeHtml(
                item.displaySizeLabel ?? "N/A"
              )}</div>
            </div>
            <div class="kv-item">
              <div class="kv-label">Previewable</div>
              <div class="kv-value">${item.previewable ? "Yes" : "No"}</div>
            </div>
          </div>
        </div>
      </div>
    `
  );
}