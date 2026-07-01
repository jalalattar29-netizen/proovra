import { ReportViewModel } from "../types.js";
import { escapeHtml } from "../formatters.js";
import {
  getTrustDecisionPresentationTone,
  getTrustDecisionConfidenceLabel,
  getTrustDecisionLabel,
} from "@proovra/shared";
import { getCaptureContextTimestampLabel } from "@proovra/shared-runtime/technical-metadata";
import {
  renderPageSection,
  renderTrustSignalGrid,
  renderKeyValueGrid,
} from "../ui.js";

/**
 * Server-time label for the Capture Context — never says "intake" for
 * non-intake (web/mobile) evidence. Uppercased to match the panel styling.
 */
function captureTimestampLabel(vm: ReportViewModel): string {
  const a = vm.meta.acquisition;
  return getCaptureContextTimestampLabel({
    acquisitionMethod: a?.method ?? null,
    isIntake: a?.isIntake ?? false,
  });
}

/**
 * Compact "Capture Device" mini-table for the Executive Summary. Used for
 * normal desktop/browser capture where there is NO camera EXIF, so the
 * standalone Technical Summary page is suppressed and these few device rows
 * live inline instead. Renders only when it has ≥2 meaningful rows and no
 * EXIF camera exists. NEVER duplicates evidence type / GPS / hashes / gallery.
 */
function renderCaptureDeviceMini(vm: ReportViewModel): string {
  const ts = vm.technicalSummary;
  if (!ts) return "";
  // For intake evidence the Evidence Acquisition table already covers the
  // submission context — don't add a second device panel (keeps the page
  // from overflowing).
  if (vm.meta.acquisition?.isIntake) return "";
  const ce = ts.captureEnvironment;
  const hasExif = Boolean(ts.exif && ts.exif.exifPresent);
  // When EXIF exists, the Technical Summary page shows device+camera; don't
  // duplicate here.
  if (hasExif || !ce) return "";

  const titleCaseWord = (s: string) =>
    s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  const humanUpload = (v: string | null): string | null => {
    if (!v) return null;
    if (v === "WEB_APP") return "PROOVRA Web Application";
    if (v === "MOBILE_APP") return "PROOVRA Mobile";
    if (v === "INTAKE_LINK") return "Intake Link Submission";
    if (v === "API") return "API Submission";
    return null;
  };
  const humanMethod = (v: string | null): string | null => {
    if (!v) return null;
    if (v === "SECURE_CAPTURE") return "Secure Browser Capture";
    if (v === "UPLOAD") return "Direct Upload";
    if (v === "MOBILE") return "Mobile Capture";
    return null;
  };

  const rows: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: string | null | undefined) => {
    const v = (value ?? "").trim();
    if (v && v.toUpperCase() !== "UNKNOWN") rows.push({ label, value: v });
  };
  push(
    "Operating system",
    [ce.osName, ce.osVersion].filter(Boolean).join(" ") || null,
  );
  push("Device", ce.deviceClass ? titleCaseWord(ce.deviceClass) : null);
  push(
    "Browser",
    [ce.browserName, ce.browserVersion].filter(Boolean).join(" ") || null,
  );
  push("Submitted through", humanUpload(ce.uploadSource));
  push("Capture method", humanMethod(ce.captureMethod));
  push("Timezone", ce.timezone);

  // Fewer than 2 meaningful rows → not worth an inline table.
  if (rows.length < 2) return "";

  return `
    <section class="capture-context-panel evidence-acquisition-panel">
      <div class="capture-context-header">
        <div class="executive-confirmation-kicker">Capture Device</div>
      </div>
      ${renderExecutiveTable(rows)}
    </section>
  `;
}

function findRowValue(
  rows: Array<{ label: string; value: string }>,
  label: string,
  fallback = "N/A"
): string {
  return rows.find((row) => row.label === label)?.value ?? fallback;
}

/**
 * Compact Evidence Acquisition table — how the evidence reached PROOVRA.
 * Lives INSIDE the Executive Summary (near Capture Context), NOT a new page
 * or section. Public-safe: NO recipient value, NO provider IDs. Only
 * meaningful rows render; returns "" when there is nothing to show.
 */
function renderEvidenceAcquisition(vm: ReportViewModel): string {
  const a = vm.meta.acquisition;
  // Intake-only. Normal web / mobile capture never shows this table.
  if (!a || !a.isIntake) return "";
  const rows: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: string | null | undefined) => {
    const v = (value ?? "").trim();
    if (v && v.toUpperCase() !== "UNKNOWN") rows.push({ label, value: v });
  };
  // MAX 5 rows in the PDF to keep the Executive Summary from overflowing.
  // Identity Verification + Submission Time stay in the package/internal
  // surfaces only (they are not dropped from the data model).
  push("Acquisition Method", a.method);
  push("Delivery Channel", a.deliveryChannel);
  push("Submission Type", a.submissionType);
  push(
    "Submission Status",
    a.submissionStatus.length ? a.submissionStatus.join(" • ") : null,
  );
  if (a.consentAccepted === true) push("Consent", "Accepted");
  if (rows.length === 0) return "";

  return `
    <section class="capture-context-panel evidence-acquisition-panel">
      <div class="capture-context-header">
        <div class="executive-confirmation-kicker">Evidence Acquisition</div>
      </div>
      ${renderExecutiveTable(rows)}
    </section>
  `;
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
            [captureTimestampLabel(vm), vm.meta.captureContext.capturedAtLabel],
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

        ${renderEvidenceAcquisition(vm)}

        ${renderCaptureDeviceMini(vm)}

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
