/**
 * Lane T — the native Basic Verify view says what each time and the stored
 * file are (UC-PROV-001 / UC-TRUST-005 / UC-TRUST-008).
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadWithProviders, renderComponent, React } from "./support/render.mjs";

const h = React.createElement;
let M;
const AT = "2026-09-01T00:00:00.000Z";

function data(over = {}) {
  return {
    schema: "PROOVRA_BASIC_VERIFICATION",
    version: 1,
    checkedAtUtc: AT,
    original: {
      state: "verified",
      basis: "SIGNATURE_AND_FINGERPRINT_AND_CUSTODY_CHAIN",
      checks: { fingerprintMatchesSignedHash: true, signatureValid: true, custodyChainValid: true },
      fileSha256: "a".repeat(64),
      fingerprintHash: "b".repeat(64),
      serverReceivedAtUtc: AT,
      deviceDeclaredCaptureAtUtc: null,
      capturedAtUtcDeclared: AT,
      finalizedAtUtc: AT,
    },
    timestamp: { state: "not_issued", basis: null, tokenTimeUtc: null },
    anchoring: { state: "not_issued", basis: null, anchoredAtUtc: null, bitcoinTxid: null },
    report: { issued: false, latestVersion: null, issuedAtUtc: null, digestRecorded: false, sha256: null },
    package: { issued: false, certifiesReportVersion: null, assembledAtUtc: null, sealed: false, packageSha256: null, sealKeyFingerprint: null, latestReportLacksPackage: false },
    ...over,
  };
}

before(async () => {
  M = await loadWithProviders("src/ui/basic-verification-view.tsx");
});

const view = (d) => renderComponent(h(M.TestProviders, null, h(M.BasicVerificationView, { data: d })));

test("PROV-001: the server time is 'Server received at', never 'declared by device'; no capture time is said so", async () => {
  const r = await view(data());
  assert.ok(!r.hasText("declared by device"), "server time attributed to the device");
  assert.ok(r.hasText("Server received at"));
  assert.ok(r.hasText("Capture time not available"));
});

test("TRUST-005 / 008: a failed headline and a missing stored original are stated, not a Verified badge", async () => {
  const r = await view(
    data({
      original: { ...data().original, state: "failed" },
      storedBytes: { state: "failed", checkStatus: "UNAVAILABLE", failureCode: "OBJECT_VERSION_MISSING", lastVerifiedAtUtc: null, lastCheckedAtUtc: AT, intervalDays: 30 },
      verdict: { state: "failed", storedBytesCheck: "UNAVAILABLE", label: "Integrity review required: the stored file does not match its signed digest" },
    }),
  );
  assert.ok(r.hasText("Integrity review required"));
  assert.ok(r.hasText("no longer available at its recorded version"));
  assert.ok(r.hasText("Stored file unavailable"));
});
