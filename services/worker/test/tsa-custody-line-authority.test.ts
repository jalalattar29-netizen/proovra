/**
 * AUD-15 (2026-10-20) — THE REPORT'S TSA CUSTODY LINES READ THE ONE AUTHORITY.
 *
 * Characterization (before): any SIGNATURE_APPLIED / TIMESTAMP_APPLIED event
 * whose payload said STAMPED printed "Timestamp: validated" / "Token
 * validated" — including legacy events written before PROOVRA validated
 * tokens (no tsaValidatedAtUtc). The event's own validation fact now decides,
 * through tsaProofStatusOfCustodyPayload, and an outage is never "failed".
 */
import { describe, expect, it } from "vitest";

import { summarizePayloadForReport } from "../src/processor.js";

const TOKEN = { tsaSerialNumber: "0x4f1a", tsaMessageImprint: "ab".repeat(32), tsaGenTimeUtc: "2026-10-01T09:15:04.000Z", tsaProvider: "Example TSA" };

describe("TSA custody lines (AUD-15)", () => {
  it("a legacy STAMPED event without a validation time is never 'validated'", () => {
    const sig = summarizePayloadForReport("SIGNATURE_APPLIED", { signingKeyId: "k", signingKeyVersion: 1, tsaStatus: "STAMPED", ...TOKEN });
    expect(sig).toContain("Timestamp: Recorded, not validated");
    expect(sig).not.toMatch(/Timestamp: validated/);
    const ts = summarizePayloadForReport("TIMESTAMP_APPLIED", { tsaStatus: "STAMPED", ...TOKEN });
    expect(ts).toContain("Timestamp token received; not validated");
    expect(ts).not.toMatch(/Token validated|applied and validated/);
  });

  it("a STAMPED event carrying its validation time is validated", () => {
    const ts = summarizePayloadForReport("TIMESTAMP_APPLIED", { tsaStatus: "STAMPED", tsaValidatedAtUtc: "2026-10-01T09:15:05.000Z", ...TOKEN });
    expect(ts).toContain("Trusted timestamp applied and validated");
    const sig = summarizePayloadForReport("SIGNATURE_APPLIED", { tsaStatus: "STAMPED", tsaValidatedAtUtc: "2026-10-01T09:15:05.000Z", ...TOKEN });
    expect(sig).toContain("Timestamp: RFC 3161 timestamp validated");
  });

  it("a provider outage reads 'not obtained', a refused token 'validation failed'", () => {
    expect(summarizePayloadForReport("SIGNATURE_APPLIED", { tsaStatus: "FAILED", tsaFailureCode: "tsa_provider_unreachable" })).toContain("Timestamp: Not obtained");
    expect(
      summarizePayloadForReport("SIGNATURE_APPLIED", { tsaStatus: "FAILED", tsaFailureCode: "tsa_message_imprint_mismatch", ...TOKEN }),
    ).toContain("Timestamp: Validation failed");
  });
});
