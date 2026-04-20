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
      ${renderCallout(vm.legalLimitationShort)}
      ${renderInfoCards(vm.heroCards)}
      ${renderCallout(vm.reviewSequence)}
      ${renderCallout(vm.mismatchSummary)}
      ${renderKeyValueGrid(vm.executiveRows)}
    `
  );
}