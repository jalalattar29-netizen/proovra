import { ReportViewModel } from "../types.js";
import { escapeHtml } from "../formatters.js";
import { renderCallout, renderPageSection } from "../ui.js";

function findRowValue(
  rows: Array<{ label: string; value: string }>,
  label: string,
  fallback = "N/A"
): string {
  return rows.find((row) => row.label === label)?.value ?? fallback;
}

function renderExecutiveTable(
  rows: Array<{ label: string; value: string }>
): string {
  return `
    <div class="executive-summary-table">
      ${rows
        .map(
          (row) => `
            <div class="executive-summary-row">
              <div class="executive-summary-label">${escapeHtml(row.label)}</div>
              <div class="executive-summary-value">${escapeHtml(row.value)}</div>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

export function renderExecutiveSummarySection(vm: ReportViewModel): string {
  const mismatchBlock =
    vm.mismatchSummary.tone === "success"
      ? `
        <div class="executive-outcome executive-outcome-success">
          <div class="executive-outcome-title">Review Outcome</div>
          <div class="executive-outcome-body">
            No integrity mismatch was reported by the generated report model. Continue with custody, preservation, and technical appendix review for independent validation.
          </div>
        </div>
      `
      : `
        <div class="executive-outcome executive-outcome-warning">
          <div class="executive-outcome-title">${escapeHtml(
            vm.mismatchSummary.title
          )}</div>
          <div class="executive-outcome-body">${escapeHtml(
            vm.mismatchSummary.body
          )}</div>
        </div>
      `;

  const executiveRows = [
    {
      label: "Evidence Type",
      value: findRowValue(vm.executiveRows, "Evidence Type"),
    },
    {
      label: "Total Items",
      value: findRowValue(vm.executiveRows, "Item Count"),
    },
    {
      label: "Evidence Structure",
      value: findRowValue(vm.executiveRows, "Evidence Structure"),
    },
    {
      label: "Total Size",
      value: findRowValue(vm.executiveRows, "Total Content Size"),
    },
    {
      label: "Captured & Signed",
      value: [
        findRowValue(vm.executiveRows, "Captured (UTC)", ""),
        findRowValue(vm.executiveRows, "Signed (UTC)", ""),
      ]
        .filter(Boolean)
        .join(" / "),
    },
    {
      label: "Submitted By",
      value: findRowValue(vm.executiveRows, "Submitted By"),
    },
    {
      label: "Organization",
      value: findRowValue(vm.executiveRows, "Organization / Workspace"),
    },
    {
      label: "Identity / Lead Item",
      value: `${findRowValue(vm.executiveRows, "Lead Item Type")} • ${findRowValue(
        vm.executiveRows,
        "Lead Review Item"
      )}`,
    },
    {
      label: "Integrity Result",
      value: vm.verificationStatusLabel,
    },
  ];

  return renderPageSection(
    "Executive Summary",
    `
      <div class="executive-summary-page">
        <section class="executive-confirmation-card tone-${
          vm.executiveConclusion.tone ?? "neutral"
        }">
          <div class="executive-confirmation-kicker">What this report confirms</div>
          <div class="executive-confirmation-title">${escapeHtml(
            vm.executiveConclusion.title
          )}</div>
          <div class="executive-confirmation-body">${escapeHtml(
            vm.executiveConclusion.body
          )}</div>
        </section>

        ${renderExecutiveTable(executiveRows)}

        ${mismatchBlock}

        <section class="executive-legal-boundary">
          <div class="executive-legal-title">${escapeHtml(
            vm.legalLimitationShort.title
          )}</div>
          <div class="executive-legal-body">${escapeHtml(
            vm.legalLimitationShort.body
          )}</div>
        </section>
      </div>
    `,
    { pageBreakBefore: true, className: "executive-summary-section" }
  );
}