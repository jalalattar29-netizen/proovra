import { describe, expect, it } from "vitest";
import {
  parseOtsUpgradeOutput,
  shouldTreatOtsAsAnchored,
} from "../src/ots-upgrade-output.js";

const TXID =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("OTS upgrade output parsing", () => {
  it("treats a detected bitcoin transaction as anchored when output is not pending", () => {
    const parsed = parseOtsUpgradeOutput(
      "",
      `Calendar response received. Bitcoin transaction: ${TXID}`
    );

    expect(parsed.txid).toBe(TXID);
    expect(parsed.pendingOutput).toBe(false);
    expect(shouldTreatOtsAsAnchored(parsed)).toBe(true);
  });

  it("keeps the result pending when the output still reports pending confirmations", () => {
    const parsed = parseOtsUpgradeOutput(
      "",
      `Bitcoin transaction: ${TXID}\nPending confirmation in Bitcoin blockchain`
    );

    expect(parsed.txid).toBe(TXID);
    expect(parsed.pendingOutput).toBe(true);
    expect(shouldTreatOtsAsAnchored(parsed)).toBe(false);
  });

  it("extracts txid values from txid-labelled output", () => {
    const parsed = parseOtsUpgradeOutput("", `txid ${TXID}`);

    expect(parsed.txid).toBe(TXID);
  });
});
