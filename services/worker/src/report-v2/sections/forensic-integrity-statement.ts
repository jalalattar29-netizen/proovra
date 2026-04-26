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
    <div class="workflow-step workflow-step-compact">
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

function buildWorkflowResult(step: string, index: number): string {
  const normalized = step.toLowerCase();

  if (index === 0 && normalized.includes("complete multipart evidence set")) {
    return "Ensures the reviewer validates the complete package, not only a preview or single extracted file.";
  }

if (
  index === 2 &&
  (normalized.includes("canonical package digest") ||
    normalized.includes("package digest") ||
    normalized.includes("multipart composite hash") ||
    normalized.includes("composite hash"))
) {
  return "Confirms the recorded package digest matches the package structure and item SHA-256 values.";
}

  if (
    index === 2 &&
    (normalized.includes("multipart composite hash") ||
      normalized.includes("composite hash"))
  ) {
    return "Confirms the recorded package fingerprint matches the preserved item structure and digests.";
  }

  if (normalized.includes("sha")) {
    return "Confirms the preserved file has not been altered after recording.";
  }

  if (normalized.includes("signature")) {
    return "Validates authenticity of the recorded evidence package.";
  }

  if (normalized.includes("opentimestamp")) {
  return "Links the evidence digest to a public, independently verifiable timestamping trail.";
}

  if (normalized.includes("timestamp")) {
    return "Establishes existence of the evidence at a specific point in time.";
  }

  if (normalized.includes("custody")) {
    return "Provides a chronological record of how the evidence was handled.";
  }

  if (normalized.includes("storage")) {
    return "Indicates protection against modification after preservation.";
  }

  return "Supports structured technical verification of the evidence.";
}

export function renderForensicIntegrityStatementSection(
  vm: ReportViewModel
): string {
  const compact = vm.presentation.decisions.compactForensicStatement;

  const steps = vm.forensicIntegrityStatement.reviewSteps
    .map((step, i) =>
      renderWorkflowStep({
        index: i + 1,
        title: `Step ${i + 1}`,
        action: step,
        result: buildWorkflowResult(step, i),
      })
    )
    .join("");

  return renderPageSection(
    "Reviewer Verification Workflow",
    `
      <div class="workflow-page">
        ${renderCallout({
          title: vm.forensicIntegrityStatement.introLead,
          body: vm.forensicIntegrityStatement.introBody,
          tone: "neutral",
        })}

        <div class="workflow-grid">
          <section class="workflow-card workflow-card-checkpoints">
            <div class="workflow-card-title">Procedural checkpoints</div>
            ${renderBulletList(vm.forensicIntegrityStatement.includedBulletItems)}
          </section>

          <section class="workflow-card workflow-card-steps">
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

        <div class="workflow-note-block">
          ${renderCallout({
            title: "Verification workflow note",
            body: vm.forensicIntegrityStatement.note,
            tone: "neutral",
          })}
        </div>
      </div>
    `,
    { pageBreakBefore: true, className: "workflow-section" }
  );
}