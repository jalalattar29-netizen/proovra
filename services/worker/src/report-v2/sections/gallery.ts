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

function shortHash(value: string | null | undefined): string {
  const text = safe(value, "");
  if (!text) return "Not recorded";
  if (text.length <= 34) return text;
  return `${text.slice(0, 18)}…${text.slice(-12)}`;
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
      ? "Document evidence"
      : item.previewRenderKind === "video"
        ? "Video evidence"
        : item.previewRenderKind === "audio"
          ? "Audio evidence"
          : "Evidence item";

  const note =
    item.previewRenderKind === "document"
      ? "The document is preserved in the evidence package. Full review should use the verification workflow or original package."
      : item.previewRenderKind === "video"
        ? "The video is preserved in the evidence package. Playback is handled through the verification workflow."
        : item.previewRenderKind === "audio"
          ? "The audio item is preserved in the evidence package. Listening review is handled through the verification workflow."
          : "This item is represented without an inline preview image but remains part of the preserved package.";

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
        ${renderGalleryMetaRow("MIME / Format", safe(asset.mimeType, "N/A"))}
        ${renderGalleryMetaRow("Size", safe(asset.displaySizeLabel, "N/A"))}
        ${renderGalleryMetaRow(
          "Access",
          asset.downloadable ? "Downloadable under policy" : "Restricted under policy"
        )}
        ${renderGalleryMetaRow("SHA-256", shortHash(asset.sha256))}
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
        <div class="gallery-meta-value hash-text">${escapeHtml(shortHash(asset.sha256))}</div>
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
        Evidence content is presented for reviewer orientation. The original preserved item, recorded digest, custody linkage, timestamp state, and storage controls remain the authoritative verification materials.
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
              title: "Supporting items",
              body:
                "Additional previewable items are shown below with their recorded identifiers and digest references.",
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
              title: "Reference-only items",
              body:
                "These items do not include an inline PDF preview. They remain part of the evidence package and are listed with identity, format, and digest references.",
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