/**
 * PROOVRA Phase 2 closure — Report v2 canonical consumption pin.
 *
 * The Phase 0 audit confirmed that report-v2 already imports the
 * canonical verdict + reviewer-evidence helpers from
 * `@proovra/shared`. This test source-pins that invariant so a future
 * refactor cannot silently re-introduce a duplicate derivation inside
 * report-v2.
 *
 * Phase 3 will go further (route the view-model through
 * buildCanonicalEvidenceMaterials end-to-end). For Phase 2 closure
 * the test guards the existing wiring.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("Phase 2 closure — report-v2 consumes canonical helpers from @proovra/shared", () => {
  const truthModel = readSource("../src/report-v2/truth-model.ts");
  const viewModel = readSource("../src/report-v2/build-view-model.ts");

  it("truth-model imports buildEvidenceTrustDecision from shared (no local verdict reimplementation)", () => {
    expect(truthModel).toMatch(/buildEvidenceTrustDecision/);
    expect(truthModel).toMatch(/from\s+["']@proovra\/shared["']/);
  });

  it("view-model uses the shared reviewer evidence type label (no inline category logic)", () => {
    // Either truth-model or build-view-model must import the canonical
    // reviewer-evidence helper; the inline duplicate that used to live
    // in the deleted services/worker/src/pdf/report.ts is gone.
    const importedHere = /getReviewerEvidenceTypeLabel/.test(viewModel);
    const importedNearby = /getReviewerEvidenceTypeLabel/.test(truthModel);
    expect(importedHere || importedNearby).toBe(true);
  });

  it("no inline 'Mixed Media Evidence Package' string is constructed in report-v2", () => {
    // The canonical label comes from
    // packages/shared/src/reviewer-evidence.ts:79. Report-v2 must not
    // hardcode it locally.
    expect(viewModel).not.toMatch(/"Mixed Media Evidence Package"/);
    expect(truthModel).not.toMatch(/"Mixed Media Evidence Package"/);
  });

  it("no inline trust-decision verdict string is constructed in report-v2 view-model", () => {
    // Verdict labels live in packages/shared/src/trust-decision.ts.
    // Any literal repetition here would be a Phase 0 R2 regression.
    expect(viewModel).not.toMatch(
      /"Recorded integrity verified;\s*publication pending"/,
    );
    expect(truthModel).not.toMatch(
      /"Recorded integrity verified;\s*publication pending"/,
    );
  });
});

describe("Phase 2 closure — confirmed-dead legacy v1 PDF stays deleted", () => {
  it("services/worker/src/pdf/report.ts has been deleted (zero live importers)", () => {
    let existed = true;
    try {
      readFileSync(
        fileURLToPath(new URL("../src/pdf/report.ts", import.meta.url)),
        "utf8",
      );
    } catch {
      existed = false;
    }
    expect(existed).toBe(false);
  });
});
