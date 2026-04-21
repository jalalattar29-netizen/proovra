import { ReportViewModel } from "../types.js";
import {
  renderCallout,
  renderKeyValueGrid,
  renderPageSection,
} from "../ui.js";

export function renderStorageTimestampingSection(vm: ReportViewModel): string {
  return renderPageSection(
    "Storage, Timestamping & Publication",
    `
      ${renderKeyValueGrid(vm.storageRows)}

      ${renderCallout({
        title: "Operational preservation status",
        body:
          "Storage protection, trusted timestamping, and anchoring are grouped here as preservation controls. Exact technical identifiers remain in the technical appendix to avoid repeating those values across sections.",
        tone: "neutral",
      })}

      ${vm.storageCallouts.map(renderCallout).join("")}
    `,
    { pageBreakBefore: true }
  );
}
