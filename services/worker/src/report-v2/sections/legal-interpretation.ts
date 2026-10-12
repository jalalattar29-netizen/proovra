import { ReportViewModel } from "../types.js";
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

/**
 * THE REPORT BOUNDARY (2026-10-13): stated once, concisely, on the review
 * index page. The cover carries its one-line form; nothing else repeats it.
 */
export function renderReportBoundary(vm: ReportViewModel): string {
  return `
    <section class="legal-interpretation-compact" data-report-boundary>
      <div class="executive-outcome-title">Report boundary</div>
      <div class="legal-interpretation-grid">
        ${renderLegalCard({
          title: "What this report is",
          body:
            "A technical record of the preserved evidence's integrity, signature, timestamps, storage and custody. It supports detecting changes after the recorded workflow point.",
          tone: "verify",
        })}
        ${renderLegalCard({
          title: "What it does not establish",
          body:
            "Factual truth, authorship, intent, context, completeness, admissibility or evidentiary weight; those remain for the relevant court, investigator or expert process.",
          tone: "neutral",
        })}
        ${
          vm.presentation.decisions.compactLegalSection
            ? ""
            : renderLegalCard({
                title: "Previews",
                body: "Embedded previews are reviewer aids; rely on the preserved originals and the verification package.",
                tone: "neutral",
              })
        }
      </div>
    </section>
  `;
}
