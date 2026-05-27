/**
 * Phase A2 — Worker PDF signing outcome, contract suite.
 *
 * Source-contract style. Asserts the bounded vocabulary the worker
 * uses + the wiring into the Report row persistence + the custody
 * event emission.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const SIGN_PDF_SRC = readSource("../src/pdf/signPdf.ts");
const BUILD_REPORT_PDF_SRC = readSource(
  "../src/report-v2/build-report-pdf.ts",
);
const PROCESSOR_SRC = readSource("../src/processor.ts");

describe("Phase A2 — worker PDF signing outcome (source contract)", () => {
  it("signPdf module exports the bounded PdfSigningOutcome union", () => {
    // SIGNED carries pdf + signedAtUtc + signerKeyId.
    expect(SIGN_PDF_SRC).toMatch(
      /status:\s*"SIGNED"[\s\S]*?signedAtUtc:\s*Date[\s\S]*?signerKeyId:/,
    );
    // UNSIGNED_OPT_OUT carries pdf + warning.
    expect(SIGN_PDF_SRC).toMatch(
      /status:\s*"UNSIGNED_OPT_OUT"[\s\S]*?warning:\s*string/,
    );
    // SIGNING_UNAVAILABLE carries pdf + warning.
    expect(SIGN_PDF_SRC).toMatch(
      /status:\s*"SIGNING_UNAVAILABLE"[\s\S]*?warning:\s*string/,
    );
  });

  it("signPdfAndProjectOutcome NEVER returns SIGNING_FAILED implicitly", () => {
    // A signing failure (P12 missing, etc.) propagates as a thrown
    // error. The function MUST NOT return an outcome with status
    // "SIGNING_FAILED" because the worker would then persist that
    // status on a Report row that has no real bytes.
    expect(SIGN_PDF_SRC).not.toMatch(
      /return\s*\{[\s\S]*?status:\s*"SIGNING_FAILED"/,
    );
  });

  it("buildReportPdfV2WithSignatureOutcome runs the production safety assertion first", () => {
    // The production safety check must precede the actual render so
    // a misconfigured production environment fails immediately
    // rather than building a PDF whose status the API cannot
    // honestly describe.
    const startIdx = BUILD_REPORT_PDF_SRC.indexOf(
      "buildReportPdfV2WithSignatureOutcome",
    );
    expect(startIdx).toBeGreaterThan(0);
    const fnBody = BUILD_REPORT_PDF_SRC.slice(startIdx, startIdx + 2000);
    const assertIdx = fnBody.indexOf(
      "assertPdfSigningProductionSafetyOrThrow",
    );
    const buildIdx = fnBody.indexOf("buildReportViewModel");
    expect(assertIdx).toBeGreaterThan(0);
    expect(buildIdx).toBeGreaterThan(0);
    expect(assertIdx).toBeLessThan(buildIdx);
  });

  it("processor imports the signature-aware builder and stores the outcome", () => {
    expect(PROCESSOR_SRC).toContain(
      "buildReportPdfV2WithSignatureOutcome",
    );
    expect(PROCESSOR_SRC).toContain("pdfSigningOutcome");
  });

  it("processor persists the four PDF artifact columns on the Report row", () => {
    expect(PROCESSOR_SRC).toMatch(
      /pdfSignatureStatus:\s*prepared\.pdfSigningOutcome\.status/,
    );
    expect(PROCESSOR_SRC).toContain("pdfSignedAtUtc:");
    expect(PROCESSOR_SRC).toContain("pdfSignerKeyId:");
    expect(PROCESSOR_SRC).toContain("pdfSigningWarning:");
  });

  it("processor appends the right custody event per outcome", () => {
    expect(PROCESSOR_SRC).toContain(
      "CustodyEventType.REPORT_PDF_SIGNED",
    );
    expect(PROCESSOR_SRC).toContain(
      "CustodyEventType.REPORT_PDF_UNSIGNED_OPT_OUT",
    );
    // The gating literal must compare against "SIGNED" — never
    // infer signed state from a truthy check.
    expect(PROCESSOR_SRC).toMatch(
      /pdfSigningOutcome\.status\s*===\s*"SIGNED"/,
    );
  });

  it("vocabulary discipline — the signing module avoids forbidden artifact phrases", () => {
    const banned = [
      /\blegally\s+admissible\b/i,
      /\btamper-?proof\b/i,
      /\bauthentic\b/i,
      /\bverified\s+report\b/i,
      /\bcourt-?ready\b/i,
      /\bcourt-?valid\b/i,
    ];
    for (const re of banned) {
      expect(SIGN_PDF_SRC).not.toMatch(re);
      expect(BUILD_REPORT_PDF_SRC).not.toMatch(re);
    }
  });
});
