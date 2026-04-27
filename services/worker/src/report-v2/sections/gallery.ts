import {
  PresentationEvidenceItem,
  ReportEvidenceAsset,
  ReportViewModel,
} from "../types.js";
import { escapeHtml, safe } from "../formatters.js";
import { renderCallout, renderPageSection } from "../ui.js";

function buildAssetName(asset: ReportEvidenceAsset): string {
  return (
    safe(asset.originalFileName, "") ||
    safe(asset.label, "Unnamed evidence item")
  );
}

function mediaKindLabel(item: PresentationEvidenceItem): string {
  switch (item.previewRenderKind) {
    case "video":
      return "Video Evidence";
    case "audio":
      return "Audio Evidence";
    case "document":
      return "Document Evidence";
    case "text":
      return "Text Evidence";
    case "image":
      return "Image Evidence";
    default:
      return "Evidence Item";
  }
}

function renderMediaOverlay(item: PresentationEvidenceItem): string {
  if (item.previewRenderKind === "video") {
    return `
      <div class="gallery-media-overlay" aria-hidden="true">
        <div class="gallery-play-icon"></div>
        <div class="gallery-media-badge">Video</div>
      </div>
    `;
  }

  if (item.previewRenderKind === "audio") {
    return `
      <div class="gallery-media-overlay" aria-hidden="true">
        <div class="gallery-audio-icon">
          <span></span><span></span><span></span><span></span><span></span>
        </div>
        <div class="gallery-media-badge">Audio</div>
      </div>
    `;
  }

  if (item.previewRenderKind === "document" || item.previewRenderKind === "text") {
    return `
      <div class="gallery-media-overlay" aria-hidden="true">
        <div class="gallery-document-icon">
          <span class="gallery-document-fold"></span>
          <span class="gallery-document-line"></span>
          <span class="gallery-document-line"></span>
          <span class="gallery-document-line short"></span>
        </div>
        <div class="gallery-media-badge">${
          item.previewRenderKind === "text" ? "Text" : "Document"
        }</div>
      </div>
    `;
  }

  return "";
}

function renderGalleryMetaRow(label: string, value: string): string {
  const isHash =
    label === "SHA-256" ||
    label === "Lead Item SHA-256" ||
    label === "Item SHA-256";
  return `
    <div class="gallery-meta-row${isHash ? " gallery-meta-row-sha" : ""}">
      <div class="gallery-meta-label">${escapeHtml(label)}</div>
      <div class="gallery-meta-value${isHash ? " gallery-sha-value" : ""}">
        ${escapeHtml(value)}
      </div>
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
  const overlay = renderMediaOverlay(item);

  if (asset.previewDataUrl) {
    return `
      <div class="gallery-thumb${emphasisClass} gallery-thumb-kind-${escapeHtml(
        item.previewRenderKind
      )}">
        <img src="${asset.previewDataUrl}" alt="${escapeHtml(fileName)}" />
        ${overlay}
      </div>
    `;
  }

  if (item.previewRenderKind === "text" && asset.previewTextExcerpt) {
    return `
      <div class="gallery-thumb gallery-thumb-text${emphasisClass} gallery-thumb-kind-text">
        <div class="gallery-thumb-text-inner">
          <div class="gallery-thumb-text-title">Recorded text excerpt</div>
          <div class="gallery-thumb-text-body">${escapeHtml(
            asset.previewTextExcerpt
          )}</div>
        </div>
        ${overlay}
      </div>
    `;
  }

  return `
    <div class="gallery-thumb${emphasisClass} gallery-thumb-kind-${escapeHtml(
      item.previewRenderKind
    )}">
      <div class="gallery-thumb-placeholder">
        <div class="gallery-thumb-placeholder-title">${escapeHtml(
          mediaKindLabel(item)
        )}</div>
        <div class="gallery-thumb-placeholder-note">
          Preserved original content is represented through recorded metadata, digest references, and the verification workflow.
        </div>
      </div>
      ${overlay}
    </div>
  `;
}

function renderPrimaryEvidenceCard(item: PresentationEvidenceItem): string {
  const asset = item.asset;
  const fileName = buildAssetName(asset);

  return `
    <article class="primary-evidence-card">
      <div class="primary-evidence-preview">
        ${renderPreviewMedia(item, { emphasis: true })}
        <div class="primary-evidence-caption">
          Primary Preserved Evidence Item
        </div>
      </div>

      <div class="primary-evidence-details">
        ${renderGalleryMetaRow("File", fileName)}
        ${renderGalleryMetaRow("Type", mediaKindLabel(item))}
        ${renderGalleryMetaRow("Format", safe(asset.mimeType, "N/A"))}
        ${renderGalleryMetaRow("Size", safe(asset.displaySizeLabel, "N/A"))}
        ${renderGalleryMetaRow(
          "Access",
          asset.downloadable
            ? "Downloadable under policy"
            : "Restricted under policy"
        )}
${renderGalleryMetaRow("Lead Item SHA-256", asset.sha256 ?? "Not recorded")}
      </div>
    </article>
  `;
}

function renderSupportingCard(item: PresentationEvidenceItem): string {
  const asset = item.asset;
  const fileName = buildAssetName(asset);

  return `
    <article class="gallery-card">
      <div class="gallery-card-header">
        <div class="gallery-card-file-name">${escapeHtml(fileName)}</div>
        <div class="gallery-card-role">${escapeHtml(mediaKindLabel(item))}</div>
      </div>

      ${renderPreviewMedia(item)}

      <div class="gallery-card-meta gallery-card-meta-compact">
        ${renderGalleryMetaRow("Type", mediaKindLabel(item))}
        ${renderGalleryMetaRow("Format", safe(asset.mimeType, "N/A"))}
        ${renderGalleryMetaRow("Size", safe(asset.displaySizeLabel, "N/A"))}
${renderGalleryMetaRow("Item SHA-256", asset.sha256 ?? "Not recorded")}
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
        <div class="gallery-meta-value">${escapeHtml(mediaKindLabel(item))}</div>

        <div class="gallery-meta-label">Format</div>
        <div class="gallery-meta-value">${escapeHtml(safe(asset.mimeType, "N/A"))}</div>

        <div class="gallery-meta-label">Size</div>
        <div class="gallery-meta-value">${escapeHtml(safe(asset.displaySizeLabel, "N/A"))}</div>

        <div class="gallery-meta-label">Item SHA-256</div>
        <div class="gallery-meta-value gallery-sha-value">${escapeHtml(
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
    "Primary Evidence",
    `
      ${
        heroItem
          ? `
            <div class="primary-evidence-layout">
              ${renderPrimaryEvidenceCard(heroItem)}
            </div>
          `
          : ""
      }

      ${
        buckets.supportingPreviewItems.length > 0
          ? `
            ${renderCallout({
              title: "Supporting evidence gallery",
              body:
                "Supporting previews are reviewer-facing representations only. The preserved originals, recorded hashes, custody chain, timestamp state, and verification workflow remain authoritative.",
              tone: "neutral",
            })}
            <div class="gallery-support-grid support-grid">
              ${buckets.supportingPreviewItems
                .map((item) => renderSupportingCard(item))
                .join("")}
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