import { ReportViewModel } from "../types.js";
import {
  renderCallout,
  renderKeyValueGrid,
  renderPageSection,
} from "../ui.js";

export function renderEvidenceContentSection(vm: ReportViewModel): string {
  return renderPageSection(
    "Evidence Package Summary",
    `
      ${renderKeyValueGrid(vm.contentSummaryRows)}

      ${renderCallout({
        title: "Reviewer note",
        body:
          "Use the evidence-presentation section for visual and reviewer-facing orientation, the evidence manifest for exact item-level listing, and the later technical, custody, timestamping, and storage sections for deeper validation of the recorded integrity state.",
        tone: "neutral",
      })}
    `,
    { pageBreakBefore: true }
  );
}