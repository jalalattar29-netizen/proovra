import { ReportViewModel } from "../types.js";
import {
  renderCallout,
  renderKeyValueGrid,
  renderPageSection,
} from "../ui.js";

export function renderEvidenceContentSection(vm: ReportViewModel): string {
  const title =
    vm.presentationMode === "heavy"
      ? "Evidence Package Structure"
      : "Evidence Package Summary";

  return renderPageSection(
    title,
    `
      ${renderKeyValueGrid(vm.contentSummaryRows)}

      ${renderCallout({
        title: "Section role",
        body:
          "This section orients the reviewer to package composition only. Visual inspection belongs in Evidence Presentation, exact per-item listing belongs in the manifest, and technical validation belongs in the later integrity and appendix sections.",
        tone: "neutral",
      })}
    `,
    { pageBreakBefore: true }
  );
}
