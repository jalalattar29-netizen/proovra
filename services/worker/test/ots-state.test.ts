import { describe, expect, it } from "vitest";
import { buildOtsEvidenceUpdateData } from "../src/ots-state.js";

const VALID_TXID =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("OTS evidence state updates", () => {
  it("preserves an existing valid txid when a later update does not provide one", () => {
    const update = buildOtsEvidenceUpdateData({
      status: "ANCHORED",
      proofBase64: "proof",
      hash: "a".repeat(64),
      calendar: "https://a.pool.opentimestamps.org",
      bitcoinTxid: null,
      existingBitcoinTxid: VALID_TXID,
      anchoredAtUtc: "2026-05-02T02:02:01.460Z",
      upgradedAtUtc: "2026-05-02T02:02:01.460Z",
    });

    expect(update.otsBitcoinTxid).toBe(VALID_TXID);
  });

  it("does not overwrite an existing valid txid during failed refreshes", () => {
    const update = buildOtsEvidenceUpdateData({
      status: "FAILED",
      proofBase64: "proof",
      hash: "a".repeat(64),
      calendar: "https://a.pool.opentimestamps.org",
      bitcoinTxid: null,
      existingBitcoinTxid: VALID_TXID,
      upgradedAtUtc: "2026-05-02T03:02:01.460Z",
      failureReason: "upgrade timed out",
    });

    expect(update.otsBitcoinTxid).toBe(VALID_TXID);
  });
});
