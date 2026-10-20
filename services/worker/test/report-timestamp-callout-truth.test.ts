/**
 * EVIDENCE-OUTPUT INCIDENT (2026-10-05) — the report's trusted-timestamp callout.
 *
 * Production finalizes with TSA enabled but no trust anchor, so every record
 * keeps a GRANTED reply it could not validate (tsaStatus FAILED, token kept,
 * tsaFailureCode tsa_trust_anchor_not_configured). The PDF said "Trusted
 * timestamp could not be obtained" — false: it was obtained, and not
 * validated. A failed validation must never read as validated either.
 *
 * (2026-10-18) The callout reads THE canonical TSA state (the trust decision's
 * trusted-timestamp signal, resolveTsaTrustState): a kept token that was not
 * validated is NOT_CHECKED — a caution (warning), never danger; only a
 * validation that ran and refused the token is FAILED/danger.
 */
import { describe, expect, it } from "vitest";

import { buildTimestampCallout, buildTrustDecision } from "../src/report-v2/truth-model.js";
import type { ReportEvidence } from "../src/report-v2/types.js";
import { reportInputFixture } from "./fixtures/report-v2-input.js";

function materials(
  tsaStatus: string | null,
  tokenPresent: boolean,
  extra: Partial<ReportEvidence> = {},
) {
  const evidence = {
    ...reportInputFixture().evidence,
    tsaStatus,
    tsaTokenBase64: tokenPresent ? "dG9rZW4=" : null,
    ...extra,
  } as ReportEvidence;
  return {
    timestampState: { tsaStatus, tokenPresent },
    trustDecision: { decision: buildTrustDecision({ evidence, custodyEvents: [] }) },
  } as never;
}

const TRUST_ANCHOR_REASON =
  "The timestamp token was received but could not be validated: no timestamp trust anchor is configured.";

describe("report timestamp callout", () => {
  it("a kept reply that was not validated says it was RECEIVED and NOT VALIDATED, with the bounded cause — a caution, not a failure", () => {
    const c = buildTimestampCallout(
      materials("FAILED", true, { tsaFailureCode: "tsa_trust_anchor_not_configured" }),
      TRUST_ANCHOR_REASON,
    );
    expect(c.title).toBe("Trusted timestamp received but not validated");
    expect(c.body).toMatch(/was received from the timestamp authority/);
    expect(c.body).toMatch(/has not been validated/);
    expect(c.body).toMatch(/No timestamp trust anchor was configured/);
    expect(`${c.title} ${c.body}`).not.toMatch(/could not be obtained/i);
    // AUD-47 (2026-10-20) — not validated (NOT_CHECKED) is neutral on every surface: a caution in words, never amber.
    expect(c.tone).toBe("neutral");
  });

  it("a failure with no reply kept still says it could not be obtained", () => {
    const c = buildTimestampCallout(materials("FAILED", false), "connect ECONNREFUSED");
    expect(c.title).toBe("Trusted timestamp could not be obtained");
    expect(c.body).toMatch(/could not be reached/);
    expect(c.tone).toBe("neutral");
  });

  it("neither failure is ever presented as a recorded/validated timestamp", () => {
    for (const tokenPresent of [true, false]) {
      const c = buildTimestampCallout(materials("FAILED", tokenPresent), TRUST_ANCHOR_REASON);
      expect(c.tone).not.toBe("success");
      expect(c.title).not.toMatch(/^Trusted timestamp validated/);
    }
    const stamped = buildTimestampCallout(
      materials("STAMPED", true, { tsaValidatedAtUtc: "2026-01-01T00:02:30.000Z" }),
      null,
    );
    expect(stamped.title).toBe("Trusted timestamp validated");
    expect(stamped.tone).toBe("success");
  });
});
