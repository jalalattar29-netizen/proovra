/**
 * BASIC VERIFY — every "not checked" names the check that was not performed
 * (2026-09-29, D9/D10).
 *
 * The view fell through to "No Bitcoin anchoring proof exists for this
 * record" for an anchored-but-unchecked record, and said the timestamp imprint
 * "matches" when it had never been compared.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { BasicVerification } from "@proovra/shared";

import BasicVerificationView from "../../app/verify/[token]/BasicVerificationView";

const AT = "2026-09-01T00:00:00.000Z";

function data(over: {
  timestamp?: Partial<BasicVerification["timestamp"]>;
  anchoring?: Partial<BasicVerification["anchoring"]>;
}): BasicVerification {
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
      capturedAtUtcDeclared: null,
      finalizedAtUtc: AT,
    },
    timestamp: { state: "not_issued", basis: null, tokenTimeUtc: null, ...over.timestamp },
    anchoring: { state: "not_issued", basis: null, anchoredAtUtc: null, bitcoinTxid: null, ...over.anchoring },
    report: { issued: false, latestVersion: null, issuedAtUtc: null, digestRecorded: false },
    package: { issued: false, certifiesReportVersion: null, assembledAtUtc: null, sealed: false, latestReportLacksPackage: false },
  } as unknown as BasicVerification;
}

afterEach(() => cleanup());

describe("Basic Verify — honest 'not checked'", () => {
  it("an anchor checked offline says the chain was not checked — never 'no proof exists'", () => {
    const { container } = render(
      <BasicVerificationView
        data={data({ anchoring: { state: "not_checked", basis: "PROOF_COMMITS_TO_RECORD_CHAIN_NOT_CHECKED", anchoredAtUtc: AT } })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/carries a Bitcoin block attestation for this record/);
    expect(text).toMatch(/Bitcoin chain itself was not checked/);
    expect(text).not.toMatch(/No Bitcoin anchoring proof exists/);
  });

  it("a historical anchor with no recorded check claims no structure or chain check", () => {
    const { container } = render(
      <BasicVerificationView
        data={data({ anchoring: { state: "not_checked", basis: "ANCHOR_RECORDED_CHECK_NOT_RECORDED", anchoredAtUtc: AT } })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/before this service recorded how anchors were checked/);
    expect(text).toMatch(/neither its structure nor the Bitcoin chain has been checked/);
    expect(text).not.toMatch(/carries a Bitcoin block attestation/);
    expect(text).not.toMatch(/No Bitcoin anchoring proof exists/);
  });

  it("a timestamp whose imprint was never stored is 'not compared', not 'matches' and not 'failed'", () => {
    const { container } = render(
      <BasicVerificationView
        data={data({ timestamp: { state: "not_checked", basis: "TOKEN_RECORDED_IMPRINT_NOT_COMPARED", tokenTimeUtc: AT } })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/could not be compared here — this is not a mismatch/);
    expect(text).not.toMatch(/imprint matches the recorded digest/);
    expect(text).not.toMatch(/did not validate/);
  });

  it("a matching imprint keeps its sentence", () => {
    const { container } = render(
      <BasicVerificationView
        data={data({ timestamp: { state: "not_checked", basis: "IMPRINT_MATCHES_TOKEN_SIGNATURE_NOT_VERIFIED", tokenTimeUtc: AT } })}
      />,
    );
    expect(container.textContent).toMatch(/imprint matches the recorded digest/);
  });

  it("ET-TSA-01: a validated token says PROOVRA validated it; a legacy token says it was not validated", () => {
    const validated = render(
      <BasicVerificationView data={data({ timestamp: { state: "verified", basis: "TOKEN_VALIDATED", tokenTimeUtc: AT } })} />,
    );
    expect(validated.container.textContent).toMatch(/PROOVRA validated the authority's signature and certificate chain/);
    cleanup();
    const legacy = render(
      <BasicVerificationView
        data={data({ timestamp: { state: "not_checked", basis: "TOKEN_RECORDED_NOT_VALIDATED", tokenTimeUtc: AT } })}
      />,
    );
    const text = legacy.container.textContent ?? "";
    expect(text).toMatch(/has not been validated since/);
    expect(text).not.toMatch(/imprint matches the recorded digest/);
    expect(text).not.toMatch(/validated the authority's signature/);
  });

  it("ET-PKG-02: a sealed package names the key fingerprint PROOVRA recorded — or says none was recorded", () => {
    const withKey = { ...data({}), package: { issued: true, certifiesReportVersion: 1, assembledAtUtc: AT, sealed: true, latestReportLacksPackage: false, packageSha256: "e".repeat(64), sealKeyFingerprint: "d".repeat(64) } } as BasicVerification;
    const a = render(<BasicVerificationView data={withKey} />);
    expect(a.container.textContent).toMatch(/fingerprint is d{64}/);
    expect(a.container.textContent).toMatch(/has SHA-256 e{64}/);
    cleanup();
    const noKey = { ...withKey, package: { ...withKey.package, packageSha256: null, sealKeyFingerprint: null } } as BasicVerification;
    const b = render(<BasicVerificationView data={noKey} />);
    expect(b.container.textContent).toMatch(/PROOVRA did not record that key for this package/);
    expect(b.container.textContent).not.toMatch(/bound by one signature/);
  });
});

describe("Lane T — capture time, stored bytes and the headline (UC-PROV-001 / UC-TRUST-005 / UC-TRUST-008)", () => {
  it("PROV-001: the server-received time is never 'declared by the capturing device'; no capture time -> 'Capture time not available'", () => {
    const d = data({});
    (d.original as Record<string, unknown>).capturedAtUtcDeclared = AT;
    (d.original as Record<string, unknown>).serverReceivedAtUtc = AT;
    (d.original as Record<string, unknown>).deviceDeclaredCaptureAtUtc = null;
    const { container } = render(<BasicVerificationView data={d} />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/declared by the capturing device/i);
    expect(text).toContain("Server received at");
    expect(text).toContain("Capture time not available");
  });

  it("TRUST-005: a failed verdict (stored original missing) is the headline, not a green 'Verified'", () => {
    const d = data({});
    (d.original as Record<string, unknown>).state = "failed";
    (d as Record<string, unknown>).storedBytes = {
      state: "failed",
      checkStatus: "UNAVAILABLE",
      failureCode: "OBJECT_VERSION_MISSING",
      lastVerifiedAtUtc: null,
      lastCheckedAtUtc: AT,
      intervalDays: 30,
    };
    (d as Record<string, unknown>).verdict = {
      state: "failed",
      storedBytesCheck: "UNAVAILABLE",
      label: "Integrity review required: the stored file does not match its signed digest",
    };
    const { container } = render(<BasicVerificationView data={d} />);
    expect(container.querySelector("[data-verify-verdict='failed']")).not.toBeNull();
    expect(container.textContent).toContain("no longer available at its recorded version");
    expect(container.querySelector("[data-verify-stored-bytes]")?.textContent).toContain("Unavailable");
  });

  it("TRUST-008: a stale passing check reads 'Stale' with its last-verified time, never 'Verified'", () => {
    const d = data({});
    (d as Record<string, unknown>).storedBytes = {
      state: "verified_stale",
      checkStatus: "STALE",
      failureCode: null,
      lastVerifiedAtUtc: "2026-09-20T10:00:00.000Z",
      lastCheckedAtUtc: "2026-09-20T10:00:00.000Z",
      intervalDays: 30,
      freshnessHours: 24,
    };
    const { container } = render(<BasicVerificationView data={d} />);
    const row = container.querySelector("[data-verify-stored-bytes]")?.textContent ?? "";
    expect(row).toContain("Stale");
    expect(row).toMatch(/last verified 2026-09-20 10:00 UTC/i);
    expect(row).not.toMatch(/\bVerified\b(?! )/);
  });
});
