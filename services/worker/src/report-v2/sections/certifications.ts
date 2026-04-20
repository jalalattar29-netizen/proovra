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
      `
        ${renderCallout({
          title: "Platform certification state",
          body:
            vm.integrityVerified
              ? "No human attestation or third-party declaration was attached to this report. However, the preserved record does contain system-level cryptographic integrity materials, recorded timestamping state, custody chronology, and storage-protection indicators. This means the report remains technically reviewable even without a separate custodian or qualified-person attestation."
              : "No human attestation or third-party declaration was attached to this report, and the record should be reviewed as a system-generated technical report rather than a human-certified attestation package.",
          tone: vm.integrityVerified ? "neutral" : "warning",
        })}

        ${renderKeyValueGrid([
          {
            label: "Attestation Type",
            value: "No human attestation attached",
          },
          {
            label: "System Integrity State",
            value: vm.integrityVerified
              ? "Recorded integrity verified"
              : "Manual review required",
          },
          {
            label: "Signature Materials",
            value: vm.meta.hasCoreCrypto ? "Present" : "Incomplete",
          },
          {
            label: "Timestamp Status",
            value: vm.meta.timestampRows.find((row) => row.label === "Timestamp Status")?.value ?? "Not recorded",
          },
          {
            label: "Public Anchoring",
            value: vm.meta.otsRows.find((row) => row.label === "OTS Status")?.value ?? "Not recorded",
          },
          {
            label: "Storage Protection",
            value:
              vm.storageRows.find((row) => row.label === "Immutable Storage")?.value ??
              "Not recorded",
          },
          {
            label: "Verification Package",
            value: vm.meta.verificationPackageVersionLabel,
          },
          {
            label: "Reviewer Summary Version",
            value: vm.meta.reviewerSummaryVersionLabel,
          },
        ])}

        ${renderCallout({
          title: "Interpretation note",
          body:
            "This section distinguishes human attestation from system certification. A missing human certification does not erase the cryptographic, timestamping, custody, or storage materials recorded elsewhere in this report.",
          tone: "neutral",
        })}
      `,
      { pageBreakBefore: true }
    );
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