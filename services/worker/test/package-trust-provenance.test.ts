/**
 * AUD-001 / AUD-015 — what the verification package states about acquisition.
 */
import { describe, expect, it } from "vitest";
import { findForbiddenCustomerClaims, resolveEvidenceAcquisition } from "@proovra/shared";

import { buildPackageAcquisitionRecord } from "../src/verification-package.js";

const CLIENT_DECLARED = [
  "PROOVRA_MOBILE_APP",
  "DIRECT_SCREEN_CAPTURE_ANDROID",
  "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
  "DIRECT_SCREEN_CAPTURE_IOS",
] as const;

describe("package acquisition record — channel authority (AUD-001)", () => {
  for (const mode of CLIENT_DECLARED) {
    it(`${mode} is the client's report, never PROOVRA's fact`, () => {
      const rec = buildPackageAcquisitionRecord({
        evidenceId: "ev-1",
        chain: null,
        acquisitionMode: mode,
        signedAtUtc: null,
        evidenceFiles: [],
      }) as { acquisition: Record<string, unknown> };
      expect(rec.acquisition.channelAuthority).toBe("CLIENT_DECLARED");
      expect(String(rec.acquisition.label)).toMatch(/^Reported by the client as /);
      expect(findForbiddenCustomerClaims(JSON.stringify(rec))).toEqual([]);
    });
  }

  it("the extension channel names its scoped credential", () => {
    const rec = buildPackageAcquisitionRecord({
      evidenceId: "ev-1",
      chain: null,
      acquisitionMode: "DIRECT_WEB_CAPTURE_EXTENSION",
      signedAtUtc: null,
      evidenceFiles: [],
    }) as { acquisition: Record<string, unknown> };
    expect(rec.acquisition.channelAuthority).toBe("EXTENSION_SCOPED_CREDENTIAL");
  });
});

describe("package acquisition record — the observation boundary (AUD-015)", () => {
  for (const mode of ["PROOVRA_WEB_UPLOAD", "SECURE_INTAKE_LINK", ...CLIENT_DECLARED, null] as const) {
    it(`${mode ?? "legacy"} carries the mode's one boundary`, () => {
      const rec = buildPackageAcquisitionRecord({
        evidenceId: "ev-1",
        chain: null,
        acquisitionMode: mode,
        signedAtUtc: null,
        evidenceFiles: [],
      }) as { acquisition: Record<string, unknown> };
      const boundary = resolveEvidenceAcquisition({ acquisitionMode: mode }).boundary;
      expect(rec.acquisition.boundary).toBe(boundary);
      expect(boundary).toMatch(/^PROOVRA proves .*integrity and custody from (?:upload|intake) onward; /);
    });
  }
});
