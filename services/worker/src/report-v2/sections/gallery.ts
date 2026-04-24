// D:\digital-witness\services\worker\src\report-v2\sections\gallery.ts
import {
  PresentationEvidenceItem,
  ReportEvidenceAsset,
  ReportViewModel,
} from "../types.js";
import { escapeHtml, safe } from "../formatters.js";
import { renderCallout, renderPageSection } from "../ui.js";

function buildAssetName(asset: ReportEvidenceAsset): string {
  return safe(asset.originalFileName, "") || safe(asset.label, "Unnamed evidence item");
}

function renderGalleryMetaRow(label: string, value: string): string {
  return `
    <div class="gallery-meta-row">
      <div class="gallery-meta-label">${escapeHtml(label)}</div>
      <div class="gallery-meta-value${label === "SHA-256" ? " hash-text" : ""}">${escapeHtml(value)}</div>
    </div>
  `;
}

function renderPreviewMedia(
  item: PresentationEvidenceItem,
  opts?: { emphasis?: boolean }
): string {
  const asset = item.asset;
  const fileName = buildAssetName(asset);
  const emphasisClass = opts?.emphasis ? " gallery-thumb-emphasis" : "";

  if (asset.previewDataUrl) {
    return `
      <div class="gallery-thumb${emphasisClass}">
        <img src="${asset.previewDataUrl}" alt="${escapeHtml(fileName)}" />
      </div>
    `;
  }

  if (item.previewRenderKind === "text" && asset.previewTextExcerpt) {
    return `
      <div class="gallery-thumb gallery-thumb-text${emphasisClass}">
        <div class="gallery-thumb-text-inner">
          <div class="gallery-thumb-text-title">Recorded text excerpt</div>
          <div class="gallery-thumb-text-body">${escapeHtml(asset.previewTextExcerpt)}</div>
        </div>
      </div>
    `;
  }

  const title =
    item.previewRenderKind === "document"
      ? "Document Evidence"
      : item.previewRenderKind === "video"
        ? "Video Evidence"
        : item.previewRenderKind === "audio"
          ? "Audio Evidence"
          : "Evidence Item";

  const note =
    item.previewRenderKind === "document"
      ? "Document preserved in the evidence package. Full document review belongs in the verification workflow or original package."
      : item.previewRenderKind === "video"
        ? "Video preserved in the evidence package. Playback remains controlled through the verification workflow."
        : item.previewRenderKind === "audio"
          ? "Audio preserved in the evidence package. Listening review remains controlled through the verification workflow."
          : "This item is represented by identity, format, digest, and custody references.";

  return `
    <div class="gallery-thumb${emphasisClass}">
      <div class="gallery-thumb-placeholder">
        <div class="gallery-thumb-placeholder-title">${escapeHtml(title)}</div>
        <div class="gallery-thumb-placeholder-note">${escapeHtml(note)}</div>
      </div>
    </div>
  `;
}

function renderPreviewCard(
  item: PresentationEvidenceItem,
  opts?: { emphasize?: boolean; roleLabel?: string }
): string {
  const asset = item.asset;
  const fileName = buildAssetName(asset);
  const roleLabel =
    opts?.roleLabel ??
    (asset.isPrimary ? "Primary evidence item" : "Supporting evidence item");

  return `
    <article class="gallery-card${opts?.emphasize ? " gallery-card-emphasis" : ""}">
      <div class="gallery-card-header">
        <div class="gallery-card-topline">
          <div class="gallery-card-index">Item ${asset.index + 1}</div>
          <div class="gallery-card-role">${escapeHtml(roleLabel)}</div>
        </div>
        <div class="gallery-card-file-name">${escapeHtml(fileName)}</div>
        ${
          asset.label && asset.label !== fileName
            ? `<div class="gallery-card-display-label">${escapeHtml(asset.label)}</div>`
            : ""
        }
      </div>

      ${renderPreviewMedia(item, { emphasis: opts?.emphasize })}

      <div class="gallery-card-meta">
        ${renderGalleryMetaRow("Type", safe(asset.kind, "Not recorded"))}
        ${renderGalleryMetaRow("Format", safe(asset.mimeType, "N/A"))}
        ${renderGalleryMetaRow("Size", safe(asset.displaySizeLabel, "N/A"))}
        ${renderGalleryMetaRow(
          "Access",
          asset.downloadable ? "Downloadable under policy" : "Restricted under policy"
        )}
        ${renderGalleryMetaRow("SHA-256", asset.sha256 ?? "Not recorded")}
      </div>
    </article>
  `;
}

function renderMetadataOnlyCard(item: PresentationEvidenceItem): string {
  const asset = item.asset;
  const fileName = buildAssetName(asset);

  return `
    <article class="gallery-secondary-item">
      <div class="gallery-secondary-name">${escapeHtml(fileName)}</div>
      <div class="gallery-secondary-grid">
        <div class="gallery-meta-label">Representation</div>
        <div class="gallery-meta-value">Metadata-only in PDF</div>

        <div class="gallery-meta-label">Type</div>
        <div class="gallery-meta-value">${escapeHtml(safe(asset.kind, "Not recorded"))}</div>

        <div class="gallery-meta-label">Format</div>
        <div class="gallery-meta-value">${escapeHtml(safe(asset.mimeType, "N/A"))}</div>

        <div class="gallery-meta-label">Size</div>
        <div class="gallery-meta-value">${escapeHtml(safe(asset.displaySizeLabel, "N/A"))}</div>

        <div class="gallery-meta-label">SHA-256</div>
        <div class="gallery-meta-value hash-text">${escapeHtml(asset.sha256 ?? "Not recorded")}</div>
      </div>
    </article>
  `;
}

export function renderGallerySection(vm: ReportViewModel): string {
  const { buckets } = vm.presentation;
  const heroItem = buckets.heroItem;

  if (!heroItem && buckets.metadataOnlyItems.length === 0) return "";

  return renderPageSection(
    "Evidence Presentation",
    `
      <div class="evidence-strip">
        <strong>Reviewer orientation.</strong>
        Visual previews support human review only. The preserved original file, digest, custody chain, timestamp state, and storage controls remain the authoritative verification materials.
      </div>

      ${
        heroItem
          ? `
            <div class="gallery-primary">
              ${renderPreviewCard(heroItem, {
                emphasize: true,
                roleLabel: "Lead review item",
              })}
            </div>
          `
          : ""
      }

      ${
        buckets.supportingPreviewItems.length > 0
          ? `
            ${renderCallout({
              title: "Supporting evidence items",
              body:
                "Additional previewable items are listed with their recorded identifiers and digest references. These previews do not replace the preserved originals.",
              tone: "neutral",
            })}
            <div class="gallery-support-grid support-grid">
              ${buckets.supportingPreviewItems.map((item) => renderPreviewCard(item)).join("")}
            </div>
          `
          : ""
      }

      ${
        buckets.metadataOnlyItems.length > 0
          ? `
            ${renderCallout({
              title: "Reference-only evidence items",
              body:
                "These items are part of the preserved package but do not include an inline PDF preview. Their identity, format, and digest references are preserved for completeness.",
              tone: "neutral",
            })}
            <div class="gallery-secondary-list">
              ${buckets.metadataOnlyItems.map(renderMetadataOnlyCard).join("")}
            </div>
          `
          : ""
      }
    `,
    { pageBreakBefore: true, className: "evidence-presentation-section" }
  );
}