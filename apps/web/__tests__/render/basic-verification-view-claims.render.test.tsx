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
  /** Wire-shaped: an older or unknown payload is exercised on purpose. */
  anchoring?: Record<string, unknown>;
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
    anchoring: { state: "not_issued", otsState: "NOT_REQUESTED", anchoredAtUtc: null, bitcoinTxid: null, ...over.anchoring },
    report: { issued: false, latestVersion: null, issuedAtUtc: null, digestRecorded: false },
    package: { issued: false, certifiesReportVersion: null, assembledAtUtc: null, sealed: false, latestReportLacksPackage: false },
  } as unknown as BasicVerification;
}

afterEach(() => cleanup());

/** The Bitcoin anchoring row's badge (the span carrying the aria-label). */
function otsBadge(container: HTMLElement): HTMLElement {
  const badge = container.querySelector<HTMLElement>("[data-verify-ots-state] span[aria-label]");
  if (!badge) throw new Error("no Bitcoin anchoring badge");
  return badge;
}

describe("Basic Verify — Bitcoin anchoring is the server's verification (2026-10-15)", () => {
  const CHAIN = {
    status: "VERIFIED",
    failureCode: null,
    blockHeight: 812345,
    blockHash: "f".repeat(64),
    blockTimeUtc: AT,
    confirmations: 11,
    minConfirmations: 6,
    checkedAtUtc: "2026-09-02T00:00:00.000Z",
    verifiedAtUtc: "2026-09-02T00:00:00.000Z",
    verifier: "bitcoin-core",
  };

  it("ANCHORED without a chain check renders a neutral 'Attestation recorded', not independently checked — never Verified", () => {
    const { container } = render(
      <BasicVerificationView
        data={data({
          anchoring: {
            state: "not_checked",
            otsState: "ANCHORED",
            otsVerification: "ATTESTATION_RECORDED",
            bitcoinBlockHeight: 812345,
            bitcoinTxid: "c".repeat(64),
            anchoredAtUtc: AT,
          },
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(container.querySelector("[data-verify-ots-verification='ATTESTATION_RECORDED']")).not.toBeNull();
    expect(container.querySelector("[data-verify-ots-tone='neutral']")).not.toBeNull();
    expect(otsBadge(container).textContent).toBe("Attestation recorded");
    expect(otsBadge(container).style.color).toBe("rgb(75, 85, 99)");
    expect(text).toContain("Not independently checked against Bitcoin");
    expect(text).toContain("The proof names Bitcoin block 812345; PROOVRA has not checked it against the Bitcoin main chain.");
    expect(text).toContain("Bitcoin block height: 812345");
    expect(text).toContain(`Bitcoin transaction: ${"c".repeat(64)}`);
    // The recorded time is PROOVRA's recording, never a block time.
    expect(text).toContain("Attestation recorded by PROOVRA (UTC): 2026-09-01 00:00:00 UTC");
    expect(otsBadge(container).textContent).not.toMatch(/✓|Verified/);
    expect(text).not.toMatch(/Independently verified against the Bitcoin main chain/);
  });

  it("a CHAIN_VERIFIED claim without its chain fact is read as an attestation recorded", () => {
    const { container } = render(
      <BasicVerificationView
        data={data({ anchoring: { state: "verified", otsState: "ANCHORED", otsVerification: "CHAIN_VERIFIED", bitcoinBlockHeight: 812345 } })}
      />,
    );
    expect(otsBadge(container).textContent).toBe("Attestation recorded");
    expect(container.textContent).not.toMatch(/Independently verified/);
  });

  it("CHAIN_VERIFIED renders the only green ✓ — independently verified, with height, confirmations and check time", () => {
    const { container } = render(
      <BasicVerificationView
        data={data({
          anchoring: {
            state: "verified",
            otsState: "ANCHORED",
            otsVerification: "CHAIN_VERIFIED",
            bitcoinBlockHeight: 812345,
            anchoredAtUtc: AT,
            chain: CHAIN,
          },
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(otsBadge(container).textContent).toBe("✓ Independently verified");
    expect(otsBadge(container).style.color).toBe("rgb(11, 93, 59)");
    expect(text).toMatch(/Merkle root matches Bitcoin block 812345; 11 confirmations at 2026-09-02/);
    expect(text).toContain(`Bitcoin block hash: ${"f".repeat(64)}`);
    expect(text).toContain("Confirmations: 11 (minimum 6)");
    expect(text).not.toContain("Not independently checked");
  });

  it("CHAIN_FAILED renders danger: 'Bitcoin verification failed'", () => {
    const { container } = render(
      <BasicVerificationView
        data={data({
          anchoring: {
            state: "failed",
            otsState: "ANCHORED",
            otsVerification: "CHAIN_FAILED",
            bitcoinBlockHeight: 812345,
            chain: { ...CHAIN, status: "FAILED", failureCode: "ROOT_MISMATCH", verifiedAtUtc: null },
          },
        })}
      />,
    );
    expect(otsBadge(container).textContent).toBe("Verification failed");
    expect(otsBadge(container).style.color).toBe("rgb(155, 28, 28)");
    expect(container.textContent).toContain(
      "The OpenTimestamps proof does not match the referenced block in the active Bitcoin main chain.",
    );
  });

  it("PENDING renders a neutral 'Pending' (never danger) with the calendar sentence, and no anchor facts", () => {
    const { container } = render(
      <BasicVerificationView
        data={data({
          anchoring: {
            state: "pending",
            otsState: "PENDING",
            // Facts a pending proof must never show, even if a payload carried them.
            bitcoinTxid: "c".repeat(64),
            anchoredAtUtc: AT,
          },
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(otsBadge(container).textContent).toBe("Pending");
    expect(otsBadge(container).style.color).toBe("rgb(75, 85, 99)");
    expect(text).toContain("Submitted to OpenTimestamps calendars; no Bitcoin attestation yet.");
    expect(text).not.toMatch(/Bitcoin transaction|recorded by PROOVRA/);
  });

  it("an unknown state from the server renders 'Unavailable' — never anchored", () => {
    const { container } = render(
      <BasicVerificationView
        data={data({
          anchoring: {
            state: "not_checked",
            otsState: "CHAIN_VERIFIED",
            truthState: "CHAIN_VERIFIED",
            bitcoinTxid: "c".repeat(64),
          },
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(container.querySelector("[data-verify-ots-state='UNAVAILABLE']")).not.toBeNull();
    expect(otsBadge(container).textContent).toBe("Unavailable");
    expect(text).toContain("The OpenTimestamps proof material cannot currently be read.");
    expect(text).not.toMatch(/Anchored|Bitcoin transaction|Attestation recorded/);
  });

  it("FAILED states the bounded failure label in danger tone", () => {
    const { container } = render(
      <BasicVerificationView
        data={data({ anchoring: { state: "failed", otsState: "FAILED", failureCode: "PROOF_HASH_MISMATCH" } })}
      />,
    );
    expect(otsBadge(container).textContent).toBe("Failed");
    expect(otsBadge(container).style.color).toBe("rgb(155, 28, 28)");
    expect(container.textContent).toContain("The OpenTimestamps proof does not commit to this record's evidence digest.");
  });
});

describe("Basic Verify — honest 'not checked'", () => {
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
