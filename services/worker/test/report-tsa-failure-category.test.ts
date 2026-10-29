/**
 * THE PDF TECHNICAL APPENDIX STATES A FAILED TIMESTAMP'S CATEGORY (2026-10-29).
 *
 * The timestamp section printed the status and nothing about why. A FAILED
 * request now carries one "Timestamp Outcome" row: the shared failure-category
 * sentence (tsaFailureNote) — never the provider's raw text — and no row at all
 * when nothing failed.
 */
import { TSA_FAILURE_NOTES } from "@proovra/shared";
import { describe, expect, it } from "vitest";

import { buildTimestampRows } from "../src/report-v2/technical-model.js";
import type { ReportEvidence } from "../src/report-v2/types.js";

function evidence(over: Partial<ReportEvidence>): ReportEvidence {
  return {
    tsaProvider: "LOCAL_TEST_TSA",
    tsaUrl: null,
    tsaSerialNumber: null,
    tsaGenTimeUtc: null,
    tsaTokenBase64: null,
    tsaMessageImprint: null,
    tsaInputDigestHex: "5f".repeat(32),
    tsaInputKind: "FILE_SHA256",
    tsaHashAlgorithm: "sha256",
    tsaStatus: "FAILED",
    tsaFailureReason: "Trusted timestamp request failed because the timestamp provider could not be reached.",
    tsaFailureCode: "tsa_provider_unreachable",
    ...over,
  } as ReportEvidence;
}

const outcome = (rows: ReadonlyArray<{ label: string; value: unknown }>) => rows.find((r) => r.label === "Timestamp Outcome");

describe("technical appendix — Timestamp Outcome", () => {
  it("a provider that issued no token states the NOT_ISSUED sentence", () => {
    const rows = buildTimestampRows(evidence({}), undefined, null);
    expect(outcome(rows)?.value).toBe(TSA_FAILURE_NOTES.NOT_ISSUED);
  });

  it("quota and validation failures state their own category", () => {
    expect(outcome(buildTimestampRows(evidence({ tsaFailureCode: "tsa_provider_quota_exceeded" }), undefined, null))?.value).toBe(TSA_FAILURE_NOTES.QUOTA);
    expect(outcome(buildTimestampRows(evidence({ tsaFailureCode: "tsa_token_untrusted" }), undefined, null))?.value).toBe(TSA_FAILURE_NOTES.VALIDATION_FAILED);
  });

  it("the provider's raw failure text is never printed", () => {
    const rows = buildTimestampRows(evidence({ tsaFailureCode: null, tsaFailureReason: "HTTP 403 Kontingent verbraucht <html>" }), undefined, null);
    expect(outcome(rows)?.value).toBe(TSA_FAILURE_NOTES.UNSPECIFIED);
    expect(JSON.stringify(rows)).not.toContain("Kontingent");
  });

  it("no row when nothing failed", () => {
    expect(outcome(buildTimestampRows(evidence({ tsaStatus: "STAMPED", tsaFailureCode: null, tsaFailureReason: null }), undefined, null))).toBeUndefined();
    expect(outcome(buildTimestampRows(evidence({ tsaStatus: null, tsaFailureCode: null, tsaFailureReason: null }), undefined, null))).toBeUndefined();
  });
});
