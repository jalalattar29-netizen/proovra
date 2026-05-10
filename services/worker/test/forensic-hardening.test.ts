/**
 * Phase C #17 — worker-side forensic-semantics tests.
 */
import { describe, expect, it } from "vitest";
import {
  mapOtsStatusPublicLabel,
  mapOtsStatusPublicLabelWithTxid,
  mapTimestampStatusPublicLabel,
  mapCustodyEventLabel,
} from "../src/report-v2/normalizers.js";
import { normalizeBitcoinAnchorTone } from "../src/report-v2/truth-model.js";

describe("OTS labels (Phase B #9 / Phase C #4)", () => {
  it("never returns 'Public anchoring verified' from the base label", () => {
    for (const status of ["ANCHORED", "PENDING", "FAILED", "DISABLED", null, "UNKNOWN"]) {
      const label = mapOtsStatusPublicLabel(status as string | null);
      expect(label.toLowerCase()).not.toContain("public anchoring verified");
    }
  });

  it("only returns 'Bitcoin anchoring verified' when both ANCHORED + valid txid", () => {
    const validTxid = "f".repeat(64);
    expect(
      mapOtsStatusPublicLabelWithTxid({ status: "ANCHORED", bitcoinTxid: validTxid })
    ).toBe("Bitcoin anchoring verified");
    expect(
      mapOtsStatusPublicLabelWithTxid({ status: "ANCHORED", bitcoinTxid: null })
    ).toContain("public anchoring pending");
    expect(
      mapOtsStatusPublicLabelWithTxid({ status: "PENDING", bitcoinTxid: validTxid })
    ).toContain("pending");
  });

  it("downgrades anchor tone to warning without a valid Bitcoin txid", () => {
    const tone = normalizeBitcoinAnchorTone({
      status: "ANCHORED",
      bitcoinTxid: null,
    });
    expect(tone).toBe("warning");
  });

  it("escalates anchor tone to success when valid Bitcoin txid is recorded", () => {
    const tone = normalizeBitcoinAnchorTone({
      status: "ANCHORED",
      bitcoinTxid: "a".repeat(64),
    });
    expect(tone).toBe("success");
  });

  it("rejects malformed Bitcoin txids (not 64 hex)", () => {
    const tone = normalizeBitcoinAnchorTone({
      status: "ANCHORED",
      bitcoinTxid: "not-hex",
    });
    expect(tone).toBe("warning");
  });
});

describe("Custody event labels (Phase A/B/C wording sweep)", () => {
  it("renders new event types with their truthful labels", () => {
    expect(mapCustodyEventLabel("UPLOAD_AUTHORIZED")).toContain("authorization");
    expect(mapCustodyEventLabel("STORAGE_PROTECTION_UNAVAILABLE")).toContain(
      "Storage protection"
    );
    expect(mapCustodyEventLabel("OTS_ATTEMPT_ERROR")).toContain("attempt");
    expect(mapCustodyEventLabel("REPORT_IDENTITY_CONTEXT_RECORDED")).toContain(
      "report generation"
    );
  });

  it("re-labels legacy UPLOAD_STARTED honestly without rewriting history", () => {
    const label = mapCustodyEventLabel("UPLOAD_STARTED");
    // We do NOT say "Upload started" any more — that was the misleading
    // wording. The label now reads as an authorization signal.
    expect(label.toLowerCase()).not.toBe("upload started");
    expect(label.toLowerCase()).toContain("upload");
  });

  it("EVIDENCE_LOCKED label is gated on actual lock — wording hints retention applied", () => {
    expect(mapCustodyEventLabel("EVIDENCE_LOCKED")).toContain("Object Lock");
  });
});

describe("TSA labels (Phase A / Phase C)", () => {
  it("never claims 'verified' in TSA labels", () => {
    for (const status of ["STAMPED", "PENDING", "UNAVAILABLE", "FAILED", null]) {
      const label = mapTimestampStatusPublicLabel(status as string | null);
      expect(label.toLowerCase()).not.toContain("verified");
    }
  });
});
