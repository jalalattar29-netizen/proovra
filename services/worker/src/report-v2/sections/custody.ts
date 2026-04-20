import { ReportViewModel } from "../types.js";
import {
  renderCallout,
  renderPageSection,
  renderTimelineTable,
} from "../ui.js";

export function renderCustodySection(vm: ReportViewModel): string {
  const forensicBlock =
    vm.forensicRows.length === 0
      ? renderCallout({
          title: "No forensic custody events returned",
          body:
            "This report did not receive internal forensic custody-event entries for this evidence record. That means no system-recorded forensic chain was available in this output; it should not be treated as proof that no handling occurred outside the recorded workflow.",
          tone: "warning",
        })
      : renderTimelineTable(vm.forensicRows);

  const accessBlock =
    vm.accessRows.length === 0
      ? ""
      : renderPageSection(
          "Access Activity",
          `
            ${renderCallout({
              title: "Access activity note",
              body:
                "Access activity is separated from forensic lifecycle events so later viewing, downloading, and verification actions do not visually mix with integrity-relevant record events.",
              tone: "neutral",
            })}
            ${renderTimelineTable(vm.accessRows)}
          `,
          { pageBreakBefore: true }
        );

  return `
    ${renderPageSection(
      "Chain of Custody",
      `
        ${renderCallout({
          title: "Custody reading note",
          body:
            "This section presents reviewer-facing forensic lifecycle events in chronological order. It is intentionally separated from later access activity so the main custody reading remains cleaner and easier to follow.",
          tone: "neutral",
        })}
        ${forensicBlock}
      `,
      { pageBreakBefore: true }
    )}
    ${accessBlock}
  `;
}