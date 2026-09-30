import { describe, expect, it } from "vitest";
import * as upgradeOutput from "../src/ots-upgrade-output.js";

const { parseOtsUpgradeOutput } = upgradeOutput;

const TXID =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("OTS upgrade output parsing", () => {
  // ET-OTS-05 — the parser still reports what the text says; nothing
  // promotes that text to ANCHORED any more (the heuristic is deleted).
  it("the text-only anchored heuristic no longer exists", () => {
    expect("shouldTreatOtsAsAnchored" in upgradeOutput).toBe(false);
  });

  it("reports anchored, non-pending output for a detected bitcoin transaction", () => {
    const parsed = parseOtsUpgradeOutput(
      "",
      `Calendar response received. Bitcoin transaction: ${TXID}`
    );

    expect(parsed.txid).toBe(TXID);
    expect(parsed.pendingOutput).toBe(false);
    expect(parsed.anchoredOutput).toBe(true);
  });

  it("keeps the result pending when the output still reports pending confirmations", () => {
    const parsed = parseOtsUpgradeOutput(
      "",
      `Bitcoin transaction: ${TXID}\nPending confirmation in Bitcoin blockchain`
    );

    expect(parsed.txid).toBe(TXID);
    expect(parsed.pendingOutput).toBe(true);
  });

  it("extracts txid values from txid-labelled output", () => {
    const parsed = parseOtsUpgradeOutput("", `txid ${TXID}`);

    expect(parsed.txid).toBe(TXID);
  });

  it("extracts txid values from block explorer urls", () => {
    const parsed = parseOtsUpgradeOutput(
      "",
      `Timestamp complete. Explorer: https://mempool.space/tx/${TXID}`
    );

    expect(parsed.txid).toBe(TXID);
    expect(parsed.anchoredOutput).toBe(true);
    expect(parsed.pendingOutput).toBe(false);
  });

  it("only accepts generic 64-hex values when bitcoin context is present", () => {
    const parsed = parseOtsUpgradeOutput(
      "",
      `Bitcoin anchoring completed.\nTransaction ${TXID}`
    );

    expect(parsed.txid).toBe(TXID);
  });

  it("rejects malformed transaction identifiers", () => {
    const parsed = parseOtsUpgradeOutput(
      "",
      "Bitcoin transaction: not-a-valid-txid"
    );

    expect(parsed.txid).toBeNull();
  });
});
