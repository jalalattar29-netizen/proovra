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
          "This section states the recorded technical condition of the evidence package only. Legal interpretation and procedural workflow are handled elsewhere in the report.",
        tone: "neutral",
      })}

      ${renderKeyValueGrid(vm.verificationSummaryRows)}

      ${renderCallout({
        title: "Recorded technical state",
        body:
          "The report records whether core digests, signature references, custody events, timestamp status, anchoring status, and storage controls were present in the preserved evidence state at report generation time.",
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
