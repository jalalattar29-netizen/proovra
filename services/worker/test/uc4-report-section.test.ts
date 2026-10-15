/**
 * UC-4 — Report "Machine-Derived Review Materials" section (pure).
 *
 * Provenance-only: bounded counts + coverage + transformation versions. It must
 * render nothing for evidence without UC-4 (byte-stability) and must NEVER
 * contain reconstructed conversation text or OCR text (§43/§65).
 */
import { describe, it, expect } from "vitest";
import {
  renderDerivedReviewSection,
  type DerivedReviewSection,
} from "../src/report-v2/sections/derived-review.js";

const base: DerivedReviewSection = {
  coverage: "PARTIAL",
  ocrEnabled: true,
  acquisitionComplete: false,
  sourcePartCount: 2,
  keyframeCount: 12,
  observationCount: 40,
  blockCount: 8,
  transformationVersions: {
    keyframe: "video-keyframe/v1",
    ocr: "screen-ocr/v1",
    reconstruction: "screen-conversation-reconstruction/v1",
  },
  limitations: ["RECONSTRUCTION_POSSIBLE_GAP"],
  generatedAtUtc: "2026-09-18T00:00:00.000Z",
};

describe("UC-4 report section", () => {
  it("renders nothing when null (byte-stable for non-UC-4 evidence)", () => {
    expect(renderDerivedReviewSection(null)).toBe("");
  });

  it("renders nothing when there are no keyframes and no blocks", () => {
    expect(
      renderDerivedReviewSection({ ...base, keyframeCount: 0, blockCount: 0 }),
    ).toBe("");
  });

  it("renders provenance-only counts + coverage + transformation versions", () => {
    const html = renderDerivedReviewSection(base);
    expect(html).toContain("Machine-Derived Review Materials");
    expect(html).toContain("Coverage: PARTIAL");
    expect(html).toContain("Keyframes: 12");
    expect(html).toContain("Reconstructed blocks: 8");
    expect(html).toContain("video-keyframe/v1");
    expect(html).toContain("RECONSTRUCTION_POSSIBLE_GAP");
    // Honest provenance framing — derived, not acquired.
    expect(html.toLowerCase()).toContain("not acquired evidence");
    expect(html.toLowerCase()).toContain("interrupted");
  });

  it("uses claim-safe language — honest negations, no positive truth claims", () => {
    const html = renderDerivedReviewSection(base).toLowerCase();
    // Honest negations ARE present (a label is NOT a verified identity, etc.).
    expect(html).toContain("not a verified identity");
    expect(html).toContain("not a provider-verified");
    expect(html).toContain("not verified truth");
    // Forbidden positive claims must NOT appear.
    expect(html).not.toContain("authentic conversation");
    expect(html).not.toContain("tamper-proof");
    expect(html).not.toContain("legally admissible");
    // The section carries counts, not the reconstructed prose itself.
    expect(html).not.toContain("reconstructed conversation:");
  });
});

describe("UC-4 report section — OCR state is reported truthfully (UC-DER-008)", () => {
  it("an OCR runtime missing on the worker is NEVER reported as a policy decision", () => {
    const html = renderDerivedReviewSection({
      ...base,
      ocrEnabled: false,
      limitations: ["RECONSTRUCTION_OCR_RUNTIME_UNAVAILABLE"],
    });
    expect(html).not.toContain("disabled by policy");
    expect(html).toContain("OCR: engine unavailable");
  });

  it("an explicit policy decision is reported as policy", () => {
    const html = renderDerivedReviewSection({
      ...base,
      ocrEnabled: false,
      ocrStatus: "DISABLED_BY_POLICY",
      limitations: [],
    } as DerivedReviewSection);
    expect(html).toContain("OCR: disabled by workspace policy");
  });

  it("when the reason was not recorded, it claims neither", () => {
    const html = renderDerivedReviewSection({ ...base, ocrEnabled: false, limitations: [] });
    expect(html).not.toContain("disabled by");
    expect(html).toContain("OCR: not run");
  });
});

describe("UC-4 report section — the OCR OUTCOME is reported, not just 'enabled' (AUD-003)", () => {
  it("OCR that failed on every keyframe is stated with its counts, never as 'enabled' or COMPLETE", () => {
    const html = renderDerivedReviewSection({
      ...base,
      coverage: "PARTIAL",
      ocrStatus: "ENABLED",
      ocrOutcome: "ATTEMPTED_ALL_FAILED",
      ocrCounts: { keyframesAttempted: 12, keyframesSucceeded: 0, keyframesFailed: 12 },
      observationCount: 0,
      blockCount: 0,
      limitations: ["RECONSTRUCTION_OCR_EXTRACTION_FAILED", "RECONSTRUCTION_NO_OBSERVATIONS"],
    });
    expect(html).toContain("OCR: failed on every keyframe");
    expect(html).not.toContain("OCR: enabled");
    expect(html).toContain("OCR keyframes attempted: 12");
    expect(html).toContain("read: 0");
    expect(html).toContain("failed: 12");
    expect(html).not.toContain("Coverage: COMPLETE");
  });

  it("a successful read with no text, and a missing language model, are each named", () => {
    const html = renderDerivedReviewSection({
      ...base,
      ocrStatus: "ENABLED",
      ocrOutcome: "NO_TEXT_PRESENT",
      ocrCounts: { keyframesAttempted: 3, keyframesSucceeded: 3, keyframesFailed: 0 },
      ocrLanguage: "eng+ara",
      ocrLanguagesMissing: ["deu"],
    });
    expect(html).toContain("OCR: ran on every keyframe, no text recognised");
    expect(html).toContain("OCR language: eng+ara");
    expect(html).toContain("Language models not installed: deu");
  });
});
