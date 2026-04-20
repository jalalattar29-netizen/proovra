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
          title: "Custody separation note",
          body:
            "Forensic lifecycle events are listed separately from later access activity. This separation helps reviewers distinguish integrity-relevant record changes from later viewing, download, and verification activity.",
          tone: "neutral",
        })}
        ${renderCallout({
          title: "Sequence note",
          body:
            "Original event sequence numbers are preserved from the full evidence timeline. Access-related events are shown separately, so numbering may appear non-consecutive within this section.",
          tone: "neutral",
        })}
        ${forensicBlock}
      `,
      { pageBreakBefore: true }
    )}
    ${accessBlock}
  `;
}