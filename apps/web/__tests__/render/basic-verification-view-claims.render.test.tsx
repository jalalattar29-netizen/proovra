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
});
