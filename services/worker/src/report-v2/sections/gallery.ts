import {
  PresentationEvidenceItem,
  ReportEvidenceAsset,
  ReportViewModel,
} from "../types.js";
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

function renderPreviewMedia(
  item: PresentationEvidenceItem,
  opts?: { emphasis?: boolean }
): string {
  const asset = item.asset;
  const fileName =
    safe(asset.originalFileName, "") || safe(asset.label, "Unnamed evidence item");
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
          <div class="gallery-thumb-text-body">${escapeHtml(
            asset.previewTextExcerpt
          )}</div>
        </div>
      </div>
    `;
  }

  const title =
    item.previewRenderKind === "document"
      ? "Document preview available"
      : item.previewRenderKind === "video"
        ? "Video representation"
        : item.previewRenderKind === "audio"
          ? "Audio representation"
          : "Evidence representation";

  const note =
    item.previewRenderKind === "document"
      ? "The document is part of the preserved package. Review the verification workflow for the underlying file when page-level inspection is needed."
      : item.previewRenderKind === "video"
        ? "This video remains part of the preserved package. Where no poster frame was embedded, the PDF preserves its identity and technical references."
        : item.previewRenderKind === "audio"
          ? "This audio item remains part of the preserved package. The PDF records its identity while deeper playback remains in the verification workflow."
          : "This item is represented without an inline preview image in the PDF but remains part of the preserved evidence package.";

  return `
    <div class="gallery-thumb${emphasisClass}">
      <div class="gallery-thumb-placeholder">
        <div class="gallery-thumb-placeholder-title">${escapeHtml(title)}</div>
        <div class="gallery-thumb-placeholder-note">${escapeHtml(note)}</div>
      </div>
    </div>
  `;
}

function buildAssetName(asset: ReportEvidenceAsset): string {
  return safe(asset.originalFileName, "") || safe(asset.label, "Unnamed evidence item");
}

function renderPreviewCard(
  item: PresentationEvidenceItem,
  opts?: { emphasize?: boolean; roleLabel?: string }
): string {
  const asset = item.asset;
  const fileName = buildAssetName(asset);
  const roleLabel =
    opts?.roleLabel ??
    (asset.isPrimary ? "Primary evidence item" : "Supporting preview item");

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
        ${renderGalleryMetaRow("MIME / Format", safe(asset.mimeType, "N/A"))}
        ${renderGalleryMetaRow("Display Size", safe(asset.displaySizeLabel, "N/A"))}
        ${renderGalleryMetaRow(
          "Access State",
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
        <div class="gallery-meta-value hash-text">${escapeHtml(
          asset.sha256 ?? "Not recorded"
        )}</div>
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
      ${renderCallout({
        title: "Presentation structure",
        body:
          "The lead evidence item is emphasized first. Every other previewable preserved item is rendered as a supporting preview card, while non-previewable items remain listed with exact identifiers and recorded hashes.",
        tone: "neutral",
      })}

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
              title: "Supporting preview items",
              body:
                "These preserved items remain visually represented in the PDF because they are previewable within the report workflow. Their original names and full hashes are preserved alongside the preview.",
              tone: "neutral",
            })}
            <div class="gallery-support-grid support-grid">
              ${buckets.supportingPreviewItems
                .map((item) => renderPreviewCard(item))
                .join("")}
            </div>
          `
          : ""
      }

      ${
        buckets.metadataOnlyItems.length > 0
          ? `
            ${renderCallout({
              title: "Reference-only package items",
              body:
                "These preserved items do not carry an inline report preview but remain part of the evidence package. Their identity, format, and full SHA-256 values are preserved here for package completeness.",
              tone: "neutral",
            })}
            <div class="gallery-secondary-list">
              ${buckets.metadataOnlyItems.map(renderMetadataOnlyCard).join("")}
            </div>
          `
          : ""
      }
    `,
    { pageBreakBefore: true }
  );
}
