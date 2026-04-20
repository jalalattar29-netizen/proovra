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
        title: "Interpretation note",
        body:
          "Storage protection, trusted timestamping, and public anchoring are presented together in this section because they collectively support later review of preservation, time-related integrity state, and external publication evidence.",
        tone: "neutral",
      })}

      ${vm.storageCallouts.map(renderCallout).join("")}
    `,
    { pageBreakBefore: true }
  );
}