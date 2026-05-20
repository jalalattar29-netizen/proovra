import type { ReportViewModel } from "./types.js";
import { renderReportShell } from "./templates/report-shell.js";
import { renderCoverSection } from "./sections/cover.js";
import { renderExecutiveSummarySection } from "./sections/executive-summary.js";
import { renderGallerySection } from "./sections/gallery.js";
import { renderIntegrityProofSection } from "./sections/integrity-proof.js";
import { renderCustodySection } from "./sections/custody.js";
import { renderCustodyHashChainSection } from "./sections/custody-hash-chain.js";
import { renderForensicIntegrityStatementSection } from "./sections/forensic-integrity-statement.js";
import { renderMediaIntelligenceSection } from "./sections/media-intelligence.js";
import { renderLegalInterpretationSection } from "./sections/legal-interpretation.js";
import { renderTechnicalAppendixSection } from "./sections/technical-appendix.js";

export function renderReportHtml(vm: ReportViewModel): string {
  const body = [
    renderCoverSection(vm),
    renderExecutiveSummarySection(vm),
    renderGallerySection(vm),
    renderIntegrityProofSection(vm),
    renderCustodySection(vm),
    renderCustodyHashChainSection(vm),
    renderForensicIntegrityStatementSection(vm),
    // Phase 31.10 — OPTIONAL Media Intelligence Observations section.
    // Returns "" when vm.mediaIntelligence is null/empty, so the
    // legacy byte output is preserved for every existing caller.
    // Positioned AFTER the Reviewer Verification Workflow and BEFORE
    // the Legal Interpretation & Report Boundary so the legal
    // hierarchy is preserved.
    renderMediaIntelligenceSection(vm),
    renderLegalInterpretationSection(vm),
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