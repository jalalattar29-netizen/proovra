import { ReportViewModel } from "../types.js";
import { escapeHtml } from "../formatters.js";
import {
  renderBulletList,
  renderCallout,
  renderPageSection,
} from "../ui.js";

function renderWorkflowStep(params: {
  index: number;
  title: string;
  action: string;
  result: string;
}): string {
  return `
    <div class="workflow-step">
      <div class="workflow-step-index">${params.index}</div>
      <div class="workflow-step-body">
        <div class="workflow-step-title">${escapeHtml(params.title)}</div>
        <div class="workflow-step-action">${escapeHtml(params.action)}</div>
        <div class="workflow-step-result">
          <strong>What this establishes:</strong> ${escapeHtml(params.result)}
        </div>
      </div>
    </div>
  `;
}

export function renderForensicIntegrityStatementSection(
  vm: ReportViewModel
): string {
  const compact = vm.presentation.decisions.compactForensicStatement;

  const steps = vm.forensicIntegrityStatement.reviewSteps.map(
    (step, i) => {
      // 💡 نولد معنى لكل خطوة (مؤقت – بعدين ممكن نربطه بالbackend)
      let result = "Supports structured technical verification of the evidence.";

      if (step.toLowerCase().includes("sha")) {
        result = "Confirms the preserved file has not been altered after recording.";
      }

      if (step.toLowerCase().includes("signature")) {
        result = "Validates authenticity of the recorded evidence package.";
      }

      if (step.toLowerCase().includes("timestamp")) {
        result = "Establishes existence of the evidence at a specific point in time.";
      }

      if (step.toLowerCase().includes("opentimestamp")) {
        result = "Links the evidence state to a public, independently verifiable timeline.";
      }

      if (step.toLowerCase().includes("custody")) {
        result = "Provides a chronological record of how the evidence was handled.";
      }

      if (step.toLowerCase().includes("storage")) {
        result = "Indicates protection against modification after preservation.";
      }

      return renderWorkflowStep({
        index: i + 1,
        title: `Step ${i + 1}`,
        action: step,
        result,
      });
    }
  ).join("");

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
          <div class="workflow-card-title">Verification steps</div>
          <div class="workflow-steps">
            ${steps}
          </div>
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