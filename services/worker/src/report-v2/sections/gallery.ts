import { ReportEvidenceAsset, ReportViewModel } from "../types.js";
import { escapeHtml, safe } from "../formatters.js";
import { renderCallout, renderPageSection } from "../ui.js";

function renderGalleryMetaRow(label: string, value: string): string {
  return `
    <div class="gallery-meta-row">
      <div class="gallery-meta-label">${escapeHtml(label)}</div>
      <div class="gallery-meta-value">${escapeHtml(value)}</div>
    </div>
  `;
}

function renderPrimaryPreview(item: ReportEvidenceAsset): string {
  const fileName =
    safe(item.originalFileName, "") || safe(item.label, "Unnamed evidence item");

  if (item.previewDataUrl) {
    return `
      <div class="gallery-thumb gallery-thumb-emphasis">
        <img src="${item.previewDataUrl}" alt="${escapeHtml(fileName)}" />
      </div>
    `;
  }

  if (item.kind === "text" && item.previewTextExcerpt) {
    return `
      <div class="gallery-thumb gallery-thumb-text gallery-thumb-emphasis">
        <div class="gallery-thumb-text-inner">
          <div class="gallery-thumb-text-title">Primary text excerpt</div>
          <div class="gallery-thumb-text-body">${escapeHtml(
            item.previewTextExcerpt
          )}</div>
        </div>
      </div>
    `;
  }

  return `
    <div class="gallery-thumb gallery-thumb-emphasis">
      <div class="gallery-thumb-placeholder">
        <div class="gallery-thumb-placeholder-title">${escapeHtml(
          safe(item.kind, "Evidence item").toUpperCase()
        )}</div>
        <div class="gallery-thumb-placeholder-note">
          Primary evidence preview is not embedded in this PDF. Review the preserved item through the verification workflow when visual inspection is required.
        </div>
      </div>
    </div>
  `;
}

function renderPrimaryPanel(item: ReportEvidenceAsset): string {
  const fileName =
    safe(item.originalFileName, "") || safe(item.label, "Unnamed evidence item");

  return `
    <div class="gallery-primary">
      <article class="gallery-card gallery-card-emphasis">
        <div class="gallery-card-header">
          <div class="gallery-card-topline">
            <div class="gallery-card-index">Primary evidence</div>
            <div class="gallery-card-role">Lead review item</div>
          </div>
          <div class="gallery-card-file-name">${escapeHtml(fileName)}</div>
          ${
            item.label && item.label !== fileName
              ? `<div class="gallery-card-display-label">${escapeHtml(item.label)}</div>`
              : ""
          }
        </div>
        ${renderPrimaryPreview(item)}
      </article>

      <article class="gallery-card">
        <div class="gallery-card-header">
          <div class="gallery-card-file-name">Primary item metadata</div>
          <div class="gallery-card-display-label">
            Exact preserved identifiers for the lead review item.
          </div>
        </div>
        <div class="gallery-card-meta">
          ${renderGalleryMetaRow("Evidence Type", safe(item.kind, "Not recorded"))}
          ${renderGalleryMetaRow("MIME / Format", safe(item.mimeType, "N/A"))}
          ${renderGalleryMetaRow("Display Size", safe(item.displaySizeLabel, "N/A"))}
          ${renderGalleryMetaRow(
            "Access State",
            item.downloadable ? "Downloadable under policy" : "Restricted under policy"
          )}
          ${renderGalleryMetaRow("SHA-256", item.sha256 ?? "Not recorded")}
        </div>
      </article>
    </div>
  `;
}

function renderSecondaryItem(item: ReportEvidenceAsset): string {
  const fileName =
    safe(item.originalFileName, "") || safe(item.label, "Unnamed evidence item");

  return `
    <article class="gallery-secondary-item">
      <div class="gallery-secondary-name">${escapeHtml(fileName)}</div>
      <div class="gallery-secondary-grid">
        <div class="gallery-meta-label">Role</div>
        <div class="gallery-meta-value">${escapeHtml(
          item.isPrimary ? "Primary evidence" : "Supporting evidence"
        )}</div>

        <div class="gallery-meta-label">Type</div>
        <div class="gallery-meta-value">${escapeHtml(safe(item.kind, "Not recorded"))}</div>

        <div class="gallery-meta-label">Format</div>
        <div class="gallery-meta-value">${escapeHtml(safe(item.mimeType, "N/A"))}</div>

        <div class="gallery-meta-label">Size</div>
        <div class="gallery-meta-value">${escapeHtml(
          safe(item.displaySizeLabel, "N/A")
        )}</div>

        <div class="gallery-meta-label">SHA-256</div>
        <div class="gallery-meta-value hash-text">${escapeHtml(
          item.sha256 ?? "Not recorded"
        )}</div>
      </div>
    </article>
  `;
}

export function renderGallerySection(vm: ReportViewModel): string {
  if (vm.contentItems.length === 0) return "";

  const primaryItem =
    vm.primaryContentItem ??
    vm.contentItems.find((item) => item.isPrimary) ??
    vm.contentItems[0] ??
    null;

  if (!primaryItem) return "";

  const supportingItems = vm.contentItems.filter((item) => item.id !== primaryItem.id);

  return renderPageSection(
    "Evidence Presentation",
    `
      ${renderCallout({
        title: "Presentation policy",
        body:
          "This report embeds one primary reviewer-facing preview only. Supporting preserved items are listed as metadata records with exact identifiers so the PDF remains professional, lightweight, and legally precise.",
        tone: "neutral",
      })}

      ${renderPrimaryPanel(primaryItem)}

      ${
        supportingItems.length > 0
          ? `
            ${renderCallout({
              title: "Supporting preserved items",
              body:
                "Supporting evidence is intentionally presented without embedded previews. Each item remains part of the preserved package and is identified below by exact metadata and full SHA-256 value.",
              tone: "neutral",
            })}
            <div class="gallery-secondary-list">
              ${supportingItems.map(renderSecondaryItem).join("")}
            </div>
          `
          : ""
      }
    `,
    { pageBreakBefore: true }
  );
}
