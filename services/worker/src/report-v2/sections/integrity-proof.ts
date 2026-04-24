import { ReportViewModel } from "../types.js";
import {
  renderCallout,
  renderKeyValueGrid,
  renderPageSection,
} from "../ui.js";

function findRowValue(
  rows: Array<{ label: string; value: string }>,
  label: string,
  fallback = "Not recorded"
): string {
  return rows.find((row) => row.label === label)?.value ?? fallback;
}

function toneFromValue(value: string, positiveWords: string[]) {
  const normalized = value.toLowerCase();
  return positiveWords.some((word) => normalized.includes(word))
    ? "success"
    : "warning";
}

function renderIntegrityControlCard(params: {
  kicker: string;
  title: string;
  value: string;
  note: string;
  tone: "success" | "warning" | "danger" | "neutral";
}): string {
  return `
    <article class="integrity-control-card tone-${params.tone}">
      <div class="integrity-control-kicker">${params.kicker}</div>
      <div class="integrity-control-title">${params.title}</div>
      <div class="integrity-control-value">${params.value}</div>
      <div class="integrity-control-note">${params.note}</div>
    </article>
  `;
}

export function renderIntegrityProofSection(vm: ReportViewModel): string {
  const timestampStatus = findRowValue(vm.storageRows, "RFC 3161 Status");
  const storageStatus = findRowValue(vm.storageRows, "Immutable Storage");
  const anchoringStatus = findRowValue(vm.storageRows, "Public Anchoring Status");

  const signatureStatus = findRowValue(
    vm.verificationSummaryRows,
    "Signature Materials"
  );

  const integrityRows = vm.verificationSummaryRows.filter((row) =>
    [
      "Integrity State",
      "Signature Materials",
      "Timestamp Status",
      "Anchoring Status",
      "Storage Lock Mode",
      "Retention Until (UTC)",
      "Forensic Custody Events",
      "Last Verified At (UTC)",
      "Last Verified Source",
    ].includes(row.label)
  );

  const stateCallout = vm.meta.hasCoreCrypto
    ? renderCallout({
        title: "Core verification materials present",
        body:
          "The report payload includes the recorded file digest, canonical fingerprint hash, signature reference, signing-key reference, timestamp state, storage state, and anchoring state required for technical review.",
        tone: "success",
      })
    : renderCallout({
        title: "Incomplete verification materials",
        body:
          "One or more core verification materials were not present in the report payload. Review should proceed with caution and the verification endpoint should be inspected.",
        tone: "danger",
      });

  return renderPageSection(
    "Integrity & Preservation",
    `
      ${renderCallout({
        title: "Technical control summary",
        body:
          "This page consolidates the integrity and preservation controls that matter for fast review. Full hashes, timestamp identifiers, anchoring values, and audit references remain in the Technical Appendix.",
        tone: "neutral",
      })}

      <div class="integrity-control-grid">
        ${renderIntegrityControlCard({
          kicker: "Integrity",
          title: "Recorded Integrity State",
          value: vm.integrityVerified ? "Verified" : "Review required",
          note:
            "Represents whether the recorded technical integrity state passed at report generation time.",
          tone: vm.integrityVerified ? "success" : "warning",
        })}

        ${renderIntegrityControlCard({
          kicker: "Signature",
          title: "Signature Materials",
          value: signatureStatus,
          note:
            "Indicates whether signature and signing-key references are present for independent verification.",
          tone:
            signatureStatus.toLowerCase().includes("recorded") ||
            signatureStatus.toLowerCase().includes("present")
              ? "success"
              : "warning",
        })}

        ${renderIntegrityControlCard({
          kicker: "RFC 3161",
          title: "Trusted Timestamp",
          value: timestampStatus,
          note:
            "Timestamp status shows whether an external time reference was recorded for the evidence state.",
          tone: toneFromValue(timestampStatus, [
            "recorded",
            "granted",
            "verified",
            "valid",
          ]),
        })}

        ${renderIntegrityControlCard({
          kicker: "Storage",
          title: "Immutable Storage",
          value: storageStatus,
          note:
            "Storage protection records whether immutable/object-lock controls were available for the preserved artifact state.",
          tone: toneFromValue(storageStatus, [
            "verified",
            "protected",
            "compliance",
            "governance",
          ]),
        })}

        ${renderIntegrityControlCard({
          kicker: "Anchoring",
          title: "Public Anchoring",
          value: anchoringStatus,
          note:
            "Anchoring links the recorded digest state to an external publication or OpenTimestamps workflow when available.",
          tone: toneFromValue(anchoringStatus, [
            "anchored",
            "recorded",
            "published",
            "verified",
            "pending",
          ]),
        })}

        ${renderIntegrityControlCard({
          kicker: "Custody",
          title: "Forensic Events",
          value:
            vm.forensicRows.length > 0
              ? `${vm.forensicRows.length} forensic event${
                  vm.forensicRows.length === 1 ? "" : "s"
                }`
              : "No forensic custody events",
          note:
            "Custody events are presented chronologically in the Chain of Custody section.",
          tone: vm.forensicRows.length > 0 ? "success" : "warning",
        })}
      </div>

      ${renderKeyValueGrid(integrityRows)}

      ${renderCallout({
        title: "Important boundary",
        body:
          "Integrity, timestamping, storage protection, and anchoring help verify the recorded preservation state. They do not independently prove factual truth, authorship, context, or admissibility.",
        tone: "neutral",
      })}

      ${stateCallout}
    `,
    { pageBreakBefore: true }
  );
}