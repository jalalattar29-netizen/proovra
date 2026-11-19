/**
 * PRO-O1-06 / PRO-O1C-04 (RG-18) — the BASIC public-verify answer states the
 * item's kind (never the exact MIME type), carries no device-declared capture
 * time, and its disclosure object describes the body actually sent.
 */
import { describe, expect, it } from "vitest";

import { projectBasicPublicVerification } from "../src/services/public-verify/public-verify-projection.js";

const disclosure = {
  mode: "CONTENT_PREVIEW",
  recordedLocation: true,
  source: "RECORD_POLICY",
  originalDownload: false,
  withheldStatement: "Not disclosed on this verification page.",
} as const;

describe("BASIC public verification projection (PRO-O1-06, PRO-O1C-04)", () => {
  it("drops the MIME type, the device time and the rich disclosure settings", () => {
    const out = projectBasicPublicVerification(
      {
        tier: "BASIC",
        recordFacts: { recordKindLabel: "Single item · application/vnd.ms-excel", identity: { disclosure: "WITHHELD" } },
        basicVerification: { original: { sha256: "a".repeat(64), deviceDeclaredCaptureAtUtc: "2026-01-01T00:00:00Z", captureTimeStatement: "x" } },
      },
      disclosure as never,
    ) as {
      recordFacts: { recordKindLabel: string };
      basicVerification: { original: { deviceDeclaredCaptureAtUtc?: string } };
      disclosure: unknown;
    };
    const body = JSON.stringify(out);
    expect(body).not.toContain("application/vnd.ms-excel");
    expect(out.recordFacts.recordKindLabel).toBe("Single item");
    expect(out.basicVerification.original.deviceDeclaredCaptureAtUtc).toBeUndefined();
    expect(out.disclosure).toMatchObject({ mode: "VERIFICATION_ONLY", recordedLocation: false });
  });
});
