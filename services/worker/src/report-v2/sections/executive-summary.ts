import { ReportViewModel } from "../types.js";
import { escapeHtml } from "../formatters.js";
import {
  getReviewerRelianceLabel,
  getTrustDecisionLabel,
} from "@proovra/shared";
import {
  renderPageSection,
  renderTrustSignalGrid,
  renderKeyValueGrid,
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

function renderCaptureContext(vm: ReportViewModel): string {
  if (!vm.meta.captureContext) return "";

  return `
    <section class="capture-context-panel">
      <div class="capture-context-header">
        <div class="executive-confirmation-kicker">Capture Context</div>
        <div class="capture-context-intro">
          ${escapeHtml(vm.meta.captureContext.description)}
        </div>
      </div>
      <div class="capture-context-layout">
        <div class="capture-context-map-shell">
          <img
            class="capture-context-map"
            src="${vm.meta.captureContext.mapPreviewDataUrl}"
            alt="Capture location preview"
          />
        </div>

        <div class="capture-context-metadata">
          ${[
            ["Location metadata included", "Yes"],
            ["Latitude", vm.meta.captureContext.lat],
            ["Longitude", vm.meta.captureContext.lng],
            ["Accuracy radius", vm.meta.captureContext.accuracyRadius],
            ["Recorded at intake (server UTC)", vm.meta.captureContext.capturedAtLabel],
            ["Source", vm.meta.captureContext.sourceLabel],
          ]
            .map(
              ([label, value]) => `
                <div class="capture-context-row">
                  <div class="capture-context-label">${escapeHtml(label)}</div>
                  <div class="capture-context-value">${escapeHtml(value)}</div>
                </div>
              `
            )
            .join("")}
        </div>
      </div>

      <div class="capture-context-note">
        ${escapeHtml(vm.meta.captureContext.legalBoundary)}
      </div>
    </section>
  `;
}

function renderExecutiveDecisionBasis(vm: ReportViewModel): string {
  return `
    <section class="executive-trust-reason">
      <div class="executive-outcome-title">Decision basis</div>
      <div class="executive-outcome-body">
        ${escapeHtml(vm.trustDecision.primaryReason)}
      </div>
    </section>
  `;
}

function renderExecutiveBoundary(vm: ReportViewModel): string {
  return `
    <section class="executive-outcome executive-outcome-warning executive-boundary-outcome">
      <div class="executive-outcome-title">Important boundary</div>
      <div class="executive-outcome-body">
        This report verifies recorded integrity and preservation state only. Legal admissibility, factual truth, authorship, context, and evidentiary weight require separate review.
      </div>
      <div class="executive-reviewer-action">
        ${escapeHtml(vm.trustDecision.reviewerAction)}
      </div>
    </section>
  `;
}

function renderTrustSignalAnalysisPage(vm: ReportViewModel): string {
  return renderPageSection(
    "Trust Signal Analysis",
    `
      <div class="trust-signal-analysis-page">
        <section class="trust-signal-analysis-hero">
          <div class="executive-confirmation-kicker">Verification layer review</div>
          <div class="executive-confirmation-title">
            Signal-level basis for the Trust Decision
          </div>
          <div class="executive-confirmation-body">
            This page explains how the recorded integrity, signature, timestamping, anchoring, storage, custody, identity, and package layers support reviewer interpretation. It is a supporting analysis layer, not a separate legal conclusion.
          </div>
        </section>

        ${renderTrustSignalGrid(vm.trustDecision.signals)}

        <section class="trust-signal-analysis-footer">
          <div class="executive-outcome-title">Reviewer interpretation</div>
          <div class="executive-outcome-body">
            ${escapeHtml(vm.trustDecision.primaryReason)}
          </div>
          <div class="executive-reviewer-action">
            ${escapeHtml(vm.trustDecision.reviewerAction)}
          </div>
        </section>
      </div>
    `,
    {
      pageBreakBefore: true,
      className: "trust-signal-analysis-section",
    }
  );
}

function renderCourtReviewIndexPage(vm: ReportViewModel): string {
  return renderPageSection(
    "Court & Technical Review Index",
    `
      <div class="trust-signal-analysis-page court-review-index-page">
        <section class="trust-signal-analysis-hero">
          <div class="executive-confirmation-kicker">Court-facing review map</div>
          <div class="executive-confirmation-title">
            Control points for legal, forensic, and technical review
          </div>
          <div class="executive-confirmation-body">
            This page consolidates the main review checkpoints used to connect the report, preserved evidence, cryptographic materials, custody history, verification package, and technical appendix. It is an index for reviewers, not a legal admissibility conclusion.
          </div>
        </section>

        <section class="executive-trust-decision-panel">
          ${renderKeyValueGrid(vm.meta.courtAppendixRows ?? [])}
        </section>

        <section class="trust-signal-analysis-footer">
          <div class="executive-outcome-title">Review boundary</div>
          <div class="executive-outcome-body">
            These control points support technical and procedural review. Factual truth, authorship, context, relevance, legal admissibility, and evidentiary weight remain separate human/legal determinations.
          </div>
        </section>
      </div>
    `,
    {
      pageBreakBefore: true,
      className: "court-review-index-section",
    }
  );
}

export function renderExecutiveSummarySection(vm: ReportViewModel): string {
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
      value:
        [
          findRowValue(vm.executiveRows, "Captured (UTC)", ""),
          findRowValue(vm.executiveRows, "Signed (UTC)", ""),
        ]
          .filter(Boolean)
          .join(" / ") || "Not recorded",
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
      value: getTrustDecisionLabel(vm.trustDecision),
    },
    {
      label: "Technical Confidence",
      value: getReviewerRelianceLabel(vm.trustDecision.relianceLevel),
    },
  ];

  const executivePage = renderPageSection(
    "Executive Summary",
    `
      <div class="executive-summary-page executive-summary-page-enterprise">
        <section class="executive-confirmation-card tone-success">
          <div class="executive-confirmation-kicker">What this report confirms</div>
          <div class="executive-confirmation-title">
            The evidence package has recorded preservation and integrity materials for review.
          </div>
          <div class="executive-confirmation-body">
            Reviewers can use this report to inspect the evidence package, custody history, storage controls, timestamp status, trust decision, and technical materials through the appendix and verification page.
          </div>
        </section>

        ${renderCaptureContext(vm)}

        ${renderExecutiveTable(executiveRows)}

        <div class="executive-bottom-outcomes">
          ${renderExecutiveDecisionBasis(vm)}
          ${renderExecutiveBoundary(vm)}
        </div>
      </div>
    `,
    { className: "executive-summary-section" }
  );

return `${executivePage}${renderTrustSignalAnalysisPage(vm)}${renderCourtReviewIndexPage(vm)}`;
}
