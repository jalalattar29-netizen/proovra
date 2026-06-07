import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("evidence detail enterprise integrity backend contract", () => {
  const SRC = readSource("../src/routes/evidence.routes.ts");

  it("review-workspace select + safe evidence projection include publicVerifyState", () => {
    expect(SRC).toMatch(/publicVerifyState:\s*true,/);
    expect(SRC).toMatch(/publicVerifyState:\s*e\.publicVerifyState \?\? null,/);
  });

  it("defines the canonical public verification state machine", () => {
    expect(SRC).toMatch(/type PublicVerificationDetailState =/);
    for (const state of [
      "NOT_INCLUDED",
      "NOT_CONFIGURED",
      "CONFIGURED_NOT_PUBLISHED",
      "PUBLISHED",
      "SUSPENDED",
      "UNPUBLISHED",
      "UNKNOWN_ERROR",
    ]) {
      expect(SRC).toContain(state);
    }
    expect(SRC).toMatch(/function buildPublicVerificationSummary/);
  });

  it("buildResolvedReviewerAlerts consumes publicVerificationSummary and artifactStatus", () => {
    const idx = SRC.indexOf("function buildResolvedReviewerAlerts");
    expect(idx).toBeGreaterThan(-1);
    const slice = SRC.slice(idx, idx + 5000);
    expect(slice).toMatch(/publicVerificationSummary:/);
    expect(slice).toMatch(/artifactStatus:/);
    expect(slice).toMatch(/switch \(params\.publicVerificationSummary\.state\)/);
    expect(slice).not.toMatch(/label:\s*"No case assignment"/);
  });

  it("review-workspace response exposes canonical publicVerificationSummary + artifactStatus", () => {
    expect(SRC).toMatch(/publicVerificationSummary,/);
    expect(SRC).toMatch(/artifactStatus,/);
  });

  it("review-workspace preservation matrix carries OTS freshness fields", () => {
    const idx = SRC.indexOf("preservationMatrix:");
    expect(idx).toBeGreaterThan(-1);
    const slice = SRC.slice(idx, idx + 2500);
    expect(slice).toMatch(/proofPresent:/);
    expect(slice).toMatch(/lastUpdatedAtUtc:/);
    expect(slice).toMatch(/pendingReason:/);
  });

  it("source context exposes client signal collection states", () => {
    const idx = SRC.indexOf("function buildSourceContext");
    expect(idx).toBeGreaterThan(-1);
    const slice = SRC.slice(idx, idx + 4200);
    expect(SRC).toMatch(/type ClientSignalCollectionState =/);
    expect(slice).toMatch(/screenshotLikeStatus/);
    expect(slice).toMatch(/folderPathStatus/);
    expect(slice).toMatch(/clientSignalsRecorded/);
  });
});
