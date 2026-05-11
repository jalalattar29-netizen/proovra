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

function renderDuplicateDigestBadge(item: PresentationEvidenceItem): string {
  const duplicate = item.asset.duplicateDigest;
  if (!duplicate) return "";

  return `
    <div class="gallery-duplicate-badge">
      Digest Group ${escapeHtml(duplicate.groupId)}
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
  ? "Original included in verification package; public download allowed under policy"
  : "Original included in verification package; public preview/download may be restricted"
        )}
${renderGalleryMetaRow("Lead Item SHA-256", asset.sha256 ?? "Not recorded")}
${renderDuplicateDigestBadge(item)}
      </div>
          </article>
  `;
}

function reviewerRoleLabel(asset: ReportEvidenceAsset): string {
  if (asset.artifactRole === "primary_evidence") return "Primary";
  if (asset.artifactRole === "supporting_evidence") return "Supporting";
  return "Context";
}

function reviewerMappingLabel(asset: ReportEvidenceAsset): string {
  return (
    safe(asset.checklistStepLabel, "") ||
    safe(asset.reviewerRepresentationLabel, "") ||
    "Unmapped / supplemental"
  );
}

function renderSupportingCard(item: PresentationEvidenceItem): string {
  const asset = item.asset;
  const fileName = buildAssetName(asset);
  const duplicate = asset.duplicateDigest;

  return `
    <article class="gallery-card${duplicate ? " gallery-card-duplicate" : ""}">
        <div class="gallery-card-header">
        <div class="gallery-card-file-name">${escapeHtml(fileName)}</div>
<div class="gallery-card-role">
  ${escapeHtml(reviewerRoleLabel(asset))} · ${escapeHtml(reviewerMappingLabel(asset))}
</div>
      </div>

      ${renderPreviewMedia(item)}

<div class="gallery-card-meta gallery-card-meta-compact">
  ${renderGalleryMetaRow("Role", reviewerRoleLabel(asset))}
  ${renderGalleryMetaRow("Mapping", reviewerMappingLabel(asset))}
  ${renderGalleryMetaRow("Type", mediaKindLabel(item))}
  ${renderGalleryMetaRow("Format", safe(asset.mimeType, "N/A"))}
  ${renderGalleryMetaRow("Size", safe(asset.displaySizeLabel, "N/A"))}
  ${renderGalleryMetaRow("Item SHA-256", asset.sha256 ?? "Not recorded")}
  ${renderDuplicateDigestBadge(item)}
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
      ${renderDuplicateDigestBadge(item)}
    </article>
  `;
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function buildDuplicateDigestGroups(vm: ReportViewModel): Array<{
  groupId: string;
  sha256: string;
  fileNames: string[];
}> {
  const groups = new Map<
    string,
    {
      groupId: string;
      sha256: string;
      fileNames: string[];
    }
  >();

  for (const item of vm.contentItems) {
    const duplicate = item.duplicateDigest;
    const sha256 = safe(item.sha256, "");

    if (!duplicate || !sha256 || sha256 === "N/A") continue;

    if (!groups.has(duplicate.groupId)) {
      groups.set(duplicate.groupId, {
        groupId: duplicate.groupId,
        sha256,
        fileNames: [],
      });
    }

    groups.get(duplicate.groupId)!.fileNames.push(
      safe(item.originalFileName || item.label, "Unnamed evidence item")
    );
  }

  return Array.from(groups.values());
}

function renderDuplicateDigestRegister(vm: ReportViewModel): string {
  const groups = buildDuplicateDigestGroups(vm);
  if (groups.length === 0) return "";

  return renderPageSection(
    "Duplicate Digest Register",
    `
      <div class="duplicate-digest-register-page">
        ${renderCallout({
          title: "Duplicate content digest register",
          body:
            "This register lists evidence items that share the same SHA-256 content digest. Matching digests indicate identical preserved file content. Different filenames, roles, upload positions, or package references may still be relevant and are therefore retained as separate evidence items.",
          tone: "neutral",
        })}

        <div class="duplicate-digest-register-list">
          ${groups
            .map(
              (group) => `
                <article class="duplicate-digest-group-card">
                  <div class="duplicate-digest-group-line">
                    <div class="duplicate-digest-group-id">${escapeHtml(
                      group.groupId
                    )}</div>
                    <div class="duplicate-digest-group-count">
                      ${escapeHtml(String(group.fileNames.length))} matching items
                    </div>
                  </div>

                  <div class="duplicate-digest-sha-value">${escapeHtml(
                    group.sha256
                  )}</div>

                  <div class="duplicate-digest-file-list-text">
                    ${escapeHtml(group.fileNames.join(", "))}
                  </div>
                </article>
                              `
            )
            .join("")}
        </div>
      </div>
    `,
    {
      pageBreakBefore: true,
      className: "duplicate-digest-register-section",
    }
  );
}

export function renderGallerySection(vm: ReportViewModel): string {
  const { buckets } = vm.presentation;

  const previewItems = buckets.supportingPreviewItems;
  const metadataOnlyItems = buckets.metadataOnlyItems;

  if (previewItems.length === 0 && metadataOnlyItems.length === 0) {
    return "";
  }

  const pages: string[] = [];

  const previewChunks = chunkItems(previewItems, 4);

  previewChunks.forEach((chunk, index) => {
    pages.push(
      renderPageSection(
        previewChunks.length > 1
          ? `Evidence Gallery ${index + 1}/${previewChunks.length}`
          : "Evidence Gallery",
        `
          ${
            index === 0
              ? renderCallout({
                  title: "Unified evidence gallery",
                  body:
                    "Primary, supporting, and context items are presented together for reviewer efficiency. Role and checklist mapping labels identify each item's review purpose; preserved originals, hashes, custody, timestamps, and verification materials remain authoritative.",
                  tone: "neutral",
                })
              : ""
          }

          <div class="gallery-support-grid support-grid">
            ${chunk.map((item) => renderSupportingCard(item)).join("")}
          </div>
        `,
        {
          pageBreakBefore: true,
          className:
            "evidence-presentation-section evidence-gallery-section unified-evidence-gallery-section",
        }
      )
    );
  });

  const metadataChunks = chunkItems(metadataOnlyItems, 6);

  metadataChunks.forEach((chunk, index) => {
    pages.push(
      renderPageSection(
        metadataChunks.length > 1
          ? `Reference-Only Evidence Items ${index + 1}/${metadataChunks.length}`
          : "Reference-Only Evidence Items",
        `
          ${
            index === 0
              ? renderCallout({
                  title: "Reference-only evidence items",
                  body:
                    "These items are part of the preserved package but do not include an inline PDF preview. Their identity, format, role, mapping, and digest references are preserved for completeness.",
                  tone: "neutral",
                })
              : ""
          }

          <div class="gallery-secondary-list">
            ${chunk.map(renderMetadataOnlyCard).join("")}
          </div>
        `,
        {
          pageBreakBefore: true,
          className:
            "evidence-presentation-section evidence-gallery-section",
        }
      )
    );
  });

  const duplicateRegister = renderDuplicateDigestRegister(vm);
  if (duplicateRegister) {
    pages.push(duplicateRegister);
  }

  return pages.join("");
}
