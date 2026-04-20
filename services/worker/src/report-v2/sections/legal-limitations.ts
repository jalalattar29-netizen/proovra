import { ReportViewModel } from "../types.js";
import { renderCallout, renderPageSection } from "../ui.js";

export function renderLegalLimitationsSection(vm: ReportViewModel): string {
  return renderPageSection(
    "Legal Interpretation & Review Use",
    `
      ${renderCallout({
        title: "What this report does not independently prove",
        body: vm.legalLimitations.detailed,
        tone: "warning",
      })}

      ${renderCallout({
        title: "Correct review posture",
        body:
          "Review the evidence content itself, then review the integrity materials that protect the recorded state of that content, then assess legal relevance, authenticity disputes, authorship, context, and admissibility under the applicable procedure.",
        tone: "neutral",
      })}

      ${renderCallout({
        title: "Embedded previews are reviewer representations",
        body:
          "Any embedded image, document snapshot, or other reviewer-facing representation in this report is included to support human review of the preserved evidence item. It should not be treated as a substitute for the preserved original file when deeper review, expert comparison, or formal legal process requires the underlying evidence.",
        tone: "warning",
      })}
    `,
    { pageBreakBefore: true }
  );
}