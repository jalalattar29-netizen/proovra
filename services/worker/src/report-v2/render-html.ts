import type { ReportViewModel } from "./types.js";
import { renderReportShell } from "./templates/report-shell.js";
import { renderCoverSection } from "./sections/cover.js";
import { renderExecutiveSummarySection } from "./sections/executive-summary.js";
import { renderGallerySection } from "./sections/gallery.js";
import { renderIntegrityProofSection } from "./sections/integrity-proof.js";
import { renderCustodySection } from "./sections/custody.js";
import { renderCustodyHashChainSection } from "./sections/custody-hash-chain.js";
import { renderForensicIntegrityStatementSection } from "./sections/forensic-integrity-statement.js";
import { renderTechnicalSummarySection } from "./sections/technical-summary.js";
import { renderMediaIntelligenceSection } from "./sections/media-intelligence.js";
import { renderIntelligenceSummarySection } from "./sections/intelligence-summary.js";
import { renderLifecycleSummarySection } from "./sections/lifecycle-summary.js";
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
    // Enterprise Technical Metadata layer — compact "Media Technical
    // Summary" (media facts + EXIF summary + capture environment).
    // Returns "" when vm.technicalSummary is null, preserving byte
    // output for callers that don't supply it. Positioned after the
    // Forensic Integrity Statement so technical file facts sit with the
    // integrity context and before the advisory/intelligence sections.
    renderTechnicalSummarySection(vm),
    // Phase 31.10 — bounded "Media Intelligence Observations" (advisory
    // signals + derived thumbnails + OCR/transcript availability).
    // Returns "" when vm.mediaIntelligence is null or carries no signals
    // / thumbnails / OCR entries, so legacy byte output is preserved.
    // Positioned AFTER the Forensic Integrity Statement (which carries
    // the "Reviewer Verification Workflow" heading) and the new compact
    // "Media Technical Summary", and BEFORE the Legal Interpretation
    // hierarchy. This is the ADVISORY layer — semantically distinct from
    // the deterministic "Media Technical Summary" above it.
    renderMediaIntelligenceSection(vm),
    // Phase 4A Final Closure — bounded "Intelligence Summary" section.
    // Returns "" when vm.intelligenceSummary is null OR carries no
    // document/transcript/provider activity, so legacy byte output is
    // preserved for every caller that does not opt in. Positioned
    // after media intelligence and before the legal interpretation
    // hierarchy so the AI-assisted-intelligence chain reads top-down.
    vm.intelligenceSummary
      ? renderIntelligenceSummarySection(vm.intelligenceSummary)
      : "",
    // Phase 4B Final Closure (I2) — bounded "Evidence Lifecycle Summary"
    // section. Returns "" when vm.lifecycleSummary is null or the workspace
    // has no lifecycle activity, so legacy byte output is preserved for
    // every caller that does not opt in. Positioned after intelligence-summary
    // and before the custody chain so governance context precedes custody detail.
    renderLifecycleSummarySection(vm.lifecycleSummary ?? null),
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
