/**
 * ONE VERIFICATION TRUTH AUTHORITY (2026-10-18) — the report worker's
 * timestamp tone, mismatch callout and package README line read THE canonical
 * TSA state (packages/shared resolveTsaTrustState, carried by the trust
 * decision's trusted-timestamp signal and projected by the verification
 * matrix), never a raw stored status word:
 *
 *   - GRANTED / VERIFIED / SUCCEEDED are never a success tone (they never
 *     carried a validation: "recorded, not validated");
 *   - FAILED with a kept token and no code (or a not-performed code) is
 *     NOT_CHECKED: not a mismatch, not danger;
 *   - FAILED with a validation-failed code is FAILED/danger;
 *   - a NEW report issued after the retained-token repair states
 *     "validated from the timestamp token retained at intake";
 *   - the README states each TSA state in its own words.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TSA_RETAINED_TOKEN_STATUS_LABEL, type TrustSignal } from "@proovra/shared";

import { buildReportViewModel } from "../src/report-v2/build-view-model.js";
import { buildMismatchNarrative } from "../src/report-v2/custody-model.js";
import {
  buildTimestampCallout,
  buildTrustDecision,
  timestampStatusLabelOf,
  timestampToneOf,
  verificationStatusTone,
} from "../src/report-v2/truth-model.js";
import type { ReportEvidence } from "../src/report-v2/types.js";
import { buildReadmeTimestampLine, readmeTimestampTruth } from "../src/verification-package.js";
import { reportLifecycleFields, tsaValidatedFromRetainedToken } from "../src/output-verification.js";
import { reportInputFixture } from "./fixtures/report-v2-input.js";

const VALIDATED_AT = "2026-01-01T00:02:30.000Z";

function evidenceWith(extra: Partial<ReportEvidence>): ReportEvidence {
  return { ...reportInputFixture().evidence, ...extra } as ReportEvidence;
}

function decisionFor(extra: Partial<ReportEvidence>) {
  return buildTrustDecision({ evidence: evidenceWith(extra), custodyEvents: [] });
}

function tsaSignal(extra: Partial<ReportEvidence>): TrustSignal {
  return decisionFor(extra).signals.find((s) => s.key === "trusted_timestamp")!;
}

const KEPT_NO_CODE = { tsaStatus: "FAILED", tsaTokenBase64: "dG9rZW4=", tsaFailureCode: null };
const KEPT_NO_ANCHOR = { tsaStatus: "FAILED", tsaTokenBase64: "dG9rZW4=", tsaFailureCode: "tsa_trust_anchor_not_configured" };
const VALIDATION_FAILED = { tsaStatus: "FAILED", tsaTokenBase64: "dG9rZW4=", tsaFailureCode: "tsa_token_signature_invalid" };
const NOT_OBTAINED = { tsaStatus: "FAILED", tsaTokenBase64: null, tsaFailureReason: "connect ECONNREFUSED" };
const VALIDATED = { tsaStatus: "STAMPED", tsaTokenBase64: "dG9rZW4=", tsaValidatedAtUtc: VALIDATED_AT };
const RETAINED = { ...VALIDATED, tsaValidatedFromRetainedToken: true };

describe("the tone authority — the matrix status, never a raw word", () => {
  it("maps the five verification statuses", () => {
    expect(verificationStatusTone("VERIFIED")).toBe("success");
    expect(verificationStatusTone("FAILED")).toBe("danger");
    expect(verificationStatusTone("NOT_CHECKED")).toBe("warning");
    expect(verificationStatusTone("UNAVAILABLE")).toBe("neutral");
    expect(verificationStatusTone("NOT_APPLICABLE")).toBe("neutral");
  });

  it("the GRANTED / VERIFIED / SUCCEEDED words are never a success tone — in the callout, the technical appendix or the storage summary", async () => {
    for (const word of ["GRANTED", "VERIFIED", "SUCCEEDED"]) {
      const extra = { tsaStatus: word, tsaTokenBase64: "dG9rZW4=" };
      expect(timestampToneOf(decisionFor(extra)), word).not.toBe("success");
      const vm = await buildReportViewModel(reportInputFixture({ evidence: evidenceWith(extra) }));
      expect(vm.technicalAppendix.timestampStatusTone, word).not.toBe("success");
      expect(vm.technicalAppendix.timestampStatusTone, word).toBe("warning");
      const callout = vm.storageCallouts.find((c) => /timestamp/i.test(c.title))!;
      expect(callout.tone, word).not.toBe("success");
      expect(vm.verificationMatrix.rows.find((r) => r.key === "tsa_token")!.status, word).toBe("NOT_CHECKED");
    }
  });

  it("a validated token (STAMPED with its validation time) is the only success", () => {
    expect(timestampToneOf(decisionFor(VALIDATED))).toBe("success");
    // STAMPED without a validation time was never validated (ET-TSA-01).
    expect(timestampToneOf(decisionFor({ tsaStatus: "STAMPED", tsaTokenBase64: "dG9rZW4=" }))).toBe("warning");
  });
});

describe("FAILED with a kept token", () => {
  it("no code: NOT_CHECKED — not danger, and not a mismatch", async () => {
    const signal = tsaSignal(KEPT_NO_CODE);
    expect(signal.state).toBe("PRESENT_NOT_INDEPENDENTLY_VERIFIED");
    expect(timestampToneOf(decisionFor(KEPT_NO_CODE))).toBe("warning");

    const mismatch = buildMismatchNarrative({
      trustDecision: decisionFor(KEPT_NO_CODE),
      integrityVerified: true,
      forensicEventCount: 3,
    });
    expect(mismatch.tone).not.toBe("danger");
    expect(mismatch.body).not.toMatch(/Trusted timestamp/);

    const vm = await buildReportViewModel(reportInputFixture({ evidence: evidenceWith(KEPT_NO_CODE) }));
    expect(vm.technicalAppendix.timestampStatusTone).toBe("warning");
    expect(vm.mismatchSummary.tone).not.toBe("danger");
    expect(vm.mismatchSummary.body).not.toMatch(/Trusted timestamp/);
    expect(vm.verificationMatrix.rows.find((r) => r.key === "tsa_token")!.status).toBe("NOT_CHECKED");
  });

  it("validation-failed code: FAILED / danger, and a mismatch stated in bounded words", () => {
    const decision = decisionFor(VALIDATION_FAILED);
    expect(tsaSignal(VALIDATION_FAILED).state).toBe("FAILED");
    expect(timestampToneOf(decision)).toBe("danger");

    const mismatch = buildMismatchNarrative({ trustDecision: decision, integrityVerified: true, forensicEventCount: 3 });
    expect(mismatch.tone).toBe("danger");
    expect(mismatch.body).toContain("Trusted timestamp: Timestamp token obtained; validation failed.");
    expect(mismatch.body).not.toMatch(/tsa_[a-z_]+/);
    expect(mismatch.body).not.toMatch(/No explicit/);

    const callout = buildTimestampCallout(
      { timestampState: { tsaStatus: "FAILED", tokenPresent: true }, trustDecision: { decision } } as never,
      null,
    );
    expect(callout.title).toBe("Trusted timestamp validation failed");
    expect(callout.tone).toBe("danger");
  });
});

describe("the mismatch callout reads canonical states", () => {
  it("an OpenTimestamps failure never prints the stored free-text reason, and 'no mismatch' never sits beside a danger issue", () => {
    const decision = decisionFor({
      otsStatus: "FAILED",
      otsFailureReason: "calendar https://internal.example/x said ECONNRESET at 10.0.0.7",
    });
    const mismatch = buildMismatchNarrative({ trustDecision: decision, integrityVerified: true, forensicEventCount: 3 });
    expect(mismatch.body).not.toContain("internal.example");
    expect(mismatch.body).not.toContain("10.0.0.7");
    expect(decision.signals.find((s) => s.key === "bitcoin_anchoring")!.state).toBe("FAILED");
    expect(mismatch.body).toContain("Bitcoin anchoring: Bitcoin anchoring did not complete for this record.");
    expect(mismatch.tone).toBe("danger");
    expect(mismatch.body).not.toMatch(/No explicit/);
  });

  it("no failed layer, verified integrity and forensic events: the one success statement", () => {
    const mismatch = buildMismatchNarrative({
      trustDecision: decisionFor(VALIDATED),
      integrityVerified: true,
      forensicEventCount: 3,
    });
    expect(mismatch.tone).toBe("success");
    expect(mismatch.body).toMatch(/^No explicit/);
  });

  it("every FAILED signal is a danger issue, whatever else is stated", () => {
    const decision = decisionFor(VALIDATION_FAILED);
    const mismatch = buildMismatchNarrative({ trustDecision: decision, integrityVerified: false, forensicEventCount: 0 });
    expect(mismatch.tone).toBe("danger");
    expect(mismatch.body).not.toMatch(/No explicit/);
  });
});

describe("the retained-token repair — a NEW report states it", () => {
  const MARKED = [
    { eventType: "TIMESTAMP_FAILED", payload: { tsaFailureCode: "tsa_trust_anchor_not_configured" } },
    { eventType: "TIMESTAMP_APPLIED", payload: { repair_source: "tsa_kept_token_validated" } },
  ];

  it("reads the same custody marker the API reads", () => {
    expect(tsaValidatedFromRetainedToken(MARKED)).toBe(true);
    expect(tsaValidatedFromRetainedToken([{ eventType: "TIMESTAMP_APPLIED", payload: { tsaStatus: "STAMPED" } }])).toBe(false);
    expect(tsaValidatedFromRetainedToken([{ eventType: "OTS_APPLIED", payload: { repair_source: "tsa_kept_token_validated" } }])).toBe(false);
    expect(tsaValidatedFromRetainedToken([{ eventType: "TIMESTAMP_APPLIED", payload: null }])).toBe(false);
  });

  it("reportLifecycleFields carries the marker into the report payload", () => {
    const row = {
      tsaStatus: "STAMPED",
      tsaValidatedAtUtc: new Date(VALIDATED_AT),
      tsaTokenBase64: "dG9rZW4=",
    } as unknown as Parameters<typeof reportLifecycleFields>[0];
    expect(reportLifecycleFields(row, MARKED).tsaValidatedFromRetainedToken).toBe(true);
    expect(reportLifecycleFields(row, []).tsaValidatedFromRetainedToken).toBe(false);
  });

  it("the newly issued report model renders the retained-token label (VERIFIED, qualifier kept)", async () => {
    const signal = tsaSignal(RETAINED);
    expect(signal.state).toBe("PASSED");
    expect(signal.qualifiers).toContain("VALIDATED_FROM_RETAINED_TOKEN");

    const vm = await buildReportViewModel(reportInputFixture({ evidence: evidenceWith(RETAINED) }));
    const row = vm.verificationMatrix.rows.find((r) => r.key === "tsa_token")!;
    expect(row.status).toBe("VERIFIED");
    expect(row.statusLabel).toBe(TSA_RETAINED_TOKEN_STATUS_LABEL);
    expect(vm.technicalAppendix.timestampStatusLabel).toBe(TSA_RETAINED_TOKEN_STATUS_LABEL);
    expect(vm.technicalAppendix.timestampStatusTone).toBe("success");
    const callout = vm.storageCallouts.find((c) => /timestamp/i.test(c.title))!;
    expect(callout.title).toBe("Trusted timestamp validated from the token retained at intake");
    expect(callout.tone).toBe("success");
  });

  it("without the marker the same validated record reads plainly validated (existing reports untouched)", async () => {
    const vm = await buildReportViewModel(reportInputFixture({ evidence: evidenceWith(VALIDATED) }));
    const row = vm.verificationMatrix.rows.find((r) => r.key === "tsa_token")!;
    expect(row.status).toBe("VERIFIED");
    expect(row.statusLabel).toBeUndefined();
    expect(vm.technicalAppendix.timestampStatusLabel).toBe("RFC 3161 timestamp validated");
  });

  it("the marker never upgrades a timestamp that is not validated", () => {
    const signal = tsaSignal({ ...KEPT_NO_CODE, tsaValidatedFromRetainedToken: true });
    expect(signal.state).toBe("PRESENT_NOT_INDEPENDENTLY_VERIFIED");
    expect(signal.qualifiers ?? []).not.toContain("VALIDATED_FROM_RETAINED_TOKEN");
  });
});

describe("the report's TSA status words — the canonical signal, agreeing with the tone", () => {
  const CASES: Array<[string, Partial<ReportEvidence>, string, string]> = [
    ["validated", VALIDATED, "RFC 3161 timestamp validated", "success"],
    ["retained token", RETAINED, TSA_RETAINED_TOKEN_STATUS_LABEL, "success"],
    ["kept, no anchor", KEPT_NO_ANCHOR, "Timestamp token obtained; not validated (no trust anchor was available)", "warning"],
    ["kept, no code", KEPT_NO_CODE, "Timestamp token obtained; not validated (no trust anchor was available)", "warning"],
    ["recorded legacy word", { tsaStatus: "GRANTED", tsaTokenBase64: "dG9rZW4=" }, "Timestamp token recorded; not validated", "warning"],
    ["validation failed", VALIDATION_FAILED, "Timestamp token obtained; validation failed", "danger"],
    ["not obtained", NOT_OBTAINED, "Trusted timestamp not obtained", "neutral"],
  ];

  for (const [name, extra, label, tone] of CASES) {
    it(name, async () => {
      expect(timestampStatusLabelOf(decisionFor(extra))).toBe(label);
      const vm = await buildReportViewModel(reportInputFixture({ evidence: evidenceWith(extra) }));
      expect(vm.technicalAppendix.timestampStatusLabel).toBe(label);
      expect(vm.technicalAppendix.timestampStatusTone).toBe(tone);
      const rows = vm.technicalAppendix.timestampRows.filter((r) => r.label === "Timestamp Status");
      for (const r of rows) expect(r.value).toBe(label);
      // Every report row that names the timestamp status states the same words.
      const json = JSON.stringify(vm);
      expect(json).not.toMatch(/Trusted timestamp (recorded, not validated|not validated|not configured|pending|unavailable)\b/);
      expect(json).toContain(label);
      // The validation scope is stated only beside a validated timestamp.
      const scope = vm.technicalAppendix.timestampRows.some((r) => r.label === "Validation Scope");
      expect(scope).toBe(tone === "success");
    });
  }
});

describe("the package README timestamp line — one statement per TSA state", () => {
  const line = (extra: Partial<ReportEvidence>, hasTimestampToken: boolean) =>
    buildReadmeTimestampLine({
      hasTimestampToken,
      timestampSignal: tsaSignal(extra),
      timestampStateLabel: null,
      hasTimestampValidationRecord: false,
      evidenceFileSha256: "a".repeat(64),
    });

  it("validated", () => {
    expect(readmeTimestampTruth(tsaSignal(VALIDATED))).toBe("VALIDATED");
    const text = line(VALIDATED, true);
    expect(text).toContain("Included in this package: the RFC 3161 reply (DER) PROOVRA validated.");
    expect(text).not.toMatch(/retained at intake/);
  });

  it("validated from the token retained at intake", () => {
    expect(readmeTimestampTruth(tsaSignal(RETAINED))).toBe("VALIDATED_FROM_RETAINED_TOKEN");
    const text = line(RETAINED, true);
    expect(text).toContain("received and retained at intake, which PROOVRA validated later from that retained token");
  });

  it("token kept, not validated", () => {
    for (const extra of [KEPT_NO_CODE, KEPT_NO_ANCHOR]) {
      expect(readmeTimestampTruth(tsaSignal(extra))).toBe("TOKEN_KEPT_NOT_VALIDATED");
      const text = line(extra, false);
      expect(text).toContain("Not included in this package.");
      expect(text).toContain("received from the timestamp authority and kept, but it was not validated");
      expect(text).not.toMatch(/validating it failed/);
    }
  });

  it("validation failed — never 'did not validate it'", () => {
    expect(readmeTimestampTruth(tsaSignal(VALIDATION_FAILED))).toBe("VALIDATION_FAILED");
    const text = line(VALIDATION_FAILED, false);
    expect(text).toContain("Trusted timestamp: Timestamp token obtained; validation failed.");
    expect(text).toContain("validating it failed, so it must not be relied on as a trusted timestamp");
    expect(text).not.toMatch(/did not validate it|not validated/);
  });

  it("not obtained", () => {
    expect(readmeTimestampTruth(tsaSignal(NOT_OBTAINED))).toBe("NOT_OBTAINED");
    const text = line(NOT_OBTAINED, false);
    expect(text).toContain("Trusted timestamp: Trusted timestamp not obtained.");
    expect(text).toContain("No trusted timestamp was obtained for this record.");
    expect(text).not.toMatch(/reply was received/);
  });

  it("buildReadme states the line from the package trust decision's signal, not the raw status", () => {
    const SRC = readFileSync(fileURLToPath(new URL("../src/verification-package.ts", import.meta.url)), "utf8");
    expect(SRC).toContain('timestampSignal: packageTrustDecision.signals.find((s) => s.key === "trusted_timestamp") ?? null');
    expect(SRC).not.toContain("PROOVRA did not validate it");
    expect(SRC).not.toMatch(/timestampStatus === "FAILED"/);
  });
});
