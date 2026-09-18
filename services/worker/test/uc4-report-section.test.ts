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
