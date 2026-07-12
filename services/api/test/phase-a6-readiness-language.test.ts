/**
 * Phase A6 — Safe readiness terminology.
 *
 * The deterministic readiness score must never use confidence/truth language
 * and must always carry the completeness-only boundary disclaimer.
 */
import { describe, expect, it } from "vitest";

import {
  EVIDENCE_READINESS_BOUNDARY,
  buildEvidenceLibraryIntelligenceSummary,
} from "@proovra/shared";

const BANNED = /high confidence|confidence for review|authentic|admissible|truthful|reliable verdict|legally valid/i;

describe("Phase A6 — readiness language is completeness-only", () => {
  for (const score of [95, 85, 60, 30, 0, null] as const) {
    it(`score=${score}: description avoids confidence/truth language, carries boundary`, () => {
      const s = buildEvidenceLibraryIntelligenceSummary(score);
      expect(s.description).not.toMatch(BANNED);
      expect(s.boundary).toBe(EVIDENCE_READINESS_BOUNDARY);
      expect(s.boundary).toMatch(/completeness only/i);
      expect(s.boundary).toMatch(/does not assess truth/i);
    });
  }

  it("high score uses 'well prepared', not 'high confidence'", () => {
    const s = buildEvidenceLibraryIntelligenceSummary(90);
    expect(s.description).toMatch(/well prepared for review/i);
  });
});
