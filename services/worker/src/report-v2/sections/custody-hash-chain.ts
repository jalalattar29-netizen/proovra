import { ReportViewModel } from "../types.js";
import {
  renderPageSection,
} from "../ui.js";
import { escapeHtml } from "../formatters.js";

function renderCustodyHashChainNotice(): string {
  return `
    <div class="custody-hash-chain-notice">
      <p>
        This table shows a curated forensic subset of the custody hash chain. Sequence identifiers preserve the original custody-event log order, so numbering may be non-sequential when intermediate events are omitted from this PDF view.
      </p>
      <p>
        Full custody records, intermediate entries, complete hash values, and access activity are preserved in the verification package and can be inspected through the public verification page.
      </p>
      <p>
        Events are displayed in hash-chain order. Some timestamps may appear slightly out of chronological order because asynchronous system jobs can append events after the workflow timestamp they document.
      </p>
    </div>
  `;
}

function renderEnterpriseCustodyHashTable(vm: ReportViewModel): string {
  return `
    <table class="report-table custody-hash-chain-table custody-hash-chain-table-enterprise">
      <thead>
        <tr>
          <th>Seq</th>
          <th>Recorded At</th>
          <th>Event</th>
          <th>Previous Event Hash</th>
          <th>Event Hash</th>
        </tr>
      </thead>
      <tbody>
        ${vm.custodyHashRows
          .map(
            (row) => `
              <tr>
                <td class="custody-hash-seq">
                  ${escapeHtml(String(row.sequence ?? "N/A"))}
                </td>
                <td class="custody-hash-time">
                  ${escapeHtml(String(row.atUtc ?? "N/A"))}
                </td>
                <td class="custody-hash-event">
                  ${escapeHtml(String(row.eventLabel ?? "N/A"))}
                </td>
                <td>
                  <span class="hash-text custody-hash-short">
${escapeHtml(row.prevEventHash ?? "")}
                  </span>
                </td>
                <td>
                  <span class="hash-text custody-hash-short">
${escapeHtml(row.eventHash ?? "")}
                  </span>
                </td>
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>

  `;
}

export function renderCustodyHashChainSection(vm: ReportViewModel): string {
  if (vm.custodyHashRows.length === 0) return "";

  return renderPageSection(
    "Custody Hash Chain Details",
    `
      <div class="custody-hash-page custody-hash-page-enterprise">

        ${renderCustodyHashChainNotice()}

        ${renderEnterpriseCustodyHashTable(vm)}
      </div>
    `,
    { pageBreakBefore: true, className: "custody-hash-chain-section" }
  );
}