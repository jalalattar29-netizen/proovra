import { ReportViewModel } from "../types.js";
import {
  renderCallout,
  renderKeyValueGrid,
  renderPageSection,
} from "../ui.js";

export function renderCertificationsSection(vm: ReportViewModel): string {
  if (!vm.certifications.hasAny) {
    return renderPageSection(
      "Certification & Attestation",
      renderCallout({
        title: "No actual certification attached",
        body:
          "No actual stored attestation record was attached to this evidence report. This means a certification workflow was not completed as part of the preserved record.",
        tone: "warning",
      })
    );
  }

  return renderPageSection(
    "Certification & Attestation",
    vm.certificationBlocks
      .map(
        (block) => `
          ${renderCallout(block.callout)}
          ${renderKeyValueGrid(block.rows)}
        `
      )
      .join("")
  );
}