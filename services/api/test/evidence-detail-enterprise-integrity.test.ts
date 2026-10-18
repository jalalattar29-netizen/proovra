import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { functionSource } from "../../../scripts/source-contract/index.mjs";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("evidence detail enterprise integrity backend contract", () => {
  const SRC = readSource("../src/routes/evidence.routes.ts");

  // (2026-10-18) The publication model is retired: the review workspace reads
  // the canonical page's ACCESS state and the record's DISCLOSURE policy — never
  // publicVerifyState.
  it("review-workspace select + safe evidence projection carry the access state and the disclosure policy", () => {
    expect(SRC).not.toMatch(/publicVerifyState/);
    expect(SRC).toMatch(/verificationAccessState: true,\s*verificationDisclosureMode: true,\s*showRecordedLocation: true,/);
    expect(SRC).toMatch(/verificationDisclosureMode:\s*e\.verificationDisclosureMode \?\? null,/);
  });

  it("defines the canonical public verification summary states (access) beside the disclosure policy", () => {
    const states = SRC.match(/type PublicVerificationDetailState =([\s\S]*?);/);
    expect(states).not.toBeNull();
    expect([...states![1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1])).toEqual([
      "NOT_INCLUDED",
      "AVAILABLE",
      "WITHDRAWN",
      "SUSPENDED",
    ]);
    // The retired publication vocabulary is gone from the summary.
    for (const retired of ["NOT_CONFIGURED", "CONFIGURED_NOT_PUBLISHED", "UNPUBLISHED", "UNKNOWN_ERROR"]) {
      expect(states![1]).not.toContain(retired);
    }
    const summaryType = SRC.match(/type ReviewWorkspacePublicVerificationSummary = \{([\s\S]*?)\n\};/);
    expect(summaryType).not.toBeNull();
    expect(summaryType![1]).toMatch(/disclosureMode: "VERIFICATION_ONLY" \| "CONTENT_PREVIEW";/);
    expect(summaryType![1]).toMatch(/showRecordedLocation: boolean;/);
    expect(summaryType![1]).not.toMatch(/publicationState|published:|configured:/);
    expect(SRC).toMatch(/function buildPublicVerificationSummary/);
    const base = functionSource(SRC, "buildPublicVerificationSummaryBase");
    expect(base).toMatch(/const policy = parseVerificationDisclosurePolicy\(params\.evidence\);/);
    expect(base).toMatch(/if \(access === "WITHDRAWN" \|\| access === "SUSPENDED"\)/);
  });

  it("buildResolvedReviewerAlerts consumes publicVerificationSummary and artifactStatus", () => {
    const slice = functionSource(SRC, "buildResolvedReviewerAlerts");
    expect(slice).toContain("function buildResolvedReviewerAlerts");
    expect(slice).toMatch(/publicVerificationSummary:/);
    expect(slice).toMatch(/artifactStatus:/);
    expect(slice).toMatch(/switch \(params\.publicVerificationSummary\.state\)/);
    expect(slice).not.toMatch(/label:\s*"No case assignment"/);
  });

  it("review-workspace response exposes canonical publicVerificationSummary + artifactStatus", () => {
    expect(SRC).toMatch(/publicVerificationSummary,/);
    expect(SRC).toMatch(/artifactStatus,/);
  });

  it("review-workspace response sources hero legalBoundary from the canonical shared material", () => {
    expect(SRC).toMatch(/legalBoundary:\s*buildCanonicalLegalBoundaryMaterial\(\)\.reportBoundary,/);
    expect(SRC).not.toContain(
      "PROOVRA verifies the recorded integrity state of evidence records and supporting technical materials. It does not independently establish factual truth, authorship, identity, legal admissibility, or evidentiary weight.",
    );
  });

  it("review-workspace preservation matrix carries the shared OTS view plus operational fields (2026-10-13)", () => {
    // Scoped to the `ots:` object inside preservationMatrix rather than a
    // fixed character window: a comment or a new sibling field must not be
    // able to push these assertions out of range.
    const matrixIdx = SRC.indexOf("preservationMatrix:");
    expect(matrixIdx).toBeGreaterThan(-1);
    const otsIdx = SRC.indexOf("ots: {", matrixIdx);
    expect(otsIdx).toBeGreaterThan(matrixIdx);
    const otsBlock = SRC.slice(otsIdx, SRC.indexOf("\n              },", otsIdx));
    // The wire contract: exactly toOtsAnchoringView(...) plus operational siblings.
    expect(otsBlock).toContain("...toOtsAnchoringView(otsAnchoring),");
    expect(otsBlock).toMatch(/proofPresent:/);
    expect(otsBlock).toMatch(/lastUpdatedAtUtc:/);
    // The retired fields are gone.
    expect(otsBlock).not.toMatch(/pendingReason:|effectiveStatus:|anchorClaim:|truthState:|anchorCheck:|chainVerification:/);
  });

  it("source context exposes client signal collection states", () => {
    const slice = functionSource(SRC, "buildSourceContext");
    expect(slice).toContain("function buildSourceContext");
    expect(SRC).toMatch(/type ClientSignalCollectionState =/);
    expect(slice).toMatch(/screenshotLikeStatus/);
    expect(slice).toMatch(/folderPathStatus/);
    expect(slice).toMatch(/clientSignalsRecorded/);
  });
});
