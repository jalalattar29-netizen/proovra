import { ReportViewModel } from "../types.js";
import {
  renderCallout,
  renderPageSection,
  renderTimelineTable,
} from "../ui.js";

function renderCustodyStats(vm: ReportViewModel): string {
  return `
    <div class="custody-stats-grid">
      <div class="custody-stat-card">
        <div class="custody-stat-label">Forensic Events</div>
        <div class="custody-stat-value">${vm.forensicRows.length}</div>
      </div>
      <div class="custody-stat-card">
        <div class="custody-stat-label">Access Events</div>
        <div class="custody-stat-value">${vm.accessRows.length}</div>
      </div>
      <div class="custody-stat-card">
        <div class="custody-stat-label">Hash Chain</div>
        <div class="custody-stat-value">${
          vm.custodyHashRows.length > 0 ? "Recorded" : "Not reported"
        }</div>
      </div>
    </div>
  `;
}

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
      : `
        <div class="custody-access-section">
          ${renderCallout({
            title: "Access activity is separate from forensic custody",
            body:
              "Viewing, download, and verification events are listed separately so routine access history does not get confused with integrity-relevant custody events.",
            tone: "neutral",
          })}
          ${renderTimelineTable(vm.accessRows)}
        </div>
      `;

  return renderPageSection(
    "Chain of Custody",
    `
      <div class="custody-page">
        ${renderCallout({
          title: "Recorded custody lifecycle",
          body:
            "This page presents the recorded forensic lifecycle in chronological order. Access activity is separated from custody events. Technical hash-chain values are preserved in the Technical Appendix so this section stays readable.",
          tone: "neutral",
        })}

        ${renderCustodyStats(vm)}

        <div class="custody-timeline-panel">
          ${forensicBlock}
        </div>

        ${accessBlock}
      </div>
    `,
    { pageBreakBefore: true, className: "custody-section" }
  );
}