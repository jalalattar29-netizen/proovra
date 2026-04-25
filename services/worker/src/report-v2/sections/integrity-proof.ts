import { ReportViewModel } from "../types.js";
import { escapeHtml } from "../formatters.js";
import { renderCallout, renderPageSection } from "../ui.js";

type IntegrityTone = "success" | "warning" | "danger" | "neutral";

function findRowValue(
  rows: Array<{ label: string; value: string }>,
  label: string,
  fallback = "Not recorded"
): string {
  return rows.find((row) => row.label === label)?.value ?? fallback;
}

function toneFromValue(
  value: string,
  positiveWords: string[],
  warningWords: string[] = ["pending", "review", "not fully", "not recorded"]
): IntegrityTone {
  const normalized = value.toLowerCase();

  if (
    normalized.includes("failed") ||
    normalized.includes("incomplete") ||
    normalized.includes("invalid") ||
    normalized.includes("error")
  ) {
    return "danger";
  }

  if (positiveWords.some((word) => normalized.includes(word))) {
    return "success";
  }

  if (warningWords.some((word) => normalized.includes(word))) {
    return "warning";
  }

  return "neutral";
}

function renderIntegrityCheckRow(params: {
  label: string;
  value: string;
  explanation: string;
  tone: IntegrityTone;
}): string {
  const mark =
    params.tone === "success"
      ? "✓"
      : params.tone === "danger"
        ? "!"
        : params.tone === "warning"
          ? "!"
          : "i";

  return `
    <div class="integrity-check-row integrity-check-${params.tone}">
      <div class="integrity-check-mark">${escapeHtml(mark)}</div>
      <div class="integrity-check-content">
        <div class="integrity-check-top">
          <div class="integrity-check-label">${escapeHtml(params.label)}</div>
          <div class="integrity-check-value">${escapeHtml(params.value)}</div>
        </div>
        <div class="integrity-check-explanation">${escapeHtml(params.explanation)}</div>
      </div>
    </div>
  `;
}

function renderIntegrityResultPill(vm: ReportViewModel): string {
  const tone = vm.integrityVerified ? "success" : "warning";
  const value = vm.integrityVerified
    ? "VERIFIED RECORDED INTEGRITY"
    : "TECHNICAL REVIEW REQUIRED";

  return `
    <div class="integrity-result-pill integrity-result-${tone}">
      <span>${vm.integrityVerified ? "✓" : "!"}</span>
      ${escapeHtml(value)}
    </div>
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

  const storageLockMode = findRowValue(
    vm.verificationSummaryRows,
    "Storage Lock Mode"
  );

  const retentionUntil = findRowValue(
    vm.verificationSummaryRows,
    "Retention Until (UTC)"
  );

  const lastVerifiedAt = findRowValue(
    vm.verificationSummaryRows,
    "Last Verified At (UTC)"
  );

  const forensicEvents =
    vm.forensicRows.length > 0
      ? `${vm.forensicRows.length} forensic event${
          vm.forensicRows.length === 1 ? "" : "s"
        }`
      : "No forensic custody events";

  const coreMaterialTone: IntegrityTone = vm.meta.hasCoreCrypto
    ? "success"
    : "danger";

  return renderPageSection(
    "Integrity Control Checklist",
    `
      <div class="integrity-summary-page">
        <div class="integrity-summary-intro">
          <div>
            <div class="integrity-summary-kicker">Recorded preservation controls</div>
            <div class="integrity-summary-title">
              Technical controls supporting the verified integrity result
            </div>
            <div class="integrity-summary-copy">
              This page summarizes the controls used to evaluate the recorded evidence state.
              It is a reviewer-facing checklist, not a substitute for the preserved original,
              full hashes, signature material, timestamp token, custody records, or legal review.
            </div>
          </div>
          ${renderIntegrityResultPill(vm)}
        </div>

        <div class="integrity-check-list">
          ${renderIntegrityCheckRow({
            label: "File Hash",
            value: vm.meta.primaryHash || "Not recorded",
            explanation:
              "Recorded SHA-256 digest for comparing the preserved file or lead evidence item against the report.",
            tone:
              vm.meta.primaryHash && vm.meta.primaryHash !== "N/A"
                ? "success"
                : "danger",
          })}

          ${renderIntegrityCheckRow({
            label: "Digital Signature",
            value: signatureStatus,
            explanation:
              "Signature material and signing-key references support independent validation of the recorded integrity package.",
            tone: toneFromValue(signatureStatus, ["recorded", "present"]),
          })}

          ${renderIntegrityCheckRow({
            label: "Trusted Timestamp",
            value: timestampStatus,
            explanation:
              "RFC 3161 timestamp status records whether an external time reference exists for the evidence state.",
            tone: toneFromValue(timestampStatus, [
              "recorded",
              "granted",
              "verified",
              "valid",
              "trusted timestamp",
            ]),
          })}

          ${renderIntegrityCheckRow({
            label: "Immutable Storage",
            value: storageStatus,
            explanation:
              "Storage controls indicate whether object-lock or immutable-style preservation was recorded for the artifact state.",
            tone: toneFromValue(storageStatus, [
              "verified",
              "protected",
              "immutable",
              "compliance",
              "governance",
            ]),
          })}

          ${renderIntegrityCheckRow({
            label: "Public Anchoring",
            value: anchoringStatus,
            explanation:
              "Anchoring records whether OpenTimestamps or external publication proof is available or still pending.",
            tone: toneFromValue(
              anchoringStatus,
              ["anchored", "anchoring", "published", "verified", "recorded"],
              ["pending", "configured", "not recorded"]
            ),
          })}

          ${renderIntegrityCheckRow({
            label: "Chain of Custody",
            value: forensicEvents,
            explanation:
              "Forensic custody events are recorded separately from access activity and shown chronologically in the custody section.",
            tone: vm.forensicRows.length > 0 ? "success" : "warning",
          })}

          ${renderIntegrityCheckRow({
            label: "Core Verification Materials",
            value: vm.meta.hasCoreCrypto ? "Present" : "Incomplete",
            explanation:
              "Core materials include file digest, fingerprint hash, signature reference, signing key, timestamp state, storage state, and anchoring state.",
            tone: coreMaterialTone,
          })}
        </div>

        <div class="integrity-detail-grid">
          <div class="integrity-detail-card">
            <div class="integrity-detail-label">Storage Lock Mode</div>
            <div class="integrity-detail-value">${escapeHtml(storageLockMode)}</div>
          </div>
          <div class="integrity-detail-card">
            <div class="integrity-detail-label">Retention Until UTC</div>
            <div class="integrity-detail-value">${escapeHtml(retentionUntil)}</div>
          </div>
          <div class="integrity-detail-card">
            <div class="integrity-detail-label">Last Verified At UTC</div>
            <div class="integrity-detail-value">${escapeHtml(lastVerifiedAt)}</div>
          </div>
          <div class="integrity-detail-card">
            <div class="integrity-detail-label">Verification Source</div>
            <div class="integrity-detail-value">${escapeHtml(vm.meta.lastVerifiedSourceLabel)}</div>
          </div>
        </div>

        ${renderCallout({
          title: "Important boundary",
          body:
            "Integrity, timestamping, immutable storage, custody records, and anchoring help verify the recorded preservation state. They do not independently prove factual truth, authorship, context, intent, relevance, evidentiary weight, or legal admissibility.",
          tone: "warning",
        })}
      </div>
    `,
    { pageBreakBefore: true, className: "integrity-summary-section" }
  );
}