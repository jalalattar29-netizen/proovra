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

function buildAccessLabel(item: ReportEvidenceAsset): string {
  const parts = [
    item.previewable
      ? "Previewable in report or reviewer flow"
      : "Preview unavailable in report",
    item.downloadable
      ? "Downloadable under applicable access policy"
      : "Restricted under applicable access policy",
  ];

  return parts.join(" • ");
}

function buildRepresentationLabel(item: ReportEvidenceAsset): string {
  if (item.kind === "video") {
    return item.previewDataUrl
      ? "Embedded reviewer-facing preview"
      : "Video item represented without full playback inside PDF";
  }

  if (item.kind === "audio") {
    return item.previewDataUrl
      ? "Embedded reviewer-facing preview"
      : "Audio item represented without full playback inside PDF";
  }

  if (item.kind === "pdf") {
    return item.previewDataUrl
      ? "Embedded document preview"
      : "Document item represented without embedded page preview";
  }

  if (item.kind === "text") {
    return item.previewTextExcerpt
      ? "Embedded text excerpt"
      : "Text item represented without excerpt";
  }

  return item.previewDataUrl
    ? "Embedded reviewer-facing preview"
    : "Represented without embedded visual preview";
}

function renderPreviewBlock(
  item: ReportEvidenceAsset,
  emphasize?: boolean
): string {
  const fileName =
    safe(item.originalFileName, "") || safe(item.label, "Unnamed evidence item");

  if (item.previewDataUrl) {
    return `
      <div class="gallery-thumb${emphasize ? " gallery-thumb-emphasis" : ""}">
        <img src="${item.previewDataUrl}" alt="${escapeHtml(fileName)}" />
      </div>
    `;
  }

  if (item.kind === "text" && item.previewTextExcerpt) {
    return `
      <div class="gallery-thumb gallery-thumb-text${
        emphasize ? " gallery-thumb-emphasis" : ""
      }">
        <div class="gallery-thumb-text-inner">
          <div class="gallery-thumb-text-title">Text excerpt</div>
          <div class="gallery-thumb-text-body">${escapeHtml(
            item.previewTextExcerpt
          )}</div>
        </div>
      </div>
    `;
  }

  return `
    <div class="gallery-thumb${emphasize ? " gallery-thumb-emphasis" : ""}">
      <div class="gallery-thumb-placeholder">
        <div class="gallery-thumb-placeholder-title">${escapeHtml(
          safe(item.kind, "Evidence item").toUpperCase()
        )}</div>
        <div class="gallery-thumb-placeholder-note">
          Reviewer-facing preview not embedded in this PDF artifact.
        </div>
      </div>
    </div>
  `;
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

  const roleLabel = item.isPrimary
    ? "Primary Evidence Item"
    : "Supporting Evidence Item";

  return `
    <article class="gallery-card${
      opts?.emphasize ? " gallery-card-emphasis" : ""
    }">
      <div class="gallery-card-header">
        <div class="gallery-card-topline">
          <div class="gallery-card-index">Item ${item.index + 1}</div>
          <div class="gallery-card-role">${escapeHtml(roleLabel)}</div>
        </div>

        <div class="gallery-card-file-name">${escapeHtml(fileName)}</div>

        ${
          displayLabel
            ? `<div class="gallery-card-display-label">${escapeHtml(displayLabel)}</div>`
            : ""
        }
      </div>

      ${renderPreviewBlock(item, opts?.emphasize)}

      <div class="gallery-card-meta">
        ${renderGalleryMetaRow("Evidence Type", safe(item.kind, "Not recorded"))}
        ${renderGalleryMetaRow("MIME / Format", safe(item.mimeType, "N/A"))}
        ${renderGalleryMetaRow("Display Size", safe(item.displaySizeLabel, "N/A"))}
        ${renderGalleryMetaRow(
          "Reviewer Representation",
          buildRepresentationLabel(item)
        )}
        ${renderGalleryMetaRow("Access Policy", buildAccessLabel(item))}
        ${renderGalleryMetaRow(
          "SHA-256",
          item.sha256 ? item.sha256 : "Not recorded"
        )}
      </div>
    </article>
  `;
}

export function renderGallerySection(vm: ReportViewModel): string {
  if (vm.contentItems.length === 0) return "";

  const single = vm.contentItems.length === 1;
  const primaryItem =
    vm.primaryContentItem ??
    vm.contentItems.find((item) => item.isPrimary) ??
    vm.contentItems[0] ??
    null;

  const supportingItems = primaryItem
    ? vm.contentItems.filter((item) => item.id !== primaryItem.id)
    : vm.contentItems;

  const primaryHeroBlock = primaryItem
    ? `
      <div class="gallery-lead-note">
        <div class="gallery-lead-note-title">Lead review item</div>
        <div class="gallery-lead-note-body">
          ${escapeHtml(
            safe(
              primaryItem.originalFileName || primaryItem.label,
              "Unnamed evidence item"
            )
          )}
        </div>
      </div>

      <div class="gallery-grid gallery-grid-single">
        ${renderGalleryCard(primaryItem, { emphasize: true })}
      </div>
    `
    : "";

  const supportingGridBlock =
    supportingItems.length > 0
      ? `
        <div class="gallery-grid">
          ${supportingItems.map((item) => renderGalleryCard(item)).join("")}
        </div>
      `
      : "";

  return renderPageSection(
    "Evidence Presentation",
    `
      ${renderCallout({
        title: single
          ? "Primary evidence presentation"
          : "Evidence package presentation",
        body: single
          ? "This section presents the recorded evidence item in a reviewer-facing format, together with its original file name, preserved item metadata, and full recorded digest reference."
          : "This section presents the recorded evidence package in a reviewer-facing format. The lead review item is emphasized first, followed by supporting preserved items using original file names, available preview representations, item metadata, and full recorded digest references.",
        tone: "neutral",
      })}

      ${primaryHeroBlock}

      ${
        supportingItems.length > 0
          ? renderCallout({
              title: "Supporting preserved items",
              body:
                "These items remain part of the preserved package and should be reviewed together with the lead review item where context, chronology, or corroboration matters.",
              tone: "neutral",
            })
          : ""
      }

      ${supportingGridBlock}
    `,
    { pageBreakBefore: true }
  );
}