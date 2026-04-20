import { ReportViewModel } from "../types.js";
import {
  renderCallout,
  renderInventoryTable,
  renderPageSection,
} from "../ui.js";

export function renderInventorySection(vm: ReportViewModel): string {
  if (vm.inventoryRows.length === 0) return "";

  return renderPageSection(
    "Structured Evidence Inventory",
    `
      ${renderCallout({
        title: "Inventory note",
        body:
          vm.contentItems.length > 1
            ? "This report includes both a compact gallery and a structured item-level inventory so multipart evidence can be reviewed quickly and precisely."
            : "This report includes a structured item-level inventory for the recorded evidence item.",
        tone: "neutral",
      })}

      ${renderInventoryTable(vm.inventoryRows)}
    `
  );
}