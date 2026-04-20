import { ReportEvidenceAsset, ReportViewModel } from "../types.js";
import { escapeHtml, safe, shortHash } from "../formatters.js";
import { renderCallout, renderPageSection } from "../ui.js";

function renderGalleryMetaRow(label: string, value: string): string {
  return `
    <div class="gallery-meta-row">
      <div class="gallery-meta-label">${escapeHtml(label)}</div>
      <div class="gallery-meta-value">${escapeHtml(value)}</div>
    </div>
  `;
}

function buildAccessLabel(item: ReportEvidenceAsset): string {
  const parts = [
    item.previewable ? "Previewable" : "Preview unavailable",
    item.downloadable ? "Downloadable" : "Restricted",
  ];

  return parts.join(" • ");
}

function renderGalleryCard(
  item: ReportEvidenceAsset,
  opts?: { emphasize?: boolean }
): string {
  const fileName =
    safe(item.originalFileName, "") || safe(item.label, "Unnamed evidence item");
  const displayLabel =
    safe(item.label, "") && safe(item.label, "") !== fileName
      ? safe(item.label)
      : null;

  return `
    <article class="gallery-card${
      opts?.emphasize ? " gallery-card-emphasis" : ""
    }">
      <div class="gallery-card-header">
        <div class="gallery-card-index">Item ${item.index + 1}</div>
        <div class="gallery-card-file-name">${escapeHtml(fileName)}</div>
        ${
          displayLabel
            ? `<div class="gallery-card-display-label">${escapeHtml(displayLabel)}</div>`
            : ""
        }
      </div>

      <div class="gallery-thumb${
        opts?.emphasize ? " gallery-thumb-emphasis" : ""
      }">
        ${
          item.previewDataUrl
            ? `<img src="${item.previewDataUrl}" alt="${escapeHtml(fileName)}" />`
            : `<div class="gallery-thumb-placeholder">Preview unavailable</div>`
        }
      </div>

      <div class="gallery-card-meta">
        ${renderGalleryMetaRow("Type", safe(item.kind, "Not recorded"))}
        ${renderGalleryMetaRow("Format", safe(item.mimeType, "N/A"))}
        ${renderGalleryMetaRow("Size", safe(item.displaySizeLabel, "N/A"))}
        ${renderGalleryMetaRow(
          "SHA-256",
          item.sha256 ? shortHash(item.sha256, 14, 12) : "Not recorded"
        )}
        ${renderGalleryMetaRow("Access", buildAccessLabel(item))}
      </div>
    </article>
  `;
}

export function renderGallerySection(vm: ReportViewModel): string {
  if (vm.contentItems.length === 0) return "";

  const single = vm.contentItems.length === 1;

  return renderPageSection(
    "Evidence Gallery",
    `
      ${renderCallout({
        title: single ? "Evidence presentation" : "Evidence package presentation",
        body: single
          ? "This page presents the recorded evidence item with its original file name, media preview where available, and reviewer-facing item details."
          : "This gallery presents the recorded evidence package using original file names, media previews where available, and concise reviewer-facing item details for each preserved item.",
        tone: "neutral",
      })}

      <div class="gallery-grid${
        single ? " gallery-grid-single" : ""
      }">
        ${vm.contentItems
          .map((item) =>
            renderGalleryCard(item, {
              emphasize: single,
            })
          )
          .join("")}
      </div>
    `,
    { pageBreakBefore: true }
  );
}