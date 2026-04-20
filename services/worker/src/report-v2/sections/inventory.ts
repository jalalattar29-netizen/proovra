import { ReportViewModel } from "../types.js";
import {
  renderCallout,
  renderInventoryTable,
  renderPageSection,
} from "../ui.js";

export function renderInventorySection(vm: ReportViewModel): string {
  if (vm.inventoryRows.length === 0) return "";

  return renderPageSection(
    "Evidence Manifest",
    `
      ${renderCallout({
        title: "Manifest scope",
        body:
          "This manifest lists the preserved evidence items by original file name together with type, format, size, recorded hash summary, and reviewer-facing access role information.",
        tone: "neutral",
      })}

      ${renderInventoryTable(vm.inventoryRows)}
    `,
    { pageBreakBefore: true }
  );
}