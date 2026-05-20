/**
 * Phase 31.10 — Media Intelligence Observations report section.
 *
 * Renders the optional advisory section that appears AFTER the
 * Reviewer Verification Workflow and BEFORE the Legal Interpretation
 * & Report Boundary section.
 *
 * Hard rules (enforced by source-contract tests):
 *
 *   * BYTE-NEUTRAL when intelligence is absent. Returns "" when
 *     `vm.mediaIntelligence` is null/undefined or carries no
 *     signals + no thumbnails + no OCR/transcript entries. The
 *     render-html.ts pipeline `.filter(Boolean)`s the body parts so
 *     an empty section is a true zero-byte addition.
 *   * NEVER claim authenticity, admissibility, factual truth, or
 *     proof. The inline disclaimer carries safer wording ("do not
 *     classify the recorded material and they do not establish
 *     legal weight").
 *   * NEVER use forbidden vocabulary: tampered / forged / fake /
 *     authentic / admissible / proves / confirms / manipulated /
 *     doctored. Source-contract test enforces this.
 *   * NEVER expose storage internals. The renderer reads only the
 *     bounded VM projection — there are no storage_key /
 *     storage_bucket / signed_url fields in the input shape.
 *   * Bounded emission. Each list is capped (signals 200, derived
 *     thumbnails 24, OCR/transcript 200) so a runaway projection
 *     cannot ballast the PDF.
 *   * Preserves the report's existing legal hierarchy. The new
 *     section is informational; it never replaces the Legal
 *     Interpretation & Report Boundary or Forensic Integrity
 *     Statement sections.
 */

import { ReportViewModel } from "../types.js";
import { escapeHtml } from "../formatters.js";
import { renderCallout, renderPageSection } from "../ui.js";

// =============================================================================
// Bounds
// =============================================================================

const MAX_RENDERED_SIGNALS = 200;
const MAX_RENDERED_THUMBNAILS = 24;
const MAX_RENDERED_OCR_TRANSCRIPT = 200;

// =============================================================================
// Severity / confidence display
// =============================================================================
//
// NEVER alarmist. INFO is the most common label and is rendered as
// "Observation". The catalog matches `apps/web/lib/media-intelligence/
// types.ts::severityLabel` exactly so reviewers see consistent
// wording across the panel and the PDF.

function severityLabel(s: "INFO" | "REVIEW_RECOMMENDED" | "ATTENTION"): string {
  switch (s) {
    case "INFO":
      return "Observation";
    case "REVIEW_RECOMMENDED":
      return "Review recommended";
    case "ATTENTION":
      return "Needs attention";
  }
}

function confidenceLabel(c: "LOW" | "MEDIUM" | "HIGH"): string {
  switch (c) {
    case "LOW":
      return "Low confidence";
    case "MEDIUM":
      return "Medium confidence";
    case "HIGH":
      return "High confidence";
  }
}

function statusLabel(
  s: "PENDING" | "ACKNOWLEDGED" | "DISMISSED",
): string {
  switch (s) {
    case "PENDING":
      return "Open";
    case "ACKNOWLEDGED":
      return "Acknowledged";
    case "DISMISSED":
      return "Dismissed";
  }
}

// =============================================================================
// Entry point
// =============================================================================

export function renderMediaIntelligenceSection(vm: ReportViewModel): string {
  const intel = vm.mediaIntelligence;
  if (!intel) return "";

  const signals = (intel.signals ?? []).slice(0, MAX_RENDERED_SIGNALS);
  const thumbnails = (intel.derivedThumbnails ?? []).slice(
    0,
    MAX_RENDERED_THUMBNAILS,
  );
  const ocrTranscript = (intel.ocrTranscript ?? []).slice(
    0,
    MAX_RENDERED_OCR_TRANSCRIPT,
  );

  if (
    signals.length === 0 &&
    thumbnails.length === 0 &&
    ocrTranscript.length === 0
  ) {
    return "";
  }

  const sortedSignals = [...signals].sort(compareSignalsForDisplay);

  const body = `
    <div class="media-intelligence-page">
      ${renderCallout({
        title: "Advisory observations",
        body:
          "The observations below are deterministic, machine-derived metadata observations of the recorded material. They are advisory only. They do not classify the recorded material and they do not establish legal weight; the canonical custody record remains the authoritative integrity artifact.",
        tone: "neutral",
      })}

      ${
        sortedSignals.length > 0
          ? renderSignalsTable(sortedSignals)
          : ""
      }

      ${
        thumbnails.length > 0 ? renderThumbnailsGrid(thumbnails) : ""
      }

      ${
        ocrTranscript.length > 0
          ? renderOcrTranscriptList(ocrTranscript)
          : ""
      }
    </div>
  `;

  return renderPageSection("Media Intelligence Observations", body, {
    pageBreakBefore: true,
    className: "media-intelligence-section",
  });
}

// =============================================================================
// Section parts
// =============================================================================

function renderSignalsTable(
  signals: ReadonlyArray<
    NonNullable<ReportViewModel["mediaIntelligence"]>["signals"] extends
      | ReadonlyArray<infer T>
      | undefined
      ? T
      : never
  >,
): string {
  return `
    <section class="media-intelligence-card media-intelligence-signals-card">
      <div class="media-intelligence-card-title">Recorded observations</div>
      <table class="media-intelligence-table">
        <thead>
          <tr>
            <th>Severity</th>
            <th>Confidence</th>
            <th>Material</th>
            <th>Status</th>
            <th>Observation</th>
          </tr>
        </thead>
        <tbody>
          ${signals
            .map(
              (s) => `
                <tr>
                  <td>
                    <span class="${severityClass(s.severity)}">
                      ${escapeHtml(severityLabel(s.severity))}
                    </span>
                  </td>
                  <td>
                    <span class="media-intelligence-pill media-intelligence-pill-confidence">
                      ${escapeHtml(confidenceLabel(s.confidence))}
                    </span>
                  </td>
                  <td>
                    ${
                      s.materialLabel
                        ? `<span class="media-intelligence-material-label">${escapeHtml(s.materialLabel)}</span>`
                        : `<span class="media-intelligence-material-label media-intelligence-material-label-muted">—</span>`
                    }
                  </td>
                  <td>
                    <span class="${statusClass(s.status)}">
                      ${escapeHtml(statusLabel(s.status))}
                    </span>
                  </td>
                  <td>
                    <div class="media-intelligence-summary">${escapeHtml(s.safeSummary)}</div>
                  </td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </section>
  `;
}

function renderThumbnailsGrid(
  thumbnails: ReadonlyArray<
    NonNullable<ReportViewModel["mediaIntelligence"]>["derivedThumbnails"] extends
      | ReadonlyArray<infer T>
      | undefined
      ? T
      : never
  >,
): string {
  return `
    <section class="media-intelligence-card media-intelligence-thumbnails-card">
      <div class="media-intelligence-card-title">Derived previews</div>
      <div class="media-intelligence-card-hint">
        These are reviewer-facing thumbnails generated from the recorded
        material. They are advisory aids only and are not a substitute for
        the preserved original.
      </div>
      <div class="media-intelligence-thumbnail-grid">
        ${thumbnails
          .map(
            (t) => `
              <figure class="media-intelligence-thumbnail">
                <img
                  src="${escapeHtml(t.dataUrl)}"
                  alt=""
                  class="media-intelligence-thumbnail-img"
                />
                <figcaption class="media-intelligence-thumbnail-caption">
                  ${escapeHtml(humanThumbnailKind(t.assetKind))}
                </figcaption>
              </figure>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderOcrTranscriptList(
  rows: ReadonlyArray<
    NonNullable<ReportViewModel["mediaIntelligence"]>["ocrTranscript"] extends
      | ReadonlyArray<infer T>
      | undefined
      ? T
      : never
  >,
): string {
  return `
    <section class="media-intelligence-card media-intelligence-ocr-transcript-card">
      <div class="media-intelligence-card-title">OCR and transcript availability</div>
      <div class="media-intelligence-card-hint">
        Availability flags are recorded as advisory provenance. The
        extracted text itself lives in the indexed search store and is
        not duplicated in this report.
      </div>
      <table class="media-intelligence-availability-table">
        <thead>
          <tr>
            <th>Material</th>
            <th>OCR</th>
            <th>OCR indexed</th>
            <th>Transcript</th>
            <th>Transcript indexed</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (r) => `
                <tr>
                  <td>
                    <span class="media-intelligence-material-label">${escapeHtml(r.materialId)}</span>
                  </td>
                  <td>${availabilityCell(r.ocrAvailable)}</td>
                  <td>${availabilityCell(r.ocrIndexed)}</td>
                  <td>${availabilityCell(r.transcriptAvailable)}</td>
                  <td>${availabilityCell(r.transcriptIndexed)}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </section>
  `;
}

// =============================================================================
// Helpers
// =============================================================================

function compareSignalsForDisplay(
  a: { severity: "INFO" | "REVIEW_RECOMMENDED" | "ATTENTION"; createdAtUtc: string },
  b: { severity: "INFO" | "REVIEW_RECOMMENDED" | "ATTENTION"; createdAtUtc: string },
): number {
  const rank: Record<typeof a.severity, number> = {
    ATTENTION: 0,
    REVIEW_RECOMMENDED: 1,
    INFO: 2,
  };
  const sevDelta = rank[a.severity] - rank[b.severity];
  if (sevDelta !== 0) return sevDelta;
  return b.createdAtUtc.localeCompare(a.createdAtUtc);
}

function severityClass(
  s: "INFO" | "REVIEW_RECOMMENDED" | "ATTENTION",
): string {
  return `media-intelligence-pill media-intelligence-pill-severity media-intelligence-pill-severity-${s.toLowerCase().replace(/_/g, "-")}`;
}

function statusClass(
  s: "PENDING" | "ACKNOWLEDGED" | "DISMISSED",
): string {
  return `media-intelligence-pill media-intelligence-pill-status media-intelligence-pill-status-${s.toLowerCase()}`;
}

function humanThumbnailKind(kind: string): string {
  switch (kind) {
    case "image_thumbnail":
      return "Image preview";
    case "video_frame":
      return "Representative video frame";
    case "audio_waveform":
      return "Audio waveform";
    case "low_res_proxy":
      return "Low-resolution proxy";
    default:
      return "Derived preview";
  }
}

function availabilityCell(value: boolean): string {
  return value
    ? `<span class="media-intelligence-pill media-intelligence-pill-availability media-intelligence-pill-availability-yes">Yes</span>`
    : `<span class="media-intelligence-pill media-intelligence-pill-availability media-intelligence-pill-availability-no">—</span>`;
}
