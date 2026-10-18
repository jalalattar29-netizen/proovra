/**
 * PUBLIC VERIFY CONVERGENCE (2026-10-18) — the native verify screen renders
 * the server's verification truth; it never re-derives it.
 *
 * Characterization (failed on 35f6c7bbb):
 *   - the package card ignored `sealCheck`: a legacy seal not bound to a
 *     published PROOVRA key read "Package Integrity Complete" (success), while
 *     the matrix on the same screen said "Not checked";
 *   - the timestamp tone read a legacy GRANTED/VERIFIED word as success, while
 *     the shared resolver says "recorded, not validated".
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./support/render.mjs";

let PV;
before(async () => {
  PV = await loadModule("src/product/public-verify.ts", []);
});

const files = {
  available: true,
  version: 2,
  generatedAtUtc: "2026-10-15T10:00:00.000Z",
  manifestPresent: true,
  signedManifestPresent: true,
  manifestDigestPresent: true,
  checksumIndexPresent: true,
  auditExportIncluded: true,
  custodyExportIncluded: true,
  accessExportIncluded: true,
};

test("a legacy seal not checked against a published key is stated as such — never 'Complete'", () => {
  const view = PV.parseVerifyPackage({
    verificationPackageIntegrity: {
      ...files,
      packageFormatVersion: 5,
      sealed: true,
      sealCheck: "NOT_CHECKED",
      sealStatement: "Sealed — seal not checked against a published PROOVRA key.",
    },
  });
  assert.equal(view.decisionLabel, "Sealed — seal not checked against a published PROOVRA key.");
  assert.notEqual(view.tone, "success");
});

test("the package card equals the matrix: VERIFIED only when the server's seal check is VERIFIED", () => {
  const verified = PV.parseVerifyPackage({
    verificationPackageIntegrity: { ...files, packageFormatVersion: 5, sealed: true, sealCheck: "VERIFIED" },
  });
  assert.equal(verified.tone, "success");
  const failed = PV.parseVerifyPackage({
    verificationPackageIntegrity: { ...files, packageFormatVersion: 5, sealed: true, sealCheck: "FAILED" },
  });
  assert.equal(failed.tone, "danger");
  const unsealed = PV.parseVerifyPackage({
    verificationPackageIntegrity: { ...files, packageFormatVersion: 4, sealed: false, sealCheck: "NOT_CHECKED" },
  });
  assert.notEqual(unsealed.tone, "success");
});

test("a legacy GRANTED timestamp word is never a success tone", () => {
  for (const word of ["GRANTED", "VERIFIED", "SUCCEEDED"]) {
    assert.notEqual(PV.verifyTimestampTone(word).tone, "success", word);
  }
});
