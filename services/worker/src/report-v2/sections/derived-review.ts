/**
 * UC-4 — Report section: Machine-Derived Review Materials.
 *
 * Bounded, provenance-only summary of the DERIVED screen-intelligence layer:
 * coverage, counts and transformation versions. It NEVER reproduces reconstructed
 * conversation text, OCR text or keyframe images — the Report distinguishes what
 * PROOVRA ACQUIRED (ORIGINAL integrity facts) from what PROOVRA DERIVED, and this
 * section is strictly the latter. Returns "" when there is no derived review, so
 * a report for evidence without UC-4 renders byte-identical to before.
 */

import { escapeHtml } from "../formatters.js";
import { renderCallout, renderPageSection } from "../ui.js";

export type DerivedReviewSection = {
  coverage: "COMPLETE" | "PARTIAL";
  ocrEnabled: boolean;
  /**
   * UC-DER-008 — WHY OCR did or did not run, when the descriptor recorded it.
   * Policy-off and engine-missing are different facts; absent, the section
   * falls back to the runtime limitation and otherwise claims neither.
   */
  ocrStatus?: "ENABLED" | "DISABLED_BY_POLICY" | "RUNTIME_UNAVAILABLE";
  acquisitionComplete: boolean;
  sourcePartCount: number;
  keyframeCount: number;
  observationCount: number;
  blockCount: number;
  transformationVersions: {
    keyframe: string;
    ocr: string;
    reconstruction: string;
  };
  limitations: ReadonlyArray<string>;
  generatedAtUtc: string;
  /**
   * UC-DER-015 — SHA-256 of the exact reconstruction descriptor bytes these
   * figures were read from; with generatedAtUtc it binds the report to one
   * descriptor across regenerations.
   */
  descriptorSha256?: string | null;
};

export function renderDerivedReviewSection(
  section: DerivedReviewSection | null,
): string {
  if (!section) return "";
  // Nothing meaningful to report — no keyframes and no reconstructed blocks.
  if (section.keyframeCount === 0 && section.blockCount === 0) return "";

  const intro = renderCallout({
    tone: "neutral",
    title: "Machine-derived review material · not acquired evidence",
    body:
      "The figures below describe DERIVED review material PROOVRA produced from " +
      "the ORIGINAL screen evidence — bounded keyframes, local machine-extracted " +
      "text (OCR), and a reconstructed reading order. They are source-linked and " +
      "regenerable. They are NOT original acquisition: a visible sender label is " +
      "not a verified identity, a displayed timestamp is not a provider-verified " +
      "time, and machine-extracted text is not verified truth. This section " +
      "reports counts and coverage only — it never reproduces the reconstructed " +
      "conversation or OCR text.",
  });

  const coverageChip =
    section.coverage === "COMPLETE"
      ? `<span class="redaction-chip">Coverage: COMPLETE</span>`
      : `<span class="redaction-chip">Coverage: PARTIAL</span>`;

  const ocrState =
    section.ocrStatus ??
    (section.ocrEnabled
      ? "ENABLED"
      : section.limitations.includes("RECONSTRUCTION_OCR_RUNTIME_UNAVAILABLE")
        ? "RUNTIME_UNAVAILABLE"
        : null);
  const ocrLabel =
    ocrState === "ENABLED"
      ? "enabled"
      : ocrState === "DISABLED_BY_POLICY"
        ? "disabled by workspace policy"
        : ocrState === "RUNTIME_UNAVAILABLE"
          ? "engine unavailable"
          : "not run";

  const limitationsBlock =
    section.limitations.length > 0
      ? `<p class="muted small">Limitations: ${section.limitations
          .map((l) => `<span class="redaction-chip">${escapeHtml(l)}</span>`)
          .join(" ")}</p>`
      : "";

  return renderPageSection(
    "Machine-Derived Review Materials",
    `
      ${intro}
      <p class="muted small">
        ${coverageChip}
        <span class="redaction-chip">OCR: ${ocrLabel}</span>
        <span class="redaction-chip">Acquisition: ${section.acquisitionComplete ? "complete" : "interrupted"}</span>
      </p>
      <p class="muted small">
        <span class="redaction-chip">Source parts: ${section.sourcePartCount}</span>
        <span class="redaction-chip">Keyframes: ${section.keyframeCount}</span>
        <span class="redaction-chip">Observations: ${section.observationCount}</span>
        <span class="redaction-chip">Reconstructed blocks: ${section.blockCount}</span>
      </p>
      <p class="muted small">
        Transformations:
        <span class="redaction-chip">${escapeHtml(section.transformationVersions.keyframe)}</span>
        <span class="redaction-chip">${escapeHtml(section.transformationVersions.ocr)}</span>
        <span class="redaction-chip">${escapeHtml(section.transformationVersions.reconstruction)}</span>
      </p>
      ${limitationsBlock}
      <p class="muted small" data-derived-review-binding>
        Reconstruction descriptor generated ${escapeHtml(section.generatedAtUtc)}${
          section.descriptorSha256
            ? ` · SHA-256 <span class="mono">${escapeHtml(section.descriptorSha256)}</span>`
            : ""
        }
      </p>
      <p class="muted small">
        Reconstruction coverage is separate from acquisition completeness — an
        interrupted capture never reconstructs as a complete conversation. The
        full source-linked review is available in the Evidence Inspector.
      </p>
    `,
  );
}
