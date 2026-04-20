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
          "Review the evidence gallery for item-level visual orientation, then use the evidence manifest for exact file-level listing, and then move to custody, timestamping, storage, and technical appendix materials for deeper validation.",
        tone: "neutral",
      })}
    `,
    { pageBreakBefore: true }
  );
}