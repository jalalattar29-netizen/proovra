import { ReportViewModel } from "../types.js";
import {
  renderCallout,
  renderKeyValueGrid,
  renderPageSection,
} from "../ui.js";

export function renderEvidenceContentSection(vm: ReportViewModel): string {
  const primary = vm.primaryContentItem;

  return renderPageSection(
    "Evidence Content",
    `
      <div class="callout tone-neutral">
        <div class="callout-title">Content review posture</div>
        <div class="callout-body">
          ${vm.reviewGuidance.contentReviewNote}<br><br>
          ${vm.meta.previewPolicy.rationale}<br><br>
          ${vm.meta.previewPolicy.privacyNotice}
        </div>
      </div>

      ${
        primary
          ? renderCallout({
              title: "Primary item summary",
              body: [
                `Label: ${primary.label}`,
                `Kind: ${primary.kind}`,
                primary.mimeType ? `MIME: ${primary.mimeType}` : null,
                primary.displaySizeLabel
                  ? `Size: ${primary.displaySizeLabel}`
                  : null,
                primary.sha256 ? `SHA-256: ${vm.meta.primaryHashShort}` : null,
              ]
                .filter(Boolean)
                .join(" • "),
              tone: "neutral",
            })
          : renderCallout({
              title: "Primary item summary",
              body: "No primary evidence item was explicitly identified in the report payload.",
              tone: "warning",
            })
      }

      ${renderKeyValueGrid(vm.contentSummaryRows)}
    `
  );
}