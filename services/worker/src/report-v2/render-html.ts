import type { ReportViewModel } from "./types.js";
import { renderReportShell } from "./templates/report-shell.js";
import { renderCoverSection } from "./sections/cover.js";
import { renderExecutiveSummarySection } from "./sections/executive-summary.js";
import { renderGallerySection } from "./sections/gallery.js";
import { renderCustodySection } from "./sections/custody.js";
import { renderCustodyHashChainSection } from "./sections/custody-hash-chain.js";
import { renderForensicIntegrityStatementSection } from "./sections/forensic-integrity-statement.js";
import { renderTechnicalSummarySection } from "./sections/technical-summary.js";
import { renderIntelligenceSummarySection } from "./sections/intelligence-summary.js";
import { renderLifecycleSummarySection } from "./sections/lifecycle-summary.js";
import { renderLegalInterpretationSection } from "./sections/legal-interpretation.js";
import { renderTechnicalAppendixSection } from "./sections/technical-appendix.js";
import { renderCertificationsSection } from "./sections/certifications.js";

export function renderReportHtml(vm: ReportViewModel): string {
  const body = [
    renderCoverSection(vm),
    renderExecutiveSummarySection(vm),
    renderGallerySection(vm),
    // Integrity Control Checklist REMOVED from the PDF (product decision):
    // it duplicated Trust Signal Analysis without adding hashes/signature
    // detail. Signature, timestamp, anchoring/OTS, storage, and custody
    // status remain in Trust Signal Analysis, the Technical Appendix, and
    // the Chain of Custody. The section module is left in place (unwired).
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
    // Media Intelligence Observations REMOVED (product decision): the
    // advisory/workspace-correlation section (duplicate/similar material
    // observations without hashes or reviewer-actionable proof) added no
    // forensic value to public-facing outputs and was unwired here. The
    // deterministic "Media Technical Summary" above (EXIF + capture
    // environment + media facts) is the forensic metadata that remains.
    // The renderMediaIntelligenceSection module + the underlying signal
    // pipeline are intentionally left in place (no destructive DB/job
    // removal) — only the report wiring is removed.
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
    // Phase 12 Point 4 — Certification & Attestation. `vm.certifications`
    // has been populated by the processor (and served by
    // `GET /v1/evidence/:id/certifications`) all along, but nothing
    // rendered it, so an attached custodian / qualified-person
    // declaration never reached the report. The section returns "" when
    // `certifications.hasAny` is false, so byte output is unchanged for
    // every evidence record without a declaration. Positioned after the
    // legal-interpretation hierarchy — a declaration is read together
    // with the limitations, not as a substitute for them.
    renderCertificationsSection(vm),
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
