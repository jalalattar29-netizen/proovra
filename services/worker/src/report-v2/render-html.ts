import type { ReportViewModel } from "./types.js";
import { renderReportShell } from "./templates/report-shell.js";
import { renderCoverSection } from "./sections/cover.js";
import { renderExecutiveSummarySection } from "./sections/executive-summary.js";
import { renderEvidenceContentSection } from "./sections/evidence-content.js";
import { renderPrimaryEvidenceSection } from "./sections/primary-evidence.js";
import { renderGallerySection } from "./sections/gallery.js";
import { renderInventorySection } from "./sections/inventory.js";
import { renderIntegrityProofSection } from "./sections/integrity-proof.js";
import { renderCertificationsSection } from "./sections/certifications.js";
import { renderStorageTimestampingSection } from "./sections/storage-timestamping.js";
import { renderCustodySection } from "./sections/custody.js";
import { renderLegalLimitationsSection } from "./sections/legal-limitations.js";
import { renderForensicIntegrityStatementSection } from "./sections/forensic-integrity-statement.js";
import { renderTechnicalAppendixSection } from "./sections/technical-appendix.js";

export function renderReportHtml(vm: ReportViewModel): string {
  const body = [
    renderCoverSection(vm),
    renderExecutiveSummarySection(vm),
    renderEvidenceContentSection(vm),
    renderPrimaryEvidenceSection(vm),
    renderGallerySection(vm),
    renderInventorySection(vm),
    renderIntegrityProofSection(vm),
    renderCertificationsSection(vm),
    renderStorageTimestampingSection(vm),
    renderCustodySection(vm),
    renderLegalLimitationsSection(vm),
    renderForensicIntegrityStatementSection(vm),
    renderTechnicalAppendixSection(vm),
  ]
    .filter(Boolean)
    .join("");

  return renderReportShell({
    title: `${vm.title} — PROOVRA Verification Report`,
    body,
    generatedAtUtc: vm.generatedAtUtc,
    version: vm.version,
  });
}