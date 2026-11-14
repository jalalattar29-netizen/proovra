/**
 * F-05 / F-26b (2026-11-13) — THE PUBLISHED REPORT STATES ITS ISSUANCE FACTS.
 *
 * Defect: the processor rendered a provisional PDF with the record's
 * publication state, the certified original and the capture-manifest facts,
 * discarded its bytes, and published a SECOND render made without them — so a
 * page withdrawn at issuance still got a QR code and link, the "Certifies the
 * original" statement and the manifest facts never reached an issued PDF, and
 * the Report row's signature status described the discarded bytes.
 *
 * Executed here through the real issuance builder (view model -> HTML ->
 * Chromium -> PDF -> signing outcome), the PDF's own text read back: published
 * vs withdrawn verification, eligible vs ineligible certification. The source
 * contract pins the processor to ONE render whose outcome is what it persists.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { assertRenderedReport, extractPdfText } from "../src/output-verification.js";
import { buildReportPdfV2WithSignatureOutcome } from "../src/report-v2/build-report-pdf.js";
import { buildReportViewModel } from "../src/report-v2/build-view-model.js";
import { buildReportIssuanceRenderFacts, verificationPageOpensAtIssuance } from "../src/report-v2/issuance-render-facts.js";
import { renderReportHtml } from "../src/report-v2/render-html.js";
import { resolveBrowserExecutablePath } from "../src/report-v2/render-pdf.js";
import type { ReportV2Input } from "../src/report-v2/types.js";
import { canonicalFactsOf, layoutVariant } from "./fixtures/report-layout-variants.js";

const BROWSER = resolveBrowserExecutablePath();
if (!BROWSER && process.env.CI) throw new Error("report issuance tests need Chromium (PUPPETEER_EXECUTABLE_PATH or a system Chrome)");
const RENDER_TIMEOUT = 180_000;

const DIGEST = "3b7f0c2d9e4a61f58c0b2e7d4a9f13c6e8b5d2a7f0c94e1b6d3a8f2c5e7b9d04";
const VERSION_ID = "3HL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY";
const REREAD_AT = new Date("2026-10-01T09:20:00.000Z");

const variant = layoutVariant({ name: "issuance facts", mode: "browser_capture" });
const MANIFEST = variant.input.captureManifest ?? null;
// What the processor's published render received before the fix: no issuance facts.
const BASE: Partial<ReportV2Input> = { ...variant.input };
delete BASE.publicVerificationPublished;
delete BASE.captureManifest;
delete BASE.certifiedOriginal;
const BASE_INPUT = BASE as ReportV2Input;
const VERIFY_URL = BASE_INPUT.verifyUrl!;

function factsFor(o: { accessState: string; digest: string | null; manifest: boolean }) {
  return buildReportIssuanceRenderFacts({
    verificationAccessState: o.accessState,
    rereadMatchedDigest: o.digest,
    objectVersionIds: [VERSION_ID],
    rereadAtUtc: REREAD_AT,
    captureManifest: o.manifest ? MANIFEST : null,
  });
}

// The PDF wraps long values (the URL, the digest) across lines: both sides are
// compared with every whitespace removed.
const flat = (s: string) => s.replace(/\s+/g, "");
const squash = flat;

describe("the issuance facts (pure)", () => {
  it("only a withdrawn page loses its printed link; a temporarily unavailable one keeps it", () => {
    expect(verificationPageOpensAtIssuance("AVAILABLE")).toBe(true);
    expect(verificationPageOpensAtIssuance("TEMPORARILY_UNAVAILABLE")).toBe(true);
    expect(verificationPageOpensAtIssuance(null)).toBe(true);
    expect(verificationPageOpensAtIssuance("WITHDRAWN")).toBe(false);
  });

  it("certifies only a recorded SHA-256 the stored bytes were matched to", () => {
    expect(factsFor({ accessState: "AVAILABLE", digest: DIGEST, manifest: false }).certifiedOriginal).toEqual({
      recordedSha256: DIGEST,
      objectVersionIds: [VERSION_ID],
      rereadAtUtc: REREAD_AT.toISOString(),
    });
    for (const digest of [null, "", "not-a-digest", DIGEST.slice(1)]) {
      expect(factsFor({ accessState: "AVAILABLE", digest, manifest: false }).certifiedOriginal).toBeNull();
    }
  });
});

describe("before the fix: the published render carried none of the facts (HTML, no browser)", () => {
  it("a withdrawn record's report printed the link and no certification", async () => {
    const html = renderReportHtml(await buildReportViewModel(BASE_INPUT));
    expect(html).toContain(VERIFY_URL);
    expect(html).not.toContain("Certifies the original with SHA-256");
    expect(html).not.toContain("Reported by the capture client");
    expect(html).not.toContain('data-public-verification="withdrawn"');
  });
});

describe.skipIf(!BROWSER)("the published PDF states its issuance facts (Chromium)", () => {
  // What is under test is the rendered TEXT. Signing is a separate stage
  // (phase-a2-pdf-signing-outcome); the CI job exports PDF_SIGNING_ENABLED for
  // the stack it starts later, and the signer guard reads the database. Pin the
  // unsigned path so this file states the same facts on every machine.
  beforeAll(() => {
    vi.stubEnv("PDF_SIGNING_ENABLED", "false");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });
  it(
    "published + eligible original: QR link, certification of the exact bytes, manifest facts; the gate accepts it",
    async () => {
      const outcome = await buildReportPdfV2WithSignatureOutcome({
        ...BASE_INPUT,
        ...factsFor({ accessState: "AVAILABLE", digest: DIGEST, manifest: true }),
      });
      expect(["SIGNED", "UNSIGNED_OPT_OUT", "SIGNING_UNAVAILABLE"]).toContain(outcome.status);
      expect(outcome.pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      const text = flat(await extractPdfText(outcome.pdf));
      expect(text).toContain(squash(VERIFY_URL));
      expect(text).toContain(squash(`Certifies the original with SHA-256 ${DIGEST}`));
      expect(text).toContain(squash(VERSION_ID));
      expect(text).toContain(squash("Reported by the capture client"));
      expect(text).not.toContain(squash("Verification page withdrawn"));
      await assertRenderedReport(outcome.pdf, canonicalFactsOf(BASE_INPUT), BASE_INPUT.version, { supersedesVersion: null });
    },
    RENDER_TIMEOUT,
  );

  it(
    "a record at the 200-part maximum: the cover states the version count and the geometry gate accepts it",
    async () => {
      const facts = buildReportIssuanceRenderFacts({
        verificationAccessState: "AVAILABLE",
        rereadMatchedDigest: DIGEST,
        objectVersionIds: Array.from({ length: 200 }, (_, i) => `${VERSION_ID}-${i}`),
        rereadAtUtc: REREAD_AT,
        captureManifest: null,
      });
      const outcome = await buildReportPdfV2WithSignatureOutcome({ ...BASE_INPUT, ...facts });
      const text = flat(await extractPdfText(outcome.pdf));
      expect(text).toContain(squash(`Certifies the original with SHA-256 ${DIGEST}`));
      expect(text).toContain(squash("200 stored object versions"));
      expect(text).not.toContain(squash(`${VERSION_ID}-199`));
      await assertRenderedReport(outcome.pdf, canonicalFactsOf(BASE_INPUT), BASE_INPUT.version, { supersedesVersion: null });
    },
    RENDER_TIMEOUT,
  );

  it(
    "withdrawn at issuance: no link in the PDF text, the withdrawal stated, certification kept",
    async () => {
      const outcome = await buildReportPdfV2WithSignatureOutcome({
        ...BASE_INPUT,
        ...factsFor({ accessState: "WITHDRAWN", digest: DIGEST, manifest: false }),
      });
      const text = flat(await extractPdfText(outcome.pdf));
      expect(text).not.toContain(squash(VERIFY_URL));
      expect(text).toContain(squash("Verification page withdrawn"));
      expect(text).toContain(squash(`Certifies the original with SHA-256 ${DIGEST}`));
      expect(text).not.toContain(squash("Reported by the capture client"));
      await assertRenderedReport(outcome.pdf, canonicalFactsOf(BASE_INPUT), BASE_INPUT.version, { supersedesVersion: null });
    },
    RENDER_TIMEOUT,
  );

  it(
    "ineligible original (no matched recorded digest): no certification statement; distinct bytes from the eligible render",
    async () => {
      const ineligible = await buildReportPdfV2WithSignatureOutcome({
        ...BASE_INPUT,
        ...factsFor({ accessState: "AVAILABLE", digest: null, manifest: false }),
      });
      const text = flat(await extractPdfText(ineligible.pdf));
      expect(text).toContain(squash(VERIFY_URL));
      expect(text).not.toContain(squash("Certifies the original"));
      const eligible = await buildReportPdfV2WithSignatureOutcome({
        ...BASE_INPUT,
        ...factsFor({ accessState: "AVAILABLE", digest: DIGEST, manifest: false }),
      });
      const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
      expect(sha(eligible.pdf)).not.toBe(sha(ineligible.pdf));
      expect(flat(await extractPdfText(eligible.pdf))).toContain(squash(`Certifies the original with SHA-256 ${DIGEST}`));
    },
    RENDER_TIMEOUT,
  );
});

describe("the processor renders ONCE and persists that render's own outcome (source contract)", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/processor.ts", import.meta.url)), "utf8");

  it("exactly one PDF render call, carrying the issuance facts", () => {
    expect(src.match(/await buildReportPdfV2WithSignatureOutcome\(/g)?.length).toBe(1);
    expect(src).not.toMatch(/await buildReportPdfV2\(/);
    // The call's first spread is the issuance facts.
    expect(src).toMatch(/await buildReportPdfV2WithSignatureOutcome\(\{\s*\.\.\.prepared\.issuanceRenderFacts,/);
  });

  it("the published bytes, the Report row, the custody event and the package name the same outcome", () => {
    expect(src).toContain("const finalizedReportPdf = finalizedPdfSigningOutcome.pdf;");
    expect(src).toMatch(/pdfSignatureStatus:\s*finalizedPdfSigningOutcome\.status/);
    expect(src).not.toContain("prepared.pdfSigningOutcome");
    expect(src).toContain("reportPdfSignature: finalized.reportPdfSignature,");
    // Package-only recovery embeds the STORED report: its own row's signature facts.
    expect(src).toContain(
      "reportPdfSignature: { status: report.pdfSignatureStatus ?? null, signerKeyId: report.pdfSignerKeyId ?? null },",
    );
  });
});
