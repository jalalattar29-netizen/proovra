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
        <span class="redaction-chip">OCR: ${section.ocrEnabled ? "enabled" : "disabled by policy"}</span>
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
      <p class="muted small">
        Reconstruction coverage is separate from acquisition completeness — an
        interrupted capture never reconstructs as a complete conversation. The
        full source-linked review is available in the Evidence Inspector.
      </p>
    `,
  );
}
