import { ReportViewModel } from "../types.js";
import { renderPageSection } from "../ui.js";
import { escapeHtml } from "../formatters.js";

function renderLegalCard(params: {
  title: string;
  body: string;
  tone?: "verify" | "limit" | "neutral";
}): string {
  const tone = params.tone ?? "neutral";

  return `
    <article class="legal-interpretation-card legal-interpretation-card-${tone}">
      <h3 class="legal-interpretation-card-title">${escapeHtml(params.title)}</h3>
      <div class="legal-interpretation-card-body">${escapeHtml(params.body)}</div>
    </article>
  `;
}

export function renderLegalInterpretationSection(vm: ReportViewModel): string {
  const previewNote = vm.presentation.decisions.compactLegalSection
    ? ""
    : renderLegalCard({
        title: "Presentation materials",
        body:
          "Embedded previews in this PDF are reviewer-facing representations only. For deeper review, expert comparison, or formal process, rely on the preserved original evidence and the verification workflow rather than the PDF rendering alone.",
        tone: "limit",
      });

  return renderPageSection(
    "Legal Interpretation & Report Boundary",
    `
      <div class="legal-interpretation-page">
        <div class="legal-interpretation-hero">
          <div>
            <div class="legal-interpretation-kicker">Legal and evidentiary boundary</div>
            <div class="legal-interpretation-title">
              This report is a technical preservation and verification record, not a final legal judgment.
            </div>
            <div class="legal-interpretation-copy">
              Reviewers should separate recorded integrity, custody, timestamping, and storage controls from factual truth, authorship, context, relevance, evidentiary weight, and admissibility.
            </div>
          </div>
        </div>

        <div class="legal-interpretation-grid">
          ${renderLegalCard({
            title: "This report verifies",
            body:
              "The report identifies the evidence record, preserved file/package structure, recorded digest references, custody events, signature materials, timestamp state, anchoring state, and storage-protection metadata available at report generation time.",
            tone: "verify",
          })}

          ${renderLegalCard({
            title: "This report does not prove",
            body: vm.legalLimitations.detailed,
            tone: "limit",
          })}

          ${renderLegalCard({
            title: "Integrity vs. factual accuracy",
            body:
              "A valid integrity record can support that the preserved evidence state has not changed after the recorded workflow point. It does not independently prove that the content is true, complete, fairly contextualized, or authored by a particular person.",
            tone: "neutral",
          })}

          ${renderLegalCard({
            title: "Legal review posture",
            body:
              "Use this report as a technical and procedural record. Questions of factual truth, authorship, context, relevance, evidentiary weight, and admissibility remain for the relevant court, investigator, regulator, insurer, employer, or expert process.",
            tone: "neutral",
          })}

          ${previewNote}
        </div>
      </div>
    `,
    { pageBreakBefore: true, className: "legal-interpretation-section" }
  );
}