import { ReportViewModel } from "../types.js";
import { escapeHtml } from "../formatters.js";
import {
  renderPageSection,
  renderTrustDecisionHero,
  renderTrustSignalGrid,
} from "../ui.js";
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
  const trustDecisionBlock = `
    ${renderTrustDecisionHero(vm.trustDecision)}
    <section class="executive-trust-reason">
      <div class="executive-outcome-title">Decision basis</div>
      <div class="executive-outcome-body">
        ${escapeHtml(vm.trustDecision.primaryReason)}
      </div>
      <div class="executive-reviewer-action">
        ${escapeHtml(vm.trustDecision.reviewerAction)}
      </div>
    </section>
  `;

  const leadItemType = findRowValue(vm.executiveRows, "Lead Item Type", "");
const leadItemName = findRowValue(vm.executiveRows, "Lead Review Item", "");

const leadItemValue =
  leadItemType && leadItemName
    ? `${leadItemType} • ${leadItemName}`
    : leadItemName || leadItemType || "Not recorded";
    
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
      label: "Organization / Workspace",
      value: findRowValue(vm.executiveRows, "Organization / Workspace"),
    },
{
  label: "Identity Level",
  value: findRowValue(vm.reviewReadinessRows, "Identity Level"),
},
{
  label: "Lead Item",
  value: leadItemValue,
},
{
  label: "Trust Decision",
  value: `${vm.trustDecision.verdictLabel} • ${vm.trustDecision.scoreLabel}`,
},
{
  label: "Reliance Level",
  value: vm.trustDecision.relianceLevel,
},
  ];

  return renderPageSection(
    "Executive Summary",
    `
      <div class="executive-summary-page">
        <section class="executive-confirmation-card tone-success">
          <div class="executive-confirmation-kicker">What this report confirms</div>
          <div class="executive-confirmation-title">
The evidence package has recorded preservation and integrity materials for review.
          </div>
          <div class="executive-confirmation-body">
Reviewers can use this report to inspect the evidence package, custody history, storage controls, timestamp status, and technical materials through the appendix and verification page.
          </div>
        </section>

        ${trustDecisionBlock}

        ${renderExecutiveTable(executiveRows)}

        <div class="executive-bottom-outcomes">
          ${renderTrustSignalGrid(vm.trustDecision.signals)}
          
          <section class="executive-outcome executive-outcome-warning executive-boundary-outcome">
            <div class="executive-outcome-title">Important boundary</div>
            <div class="executive-outcome-body">
              This report verifies recorded integrity and preservation state only. Legal admissibility, factual truth, authorship, context, and evidentiary weight require separate review.
            </div>
          </section>
        </div>
              </div>
    `,
{ className: "executive-summary-section" }
  );
}