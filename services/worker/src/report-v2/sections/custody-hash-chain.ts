import { ReportViewModel } from "../types.js";
import {
  renderPageSection,
} from "../ui.js";
import { escapeHtml } from "../formatters.js";

export const CUSTODY_HASH_INTRO =
  "Events are listed in hash-chain order. Sequence numbers follow the full custody log, so events omitted here leave gaps.";

function renderCustodyHashChainNotice(): string {
  return `<div class="custody-hash-chain-notice"><p>${escapeHtml(CUSTODY_HASH_INTRO)}</p></div>`;
}

/** Row groups: the first two and the last two rows never stand alone on a page. */
function rowGroups(rows: string[]): string {
  if (rows.length < 4) return `<tbody class="report-keep-together">${rows.join("")}</tbody>`;
  return [
    `<tbody class="report-keep-together">${rows.slice(0, 2).join("")}</tbody>`,
    `<tbody>${rows.slice(2, -2).join("")}</tbody>`,
    `<tbody class="report-keep-together">${rows.slice(-2).join("")}</tbody>`,
  ].join("");
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
      ${rowGroups(vm.custodyHashRows
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
          ))}
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