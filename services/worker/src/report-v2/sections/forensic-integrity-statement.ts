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
      <div class="callout tone-neutral">
        <div class="callout-title">${escapeHtml(
          vm.forensicIntegrityStatement.introLead
        )}</div>
        <div class="callout-body">${escapeHtml(
          vm.forensicIntegrityStatement.introBody
        )}</div>
      </div>

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

      <div class="callout tone-neutral">
        <div class="callout-title">Technical note</div>
        <div class="callout-body">${escapeHtml(
          vm.forensicIntegrityStatement.note
        )}</div>
      </div>

      ${renderCallout(vm.forensicIntegrityStatement.legalNotice)}

      <div class="callout tone-neutral">
        <div class="callout-title">${escapeHtml(
          vm.forensicIntegrityStatement.verificationLinkLabel
        )}</div>
        <div class="callout-body">${escapeHtml(
          vm.forensicIntegrityStatement.verificationLinkText
        )}</div>
      </div>
    `,
    { pageBreakBefore: true }
  );
}