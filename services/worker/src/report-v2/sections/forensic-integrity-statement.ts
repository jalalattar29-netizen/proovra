import { ReportViewModel } from "../types.js";
import {
  renderBulletList,
  renderCallout,
  renderPageSection,
} from "../ui.js";

export function renderForensicIntegrityStatementSection(
  vm: ReportViewModel
): string {
  const compact = vm.presentation.decisions.compactForensicStatement;

  return renderPageSection(
    "Reviewer Verification Workflow",
    `
      ${renderCallout({
        title: vm.forensicIntegrityStatement.introLead,
        body: vm.forensicIntegrityStatement.introBody,
        tone: "neutral",
      })}

      <div class="workflow-grid">
        <section class="workflow-card">
          <div class="workflow-card-title">Procedural checkpoints</div>
          ${renderBulletList(vm.forensicIntegrityStatement.includedBulletItems)}
        </section>

        <section class="workflow-card">
          <div class="workflow-card-title">Validation workflow</div>
          ${renderBulletList(vm.forensicIntegrityStatement.reviewSteps)}
        </section>
      </div>

      ${
        compact
          ? ""
          : renderCallout({
              title: vm.forensicIntegrityStatement.legalNotice.title,
              body: vm.forensicIntegrityStatement.legalNotice.body,
              tone: vm.forensicIntegrityStatement.legalNotice.tone,
            })
      }

      ${renderCallout({
        title: "Verification workflow note",
        body: vm.forensicIntegrityStatement.note,
        tone: "neutral",
      })}
    `,
    { pageBreakBefore: true, className: "workflow-section" }
  );
}