/**
 * AUD-019 — the report's AI-intelligence summary claims no review that did
 * not happen and no speaker identification.
 *
 * The previous copy said the layer "surfaces provider suggestions to human
 * reviewers" under the title "governed by reviewer judgement", which reads as
 * though every suggestion was reviewed. Recording a provider suggestion does
 * not mean a person checked it, and a diarised speaker label is not an
 * identified person.
 */
import { describe, expect, it } from "vitest";

import {
  renderIntelligenceSummarySection,
  type IntelligenceSummarySection,
} from "../src/report-v2/sections/intelligence-summary.js";

const section: IntelligenceSummarySection = {
  document: null,
  transcript: {
    totalSegments: 12,
    totalSpeakers: 2,
    totalDurationMs: 60_000,
    perProvider: [{ provider: "provider-x", count: 12 }],
    correctionCount: 0,
  },
  confidence: null,
  correctionHistory: null,
  providers: [{ provider: "provider-x", callCount: 1, estimatedCostUsdMicros: 0 }],
};

describe("intelligence summary — conservative review and speaker claims (AUD-019)", () => {
  it("never implies that suggestions were reviewed by a person", () => {
    const html = renderIntelligenceSummarySection(section);
    expect(html).not.toMatch(/governed by reviewer judgement/i);
    expect(html).not.toMatch(/to human reviewers/i);
    expect(html).toMatch(/does not mean a person has reviewed/);
    expect(html).toMatch(/machine suggestions, not reviewed findings/);
  });

  it("states speaker counts as provider labels, not identified persons", () => {
    const html = renderIntelligenceSummarySection(section);
    expect(html).toContain("2 speaker labels");
    expect(html).toMatch(/not identified persons/);
    expect(html).not.toMatch(/\b2 speakers\b/);
  });
});
