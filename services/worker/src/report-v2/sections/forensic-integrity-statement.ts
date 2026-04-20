import { ReportViewModel } from "../types.js";
import {
  renderBulletList,
  renderCallout,
  renderPageSection,
} from "../ui.js";
import { escapeHtml } from "../formatters.js";

export function renderForensicIntegrityStatementSection(
  vm: ReportViewModel
): string {
  return renderPageSection(
    "Forensic Integrity Statement",
    `
      ${renderCallout({
        title: vm.forensicIntegrityStatement.introLead,
        body: vm.forensicIntegrityStatement.introBody,
        tone: "neutral",
      })}

      <div class="callout tone-neutral">
        <div class="callout-title">Integrity materials included in this report</div>
        <div class="callout-body">
          ${renderBulletList(vm.forensicIntegrityStatement.includedBulletItems)}
        </div>
      </div>

      <div class="callout tone-neutral">
        <div class="callout-title">Independent review may include</div>
        <div class="callout-body">
          ${renderBulletList(vm.forensicIntegrityStatement.reviewSteps)}
        </div>
      </div>

      ${renderCallout({
        title: "Technical note",
        body: vm.forensicIntegrityStatement.note,
        tone: "neutral",
      })}

      <div class="verification-link-panel">
        <div class="verification-link-panel-label">${escapeHtml(
          vm.forensicIntegrityStatement.verificationLinkLabel
        )}</div>
        <div class="verification-link-panel-value">${escapeHtml(
          vm.forensicIntegrityStatement.verificationLinkText
        )}</div>
      </div>
    `,
    { pageBreakBefore: true }
  );
}