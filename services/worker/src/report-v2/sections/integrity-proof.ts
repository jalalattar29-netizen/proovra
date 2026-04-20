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
      ${renderCallout({
        title: "Technical scope",
        body:
          "This section explains what the system technically supports about the recorded state of the evidence record. It is intentionally separated from evidence presentation and from legal interpretation.",
        tone: "neutral",
      })}

      ${renderKeyValueGrid(vm.verificationSummaryRows)}

      ${renderCallout({
        title: "What is technically established",
        body:
          "The report records whether file digests, fingerprint digests, digital-signature materials, custody events, timestamp records, public anchoring records, and storage-protection indicators were present in the recorded evidence state.",
        tone: "success",
      })}

      ${
        vm.meta.hasCoreCrypto
          ? renderCallout({
              title: "Core cryptographic materials present",
              body:
                "Core file hash, fingerprint hash, signature material, and signing-key reference are present in the report model.",
              tone: "success",
            })
          : renderCallout({
              title: "Incomplete technical materials",
              body:
                "One or more core technical materials were not present in the report payload. Review should proceed with caution.",
              tone: "danger",
            })
      }
    `,
    { pageBreakBefore: true }
  );
}