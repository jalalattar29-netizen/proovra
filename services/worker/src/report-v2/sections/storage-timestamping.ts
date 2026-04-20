import { ReportViewModel } from "../types.js";
import {
  renderCallout,
  renderKeyValueGrid,
  renderPageSection,
} from "../ui.js";

export function renderStorageTimestampingSection(vm: ReportViewModel): string {
  return renderPageSection(
    "Storage & Timestamping",
    `
      ${renderKeyValueGrid(vm.storageRows)}
      ${vm.storageCallouts.map(renderCallout).join("")}
    `,
    { pageBreakBefore: true }
  );
}