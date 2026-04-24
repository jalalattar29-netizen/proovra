import { ReportViewModel } from "../types.js";
import {
  renderCallout,
  renderInfoCards,
  renderKeyValueGrid,
  renderPageSection,
} from "../ui.js";

function pickRows(
  rows: Array<{ label: string; value: string }>,
  labels: string[]
): Array<{ label: string; value: string }> {
  const wanted = new Set(labels);
  return rows.filter((row) => wanted.has(row.label));
}

export function renderExecutiveSummarySection(vm: ReportViewModel): string {
  const mismatchBlock =
    vm.mismatchSummary.tone === "success" ? "" : renderCallout(vm.mismatchSummary);

  const executiveRows = pickRows(vm.executiveRows, [
    "Evidence Reference",
    "Evidence Type",
    "Verification Status",
    "Evidence Structure",
    "Item Count",
    "Lead Review Item",
    "Lead Item Type",
    "Total Content Size",
    "Captured (UTC)",
    "Signed (UTC)",
    "Submitted By",
    "Organization / Workspace",
  ]);

  return renderPageSection(
    "Executive Summary",
    `
      <div class="executive-layout">
        <div class="executive-main">
          ${renderCallout(vm.executiveConclusion)}

          <div class="evidence-strip">
            This page is the reviewer-facing summary. It keeps legal posture, evidence identity, and technical verification signals separate so the report can be read quickly before deeper technical inspection.
          </div>

          ${renderInfoCards(vm.heroCards)}
        </div>

        <div class="executive-side">
          ${renderKeyValueGrid(executiveRows)}
        </div>
      </div>

      ${mismatchBlock}

      ${renderCallout(vm.legalLimitationShort)}
    `,
    { pageBreakBefore: true }
  );
}