import { ReportViewModel } from "../types.js";
import { renderCallout, renderPageSection } from "../ui.js";
import { escapeHtml } from "../formatters.js";

function shortHash(value: string | null | undefined): string {
  const hash = String(value ?? "").trim();

  if (!hash || hash === "N/A") {
    return "Genesis event";
  }

  if (hash.length < 32) {
    return hash;
  }

  return `${hash.slice(0, 12)} … ${hash.slice(-12)}`;
}

function renderCustodyHashChainNotice(): string {
  return `
    <div class="custody-hash-chain-notice">
      <p>
        This table contains a curated subset of custody events selected for forensic validation.
      </p>
      <p>
        Sequence identifiers correspond to the original, immutable custody-event log. Non-sequential numbering reflects additional recorded events that are not displayed in this PDF view.
      </p>
      <p>
        Complete custody-event records, including all intermediate entries and full cryptographic hash values, are preserved in the verification package and can also be inspected through the public verification page.
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

<div class="custody-hash-chain-footnote">
  <p>
Events are displayed in custody hash-chain order. Timestamps may not always appear in strict chronological order because asynchronous system processes can append events after referencing the workflow timestamp they document.
  </p>

  <p>
    Full prevEventHash and eventHash values are preserved in custody.json inside the verification package and are available for technical inspection through the verification page.
  </p>
</div>
  `;
}

export function renderCustodyHashChainSection(vm: ReportViewModel): string {
  if (vm.custodyHashRows.length === 0) return "";

  return renderPageSection(
    "Custody Hash Chain Details",
    `
      <div class="custody-hash-page custody-hash-page-enterprise">
        ${renderCallout({
          title: "Chain validation material",
          body:
            "This section provides reviewer-facing custody-chain validation material without turning the PDF into a raw technical dump. The table preserves the relationship between selected custody events and their chained hash references.",
          tone: "neutral",
        })}

        ${renderCustodyHashChainNotice()}

        ${renderEnterpriseCustodyHashTable(vm)}
      </div>
    `,
    { pageBreakBefore: true, className: "custody-hash-chain-section" }
  );
}