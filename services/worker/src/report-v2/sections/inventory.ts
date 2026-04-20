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
          "This manifest lists the preserved evidence items by original file name together with type, format, size, full recorded SHA-256 value, and reviewer-facing role or access-state information. It is intended to support exact item-level review rather than visual orientation alone.",
        tone: "neutral",
      })}

      ${renderInventoryTable(vm.inventoryRows)}
    `,
    { pageBreakBefore: true }
  );
}