import { ReportViewModel } from "../types.js";
import {
  renderCallout,
  renderKeyValueGrid,
  renderPageSection,
} from "../ui.js";

export function renderIntegrityProofSection(vm: ReportViewModel): string {
  return renderPageSection(
    "Integrity Proof",
    `
      <div class="callout tone-neutral">
        <div class="callout-title">Technical scope</div>
        <div class="callout-body">
          This section explains what the system technically supports about the recorded
          state of the evidence record. It is intentionally separated from the evidence
          content itself and from broader legal interpretation.
        </div>
      </div>

      ${renderKeyValueGrid(vm.verificationSummaryRows)}

      ${renderCallout({
        title: "What is technically established",
        body:
          "The report records whether file and fingerprint digests, digital signature materials, custody events, timestamp records, public anchoring records, and storage-protection indicators were present in the recorded evidence state.",
        tone: "success",
      })}

      ${renderCallout({
        title: "What is not technically established by this report alone",
        body:
          "This report does not independently prove factual truth, authorship, legal admissibility, narrative context, or the real-world meaning of the evidence content. It supports integrity review of the recorded state only.",
        tone: "warning",
      })}

      ${
        vm.meta.hasCoreCrypto
          ? ""
          : renderCallout({
              title: "Incomplete technical materials",
              body:
                "One or more core technical materials were not present in the report payload. Review should proceed with caution.",
              tone: "danger",
            })
      }
    `
  );
}