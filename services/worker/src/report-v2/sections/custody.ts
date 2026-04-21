import { ReportViewModel } from "../types.js";
import { escapeHtml } from "../formatters.js";
import {
  renderCallout,
  renderCustodyHashTable,
  renderPageSection,
  renderTimelineTable,
} from "../ui.js";
import { renderLegalLimitationsBlock } from "./legal-limitations.js";

function renderCustodySubsection(title: string, body: string): string {
  return `
    <section class="appendix-section">
      <h3 class="appendix-section-title">${escapeHtml(title)}</h3>
      ${body}
    </section>
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
          ${renderCallout({
            title: "Access activity",
            body:
              "Access activity is listed after forensic lifecycle events so later viewing, downloading, and verification actions remain distinguishable from integrity-relevant custody events.",
            tone: "neutral",
          })}
          ${renderTimelineTable(vm.accessRows)}
        `;

  const custodyHashBlock =
    vm.custodyHashRows.length === 0
      ? renderCallout({
          title: "Custody hash chain detail unavailable",
          body:
            "No event-hash values were included in the report payload for the forensic custody events. The custody chronology remains visible above, but technical hash-chain review requires recorded prev-event and event-hash values.",
          tone: "warning",
        })
      : `
          ${renderCallout({
            title: "Hash-chain review context",
            body:
              "The table below restores the technical custody-chain detail for reviewer and audit use. Each row preserves the recorded previous-event hash and event hash relationship for the corresponding forensic custody event.",
            tone: "neutral",
          })}
          ${renderCustodyHashTable(vm.custodyHashRows)}
        `;

  return `
    ${renderPageSection(
      "Chain of Custody",
      `
        ${renderCallout({
          title: "Custody reading note",
          body:
            "This section presents reviewer-facing forensic lifecycle events in chronological order. The main table stays readable, while the restored hash-chain detail below preserves the technical custody relationship for audit review.",
          tone: "neutral",
        })}
        ${forensicBlock}
        ${accessBlock}
        ${renderCustodySubsection("Custody Hash Chain Detail", custodyHashBlock)}
        ${renderCustodySubsection(
          "Legal Interpretation & Review Use",
          renderLegalLimitationsBlock(vm)
        )}
      `
    )}
  `;
}
