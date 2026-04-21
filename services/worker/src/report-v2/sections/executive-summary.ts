import { ReportViewModel } from "../types.js";
import {
  renderCallout,
  renderInfoCards,
  renderKeyValueGrid,
  renderPageSection,
} from "../ui.js";

export function renderExecutiveSummarySection(vm: ReportViewModel): string {
  const mismatchBlock =
    vm.mismatchSummary.tone === "success" ? "" : renderCallout(vm.mismatchSummary);

  return renderPageSection(
    "Executive Summary",
    `
      ${renderCallout(vm.executiveConclusion)}

      ${renderInfoCards(vm.heroCards)}

      ${renderKeyValueGrid(vm.executiveRows)}

      ${mismatchBlock}
    `,
    { pageBreakBefore: true }
  );
}
