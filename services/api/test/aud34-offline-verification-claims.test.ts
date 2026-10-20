/**
 * AUD-34 (2026-10-20) — NO CLAIM THAT A PACKAGE PROVES EVERYTHING OFFLINE.
 *
 * A package's seal, checksums and OTS proof can be checked offline. Whether
 * the seal key is PROOVRA's — and whether it has since been revoked — cannot:
 * the key travels in the package and vouches for nothing by itself. The Trust
 * Center seed and the evidence intelligence artifact summary used to say
 * otherwise ("Offline-verifiable", "confirm every claim without contacting
 * PROOVRA", a PDF report flagged as carrying offline verification).
 *
 * The seed articles are source text written to the database by
 * ensureTrustCenterSeed; the pins read that text. The artifact summary is
 * exercised through buildEvidenceIntelligence's exported pure part.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const seed = readFileSync(new URL("../src/services/trust/trust-center.service.ts", import.meta.url), "utf8");
const intelligence = readFileSync(new URL("../src/services/evidence-intelligence.service.ts", import.meta.url), "utf8");

describe("AUD-34: offline-verification copy", () => {
  it("the Trust Center seed never claims the package proves the key binding offline", () => {
    expect(seed).not.toMatch(/without contacting PROOVRA/);
    expect(seed).not.toMatch(/Offline-verifiable\./);
    expect(seed).not.toMatch(/renders the chain offline/);
    expect(seed).not.toMatch(/Every step reproducible offline/);
    // ...and says where the key's standing IS confirmed.
    expect(seed.match(/checked against Public Verify|confirmed against Public Verify/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("the PDF report is never flagged as carrying offline verification", () => {
    const report = intelligence.slice(intelligence.indexOf("  return {\n    report: {"), intelligence.indexOf("    verificationPackage: {"));
    expect(report).toContain("offlineVerificationIncluded: false");
    expect(report).not.toContain("offlineVerificationIncluded: true");
  });
});
