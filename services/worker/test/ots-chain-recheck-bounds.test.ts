/**
 * PHASE 3 — the chain recheck schedule is bounded (2026-10-20, AUD-10 / AUD-50).
 *
 * A final VERIFIED outcome is never rechecked; a proof whose block is not in
 * the active chain backs off (1 h → 6 h → 24 h) and is given up 30 days after
 * anchoring instead of being rechecked hourly forever.
 */
import { describe, expect, it } from "vitest";

import { nextOtsChainCheckDelayMs, OTS_CHAIN_FINAL_CONFIRMATIONS, OTS_NOT_IN_ACTIVE_CHAIN_GIVE_UP_MS } from "../src/ots-state.js";

const HOUR = 60 * 60 * 1000;
const now = Date.parse("2026-10-20T12:00:00Z");
const anchored = (ageMs: number) => new Date(now - ageMs).toISOString();
const chain = (status: string, extra: Record<string, unknown> = {}) =>
  ({ status, failureCode: null, confirmations: null, ...extra }) as never;

describe("nextOtsChainCheckDelayMs", () => {
  it("a VERIFIED outcome is rechecked once for reorgs and is final at the confirmation threshold", () => {
    expect(nextOtsChainCheckDelayMs({ state: "ANCHORED", chain: chain("VERIFIED", { confirmations: 12 }) }, now)).toBe(24 * HOUR);
    expect(
      nextOtsChainCheckDelayMs({ state: "ANCHORED", chain: chain("VERIFIED", { confirmations: OTS_CHAIN_FINAL_CONFIRMATIONS }) }, now),
    ).toBeNull();
  });

  it("NOT_IN_ACTIVE_CHAIN backs off with the proof's age and is given up after 30 days", () => {
    const missing = (ageMs: number) =>
      nextOtsChainCheckDelayMs(
        { state: "ANCHORED", anchoredAtUtc: anchored(ageMs), chain: chain("FAILED", { failureCode: "NOT_IN_ACTIVE_CHAIN" }) },
        now,
      );
    expect(missing(2 * HOUR)).toBe(HOUR);
    expect(missing(2 * 24 * HOUR)).toBe(6 * HOUR);
    expect(missing(10 * 24 * HOUR)).toBe(24 * HOUR);
    expect(missing(OTS_NOT_IN_ACTIVE_CHAIN_GIVE_UP_MS)).toBeNull();
    expect(missing(OTS_NOT_IN_ACTIVE_CHAIN_GIVE_UP_MS + HOUR)).toBeNull();
  });

  it("an unavailable verifier keeps the hourly recheck (an operational condition, not a proof outcome)", () => {
    expect(
      nextOtsChainCheckDelayMs(
        { state: "ANCHORED", anchoredAtUtc: anchored(90 * 24 * HOUR), chain: chain("UNAVAILABLE", { failureCode: "BTC_RPC_UNAVAILABLE" }) },
        now,
      ),
    ).toBe(HOUR);
  });
});
