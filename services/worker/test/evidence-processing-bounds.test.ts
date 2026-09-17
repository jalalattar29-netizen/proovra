import { describe, it, expect, afterEach } from "vitest";

import {
  EVIDENCE_TOO_LARGE_FOR_PROCESSING,
  evidenceProcessingCeilingBytes,
  exceedsProcessingCeiling,
  sumPartBytes,
} from "../src/evidence-processing-bounds.js";

const GiB = 1024 * 1024 * 1024;

describe("worker evidence-processing size backstop", () => {
  const prev = process.env.MAX_EVIDENCE_SIZE_MB;
  afterEach(() => {
    if (prev === undefined) delete process.env.MAX_EVIDENCE_SIZE_MB;
    else process.env.MAX_EVIDENCE_SIZE_MB = prev;
  });

  it("derives the ceiling from the canonical MAX_EVIDENCE_SIZE_MB authority (default 1 GiB)", () => {
    delete process.env.MAX_EVIDENCE_SIZE_MB;
    expect(evidenceProcessingCeilingBytes()).toBe(GiB);
    process.env.MAX_EVIDENCE_SIZE_MB = "2048";
    expect(evidenceProcessingCeilingBytes()).toBe(2 * GiB);
  });

  it("passes evidence at/under the ceiling and refuses only a real overage", () => {
    const ceiling = 100;
    expect(exceedsProcessingCeiling(0, ceiling)).toBe(false);
    expect(exceedsProcessingCeiling(100, ceiling)).toBe(false);
    expect(exceedsProcessingCeiling(101, ceiling)).toBe(true);
    // Non-finite/absent totals do not trip the backstop (other guards handle those).
    expect(exceedsProcessingCeiling(Number.NaN, ceiling)).toBe(false);
  });

  it("a many-segment continuous Evidence UNDER the ceiling is processable", () => {
    // 200 segments × 4.5 MB ≈ 900 MB < 1 GiB — the streaming UC-3 default stays under.
    const parts = Array.from({ length: 200 }, () => ({ sizeBytes: 4_500_000 }));
    const total = sumPartBytes(parts);
    expect(total).toBeLessThan(GiB);
    expect(exceedsProcessingCeiling(total)).toBe(false);
  });

  it("an oversized (malformed/historical) Evidence is refused before buffering", () => {
    const parts = Array.from({ length: 400 }, () => ({ sizeBytes: 30 * 1024 * 1024 })); // ~11.7 GiB
    const total = sumPartBytes(parts);
    expect(total).toBeGreaterThan(GiB);
    expect(exceedsProcessingCeiling(total)).toBe(true);
  });

  it("sumPartBytes is bigint/number/null-safe", () => {
    expect(sumPartBytes([{ sizeBytes: 10n }, { sizeBytes: 20 }, { sizeBytes: null }, {}])).toBe(30);
  });

  it("exposes a stable operational error code", () => {
    expect(EVIDENCE_TOO_LARGE_FOR_PROCESSING).toBe("EVIDENCE_TOO_LARGE_FOR_PROCESSING");
  });
});
