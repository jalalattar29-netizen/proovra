/**
 * ET-RPT-03 — the report's legal-hold line states THIS record's canonical
 * preservation hold, never the inert S3 object-lock legal-hold header.
 *
 * On a40ca76f the only legal-hold row read `storageObjectLockLegalHoldStatus`
 * (never set in production: S3_OBJECT_LOCK_LEGAL_HOLD is deliberately inert)
 * and defaulted to "OFF" — so a record under an ACTIVE legal hold printed
 * "Legal Hold: OFF".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildReportViewModel, reportLegalHoldLabel } from "../src/report-v2/build-view-model.js";
import type { ReportV2Input } from "../src/report-v2/types.js";

const FULL_HASH_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FULL_HASH_B =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";


function baseInput(): ReportV2Input {
  return {
    evidence: {
      tsaProvider: null,
      tsaUrl: null,
      tsaSerialNumber: null,
      tsaGenTimeUtc: null,
      tsaTokenBase64: null,
      tsaMessageImprint: null,
      tsaHashAlgorithm: null,
      tsaStatus: null,
      tsaFailureReason: null,
      id: "evidence-1",
      title: "Evidence Title",
      status: "SIGNED",
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      capturedAtUtc: "2026-01-01T00:00:00.000Z",
      uploadedAtUtc: "2026-01-01T00:01:00.000Z",
      signedAtUtc: "2026-01-01T00:02:00.000Z",
      reportGeneratedAtUtc: "2026-01-01T00:03:00.000Z",
      mimeType: "text/plain",
      sizeBytes: "12",
      durationSec: null,
      storageBucket: "test-bucket",
      storageKey: "evidence/evidence-1/original",
      publicUrl: null,
      gps: { lat: null, lng: null, accuracyMeters: null },
      fileSha256: FULL_HASH_A,
      fingerprintCanonicalJson: '{"a":1}',
      fingerprintHash: FULL_HASH_B,
      signatureBase64: "sig",
      signingKeyId: "proovra_ed25519",
      signingKeyVersion: 1,
      publicKeyPem:
        "-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----\n",
      contentSummary: {
        structure: "single",
        itemCount: 1,
        previewableItemCount: 1,
        downloadableItemCount: 1,
        imageCount: 0,
        videoCount: 0,
        audioCount: 0,
        documentCount: 0,
        otherCount: 0,
      },
    },
    custodyEvents: [
      {
        sequence: 1,
        atUtc: "2026-01-01T00:00:00.000Z",
        eventType: "EVIDENCE_CREATED",
        payload: { evidenceId: "evidence-1" },
        prevEventHash: null,
        eventHash:
          "1111111111111111111111111111111111111111111111111111111111111111",
        chainPosition: 1,
        chainLength: 1,
      },
    ],
    publication: null,
  } as unknown as ReportV2Input;
}

async function storageRows(input: ReportV2Input) {
  const vm = await buildReportViewModel(input);
  return Object.fromEntries(vm.storageRows.map((r) => [r.label, r.value]));
}

describe("report legal hold states the canonical record hold (ET-RPT-03)", () => {
  it("an ACTIVE evidence hold is stated, whatever the storage header says", async () => {
    const input = baseInput();
    (input.evidence as Record<string, unknown>).storageObjectLockLegalHoldStatus = null;
    const rows = await storageRows({ ...input, recordLegalHold: { state: "ACTIVE", scopes: ["EVIDENCE"] } });
    expect(rows["Legal Hold (preservation)"]).toBe("Active (held through this record)");
    expect(rows["Storage Object Lock legal hold"]).toBe("Not used");
    expect(Object.keys(rows)).not.toContain("Legal Hold");
    expect(Object.values(rows)).not.toContain("OFF");
  });

  it("case and workspace scopes, none, and an unreadable store each say what is true", () => {
    expect(reportLegalHoldLabel({ state: "ACTIVE", scopes: ["CASE", "WORKSPACE", "CASE"] })).toBe(
      "Active (held through a linked case, the workspace)",
    );
    expect(reportLegalHoldLabel({ state: "NONE", scopes: [] })).toBe("None active at report generation");
    expect(reportLegalHoldLabel({ state: "UNAVAILABLE", scopes: [] })).toBe("Could not be determined at report generation");
    expect(reportLegalHoldLabel(null)).toBe("Not evaluated for this report");
  });

  it("the finalized report path evaluates the canonical hold and passes it to the builder", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/processor.ts", import.meta.url)), "utf8");
    const call = src.indexOf("const finalizedReportPdf = await buildReportPdfV2({");
    const hold = src.lastIndexOf("const finalizedRecordLegalHold = await evaluateEffectiveLegalHold(prisma, {", call);
    expect(hold).toBeGreaterThan(0);
    // The builder call itself, up to its own closing brace — no fixed budget.
    const callBody = src.slice(call, src.indexOf("\n        });", call));
    expect(callBody).toContain("recordLegalHold: finalizedRecordLegalHold,");
    // A failed read is UNAVAILABLE, never NONE.
    expect(src.slice(hold, call)).toMatch(/return \{ state: "UNAVAILABLE" as const, scopes: \[\] \};/);
  });
});
