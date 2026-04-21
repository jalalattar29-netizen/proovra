import { ReportViewModel } from "../types.js";
import { renderCallout, renderPageSection } from "../ui.js";

export function renderLegalLimitationsSection(vm: ReportViewModel): string {
  const { decisions } = vm.presentation;

  return renderPageSection(
    "Legal Interpretation & Review Use",
    `
      ${renderCallout({
        title: "What this report does not independently prove",
        body: vm.legalLimitations.detailed,
        tone: "warning",
      })}

      ${renderCallout({
        title: "Legal review posture",
        body:
          "Use this report as a technical and procedural record. Questions of factual truth, authorship, context, relevance, evidentiary weight, and admissibility remain for the relevant court, investigator, regulator, insurer, employer, or expert process.",
        tone: "neutral",
      })}

      ${
        decisions.compactLegalSection
          ? ""
          : renderCallout({
              title: "Presentation materials",
              body:
                "Any embedded preview in this report is a reviewer-facing representation only. Where deeper review, expert comparison, or formal process is required, rely on the preserved original evidence and the verification workflow rather than the PDF rendering alone.",
              tone: "warning",
            })
      }
    `,
    { pageBreakBefore: true }
  );
}
