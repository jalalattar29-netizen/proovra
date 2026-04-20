import { ReportViewModel } from "../types.js";
import {
  renderCallout,
  renderInfoCards,
  renderKeyValueGrid,
  renderPageSection,
} from "../ui.js";

export function renderExecutiveSummarySection(vm: ReportViewModel): string {
  return renderPageSection(
    "Executive Summary",
    `
      ${renderCallout(vm.executiveConclusion)}
      ${renderInfoCards(vm.heroCards)}
      ${renderKeyValueGrid(vm.executiveRows)}
      ${renderCallout(vm.legalLimitationShort)}
    `,
    { pageBreakBefore: true }
  );
}