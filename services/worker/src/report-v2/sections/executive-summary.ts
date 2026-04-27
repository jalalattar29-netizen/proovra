import { ReportViewModel } from "../types.js";
import { escapeHtml } from "../formatters.js";
import { renderPageSection } from "../ui.js";

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
            No integrity mismatch was detected in the generated verification model. Review custody, preservation, and appendix materials for independent validation.
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
  label: "Integrity Review State",
  value: vm.integrityVerified
    ? "Recorded integrity checks passed"
    : "Recorded integrity materials available; reviewer validation required",
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

        ${renderExecutiveTable(executiveRows)}

        ${mismatchBlock}

<section class="executive-outcome executive-outcome-warning">
  <div class="executive-outcome-title">Important boundary</div>
  <div class="executive-outcome-body">
    This report verifies recorded integrity and preservation state only. Legal admissibility, factual truth, authorship, context, and evidentiary weight require separate review.
  </div>
</section>
      </div>
    `,
{ className: "executive-summary-section" }
  );
}