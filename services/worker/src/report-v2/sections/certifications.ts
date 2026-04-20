import { ReportViewModel } from "../types.js";
import {
  renderCallout,
  renderKeyValueGrid,
  renderPageSection,
} from "../ui.js";

export function renderCertificationsSection(vm: ReportViewModel): string {
  if (!vm.certifications.hasAny) {
    return "";
  }

  return renderPageSection(
    "Certification & Attestation",
    `
      ${renderCallout({
        title: "Certification scope",
        body:
          "This section records any attached custodian or qualified-person declarations preserved with the report payload. These declarations are separate from the system’s cryptographic integrity controls and should be read together, not as substitutes for one another.",
        tone: "neutral",
      })}

      ${vm.certificationBlocks
        .map(
          (block) => `
            ${renderCallout(block.callout)}
            ${renderKeyValueGrid(block.rows)}
          `
        )
        .join("")}
    `,
    { pageBreakBefore: true }
  );
}