import { ReportViewModel } from "../types.js";
import {
  renderCallout,
  renderCustodyHashTable,
  renderPageSection,
} from "../ui.js";

export function renderCustodyHashChainSection(vm: ReportViewModel): string {
  if (vm.custodyHashRows.length === 0) return "";

  return renderPageSection(
    "Custody Hash Chain Details",
    `
      <div class="custody-hash-page">
        ${renderCallout({
          title: "Chain validation material",
          body:
            "Full prevEventHash and eventHash values are preserved below for custody-chain validation without overloading the main chronology page. Each row records the cryptographic relationship between one custody event and the event that preceded it.",
          tone: "neutral",
        })}

        ${renderCustodyHashTable(vm.custodyHashRows)}
      </div>
    `,
    { pageBreakBefore: true, className: "custody-hash-chain-section" }
  );
}