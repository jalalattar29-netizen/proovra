import { describe, expect, it } from "vitest";
import { buildReportPdf } from "../src/pdf/report";

function extractText(buffer: Buffer): string {
  const latin1 = buffer.toString("latin1");
  const utf8 = buffer.toString("utf8");
  const ascii = buffer.toString("ascii");
  return `${latin1}\n${utf8}\n${ascii}`;
}

function expectInOrder(text: string, tokens: string[]) {
  let lastIndex = -1;
  for (const token of tokens) {
    const next = text.indexOf(token);
    expect(next).toBeGreaterThan(lastIndex);
    lastIndex = next;
  }
}

describe("report pdf builder", () => {
  it("builds a non-empty PDF buffer", async () => {
    const buffer = await buildReportPdf({
      evidence: {
        id: "evidence-1",
        status: "SIGNED",
        capturedAtUtc: "2026-01-01T00:00:00.000Z",
        uploadedAtUtc: "2026-01-01T00:01:00.000Z",
        signedAtUtc: "2026-01-01T00:02:00.000Z",
        reportGeneratedAtUtc: "2026-01-01T00:03:00.000Z",
        mimeType: "text/plain",
        sizeBytes: "12",
        durationSec: null,
        storageBucket: "dw-evidence",
        storageKey: "evidence/evidence-1/original",
        publicUrl: null,
        gps: { lat: null, lng: null, accuracyMeters: null },
        fileSha256: "abc",
        fingerprintCanonicalJson: "{\"a\":1}",
        fingerprintHash: "def",
        signatureBase64: "sig",
        signingKeyId: "dw_ed25519",
        signingKeyVersion: 1,
        publicKeyPem:
          "-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----\n",
      },
      custodyEvents: [
        {
          sequence: 1,
          atUtc: "2026-01-01T00:00:00.000Z",
          eventType: "EVIDENCE_CREATED",
          payloadSummary: "{\"type\":\"PHOTO\"}",
        },
      ],
      version: 1,
      generatedAtUtc: "2026-01-01T00:03:00.000Z",
    });

    // Basic sanity checks
    expect(buffer.length).toBeGreaterThan(1000);

    // PDF header should be present at the beginning
    const header = buffer.subarray(0, 16).toString("ascii");
    expect(header.startsWith("%PDF-")).toBe(true);

    // PDF trailer marker should exist somewhere near the end
    const tail = buffer.subarray(Math.max(0, buffer.length - 2048));
    expect(tail.toString("ascii")).toContain("%%EOF");
  });

  it("includes key sections in order", async () => {
    const buffer = await buildReportPdf({
      evidence: {
        id: "evidence-2",
        status: "SIGNED",
        capturedAtUtc: "2026-01-01T00:00:00.000Z",
        uploadedAtUtc: "2026-01-01T00:01:00.000Z",
        signedAtUtc: "2026-01-01T00:02:00.000Z",
        reportGeneratedAtUtc: "2026-01-01T00:03:00.000Z",
        mimeType: "text/plain",
        sizeBytes: "12",
        durationSec: "0",
        storageBucket: "dw-evidence",
        storageKey: "evidence/evidence-2/original",
        publicUrl: "http://example.com/evidence-2",
        gps: { lat: "1.0", lng: "2.0", accuracyMeters: "3.0" },
        fileSha256: "abc",
        fingerprintCanonicalJson: "{\"a\":1,\"b\":2}",
        fingerprintHash: "def",
        signatureBase64: "sig",
        signingKeyId: "dw_ed25519",
        signingKeyVersion: 1,
        publicKeyPem:
          "-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----\n",
      },
      custodyEvents: [
        {
          sequence: 1,
          atUtc: "2026-01-01T00:00:00.000Z",
          eventType: "EVIDENCE_CREATED",
          payloadSummary: "{\"type\":\"PHOTO\"}",
        },
      ],
      version: 1,
      generatedAtUtc: "2026-01-01T00:03:00.000Z",
      buildInfo: "build-123",
    });

    const text = extractText(buffer);
    expect(text).toContain("DW_SECTION_ORDER:");
    expectInOrder(text, [
      "Evidence Summary",
      "Cryptographic Details",
      "Chain of Custody",
      "Appendix A",
      "Appendix B",
      "Report Footer",
    ]);

    expect(text).toContain("DW_REPORT_VERSION=1");
    expect(text).toContain("DW_GENERATED_AT=2026-01-01T00:03:00.000Z");
    expect(text).toContain("DW_BUILD=build-123");
  });
});
