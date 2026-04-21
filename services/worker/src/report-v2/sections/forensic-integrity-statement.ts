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
    "Forensic Integrity Statement",
    `
      ${renderCallout({
        title: vm.forensicIntegrityStatement.introLead,
        body: vm.forensicIntegrityStatement.introBody,
        tone: "neutral",
      })}

      <div class="callout tone-neutral">
        <div class="callout-title">Procedural checkpoints</div>
        <div class="callout-body">
          ${renderBulletList(vm.forensicIntegrityStatement.includedBulletItems)}
        </div>
      </div>

      <div class="callout tone-neutral">
        <div class="callout-title">Validation workflow</div>
        <div class="callout-body">
          ${renderBulletList(vm.forensicIntegrityStatement.reviewSteps)}
        </div>
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
    { pageBreakBefore: true }
  );
}
