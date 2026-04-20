import { ReportViewModel } from "../types.js";
import { escapeHtml } from "../formatters.js";
import { renderCallout, renderPageSection } from "../ui.js";

function renderGalleryCard(
  label: string,
  previewDataUrl: string | null | undefined,
  meta: string
): string {
  return `
    <article class="gallery-card">
      <div class="gallery-card-header">${escapeHtml(label)}</div>
      <div class="gallery-thumb">
        ${
          previewDataUrl
            ? `<img src="${previewDataUrl}" alt="${escapeHtml(label)}" />`
            : `<div class="gallery-thumb-placeholder">Preview unavailable</div>`
        }
      </div>
      <div class="gallery-card-meta">${escapeHtml(meta)}</div>
    </article>
  `;
}

export function renderGallerySection(vm: ReportViewModel): string {
  if (!vm.galleryEnabled || vm.contentItems.length <= 1) return "";

  return renderPageSection(
    "Evidence Package Gallery",
    `
      ${renderCallout({
        title: "Compact review gallery",
        body:
          "This gallery is intended for quick reviewer orientation. It does not replace the structured item inventory or the preserved original files.",
        tone: "neutral",
      })}

      <div class="gallery-grid">
        ${vm.contentItems
          .map((item) =>
            renderGalleryCard(
              `${item.index + 1}. ${item.label}`,
              item.previewDataUrl,
              [item.kind, item.mimeType ?? "", item.displaySizeLabel ?? ""]
                .filter(Boolean)
                .join(" • ")
            )
          )
          .join("")}
      </div>
    `
  );
}