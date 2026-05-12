import { ReportViewModel } from "../types.js";
import { escapeHtml } from "../formatters.js";
import {
  getTrustDecisionPresentationTone,
  getTrustDecisionConfidenceLabel,
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
  const leadItemType =
    findRowValue(vm.executiveRows, "Lead Item Type", "") ||
    findRowValue(vm.executiveRows, "Primary Evidence Coverage", "");

  const leadItemName =
    findRowValue(vm.executiveRows, "Lead Review Item", "") ||
    findRowValue(vm.executiveRows, "Primary Evidence Set", "");

  const leadItemValue =
    leadItemType && leadItemName
      ? `${leadItemName} • ${leadItemType}`
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
          findRowValue(vm.executiveRows, "Recorded at intake (server UTC)", ""),
          findRowValue(vm.executiveRows, "Signed (server UTC)", ""),
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
      value: getTrustDecisionConfidenceLabel(vm.trustDecision),
    },
  ];

  // Phase D Blocker 4 — render the executiveConclusion callout from the
  // view model (truth-model.buildExecutiveConclusion). The viewmodel
  // computed it from the verified state of the recorded integrity, but
  // no template was rendering it before this pass. Both the report cover
  // and the executive summary should make the conclusion explicit so a
  // reviewer scanning the front of the PDF cannot miss it. Using the
  // computed callout (not hard-coded copy) preserves the verified-vs-
  // reviewable two-state honest wording from truth-model.
  const conclusion = vm.executiveConclusion;
  const conclusionToneClass =
    conclusion.tone === "success"
      ? "tone-success"
      : conclusion.tone === "warning"
        ? "tone-warning"
        : conclusion.tone === "danger"
          ? "tone-danger"
          : "tone-neutral";
  const confirmationToneClass =
    getTrustDecisionPresentationTone(vm.trustDecision) === "success"
      ? "tone-success"
      : "tone-warning";

  const executivePage = renderPageSection(
    "Executive Summary",
    `
      <div class="executive-summary-page executive-summary-page-enterprise">
        <section class="executive-confirmation-card ${escapeHtml(confirmationToneClass)}">
          <div class="executive-confirmation-kicker">What this report confirms</div>
          <div class="executive-confirmation-title">
            The evidence package has recorded preservation and integrity materials for review.
          </div>
          <div class="executive-confirmation-body">
            Reviewers can use this report to inspect the evidence package, custody history, storage controls, timestamp status, trust decision, and technical materials through the appendix and verification page.
          </div>
        </section>

        <section class="executive-confirmation-card executive-conclusion-card ${escapeHtml(conclusionToneClass)}">
          <div class="executive-confirmation-kicker">${escapeHtml(conclusion.title)}</div>
          <div class="executive-confirmation-body">
            ${escapeHtml(conclusion.body)}
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
