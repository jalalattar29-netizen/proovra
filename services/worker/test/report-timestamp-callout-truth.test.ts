/**
 * EVIDENCE-OUTPUT INCIDENT (2026-10-05) — the report's trusted-timestamp callout.
 *
 * Production finalizes with TSA enabled but no trust anchor, so every record
 * keeps a GRANTED reply it could not validate (tsaStatus FAILED, token kept,
 * tsaFailureCode tsa_trust_anchor_not_configured). The PDF said "Trusted
 * timestamp could not be obtained" — false: it was obtained, and not
 * validated. A failed validation must never read as validated either.
 */
import { describe, expect, it } from "vitest";

import { buildTimestampCallout } from "../src/report-v2/truth-model.js";

const materials = (tsaStatus: string | null, tokenPresent: boolean) =>
  ({ timestampState: { tsaStatus, tokenPresent } }) as never;

const TRUST_ANCHOR_REASON =
  "The timestamp token was received but could not be validated: no timestamp trust anchor is configured.";

describe("report timestamp callout", () => {
  it("a kept reply that failed validation says it was RECEIVED and NOT VALIDATED, with the bounded cause", () => {
    const c = buildTimestampCallout(materials("FAILED", true), TRUST_ANCHOR_REASON);
    expect(c.title).toBe("Trusted timestamp received but not validated");
    expect(c.body).toMatch(/was received from the timestamp authority/);
    expect(c.body).toMatch(/could not be validated/);
    expect(c.body).toMatch(/No timestamp trust anchor was configured/);
    expect(`${c.title} ${c.body}`).not.toMatch(/could not be obtained/i);
    expect(c.tone).toBe("danger");
  });

  it("a failure with no reply kept still says it could not be obtained", () => {
    const c = buildTimestampCallout(materials("FAILED", false), "connect ECONNREFUSED");
    expect(c.title).toBe("Trusted timestamp could not be obtained");
    expect(c.body).toMatch(/could not be reached/);
  });

  it("neither failure is ever presented as a recorded/validated timestamp", () => {
    for (const tokenPresent of [true, false]) {
      const c = buildTimestampCallout(materials("FAILED", tokenPresent), TRUST_ANCHOR_REASON);
      expect(c.tone).not.toBe("success");
      expect(c.title).not.toBe("Trusted timestamp recorded");
    }
    expect(buildTimestampCallout(materials("STAMPED", true), null).title).toBe("Trusted timestamp recorded");
  });
});
