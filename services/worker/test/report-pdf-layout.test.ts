/**
 * THE RENDERED REPORT'S PAGES (2026-10-12) — executed through the real
 * renderer: view model → HTML → Chromium → PDF, then read back by the
 * geometric release gate (pdf/report-geometry.ts) from the PDF's own bytes.
 *
 * The defect this closes: the stylesheet's `@page { margin: 0 }` overrode the
 * renderer's 12 mm footer margin, so the footer was drawn inside the content
 * area, and every section was a fixed `297mm` box with `overflow: hidden` that
 * cut whatever did not fit — a 120-event custody chain printed 27 of its rows
 * and silently dropped the rest; an updated report's supersession notice
 * pushed the verification matrix under the footer.
 *
 * Mutation proofs: putting the zero page margin back, putting a fixed hidden-
 * overflow page back, or removing a required statement each refuses the
 * report; a long manifest URL and a v2 supersession notice still pass.
 */
import { deriveCanonicalArtifactFacts, VERIFICATION_LIMITATION } from "@proovra/shared";
import { describe, expect, it } from "vitest";

import { OutputVerificationError } from "../src/output-verification-error.js";
import { assertOtsProofBinding, assertRenderedReport, extractPdfText } from "../src/output-verification.js";
import { checkReportGeometry, readReportGeometry, type PageGeometry } from "../src/pdf/report-geometry.js";
import { buildReportViewModel } from "../src/report-v2/build-view-model.js";
import { REPORT_PAGE, REPORT_PAGE_PT } from "../src/report-v2/page-geometry.js";
import { renderReportHtml } from "../src/report-v2/render-html.js";
import { REPORT_PDF_CREATOR, renderPdfFromHtml, resolveBrowserExecutablePath } from "../src/report-v2/render-pdf.js";
import { openPdf } from "../src/pdf/pdfjs-runtime.js";
import { PROVENANCE_BOUNDARY_STATEMENT, supersessionStatement } from "../src/report-v2/required-statements.js";
import { getReportCss } from "../src/report-v2/templates/report.css.js";
import type { ReportV2Input } from "../src/report-v2/types.js";
import { LAYOUT_VARIANTS, LONG_MANIFEST_URL, layoutVariant } from "./fixtures/report-layout-variants.js";

const BROWSER = resolveBrowserExecutablePath();
// CI runners carry Chrome; a CI run without one is a broken gate, not a skip.
if (!BROWSER && process.env.CI) throw new Error("report layout tests need Chromium (PUPPETEER_EXECUTABLE_PATH or a system Chrome)");
const RENDER_TIMEOUT = 180_000;

function required(input: ReportV2Input) {
  return [
    { name: "verification limitation", text: VERIFICATION_LIMITATION },
    { name: "provenance boundary", text: PROVENANCE_BOUNDARY_STATEMENT },
    ...(input.supersession ? [{ name: "supersession notice", text: supersessionStatement(input.supersession.previousVersion) }] : []),
  ];
}

async function htmlOf(input: ReportV2Input): Promise<string> {
  return renderReportHtml(await buildReportViewModel(input));
}

function factsOf(input: ReportV2Input) {
  const e = input.evidence;
  return deriveCanonicalArtifactFacts(
    { ...e, tsaTokenPresent: Boolean(e.tsaTokenBase64), otsProofPresent: Boolean(e.otsProofBase64) } as never,
    [],
  );
}

async function refusal(run: () => Promise<unknown>): Promise<OutputVerificationError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof OutputVerificationError) return err;
    throw err;
  }
  throw new Error("expected the report to be refused");
}

// ---------------------------------------------------------------------------
// The rules, on constructed pages (fast, no browser).
// ---------------------------------------------------------------------------

describe("the geometric gate's rules", () => {
  const W = REPORT_PAGE_PT.width;
  const H = REPORT_PAGE_PT.height;
  const footerBaseline = H - 16;
  const text = (str: string, x: number, baseline: number, size = 8) => ({
    str,
    x,
    right: x + str.length * size * 0.5,
    baseline,
    top: baseline - size * 0.8,
    bottom: baseline + size * 0.2,
    size,
  });
  const page = (n: number, total: number, items: PageGeometry["items"]): PageGeometry => ({
    number: n,
    width: W,
    height: H,
    items: [...items, text(`Page ${n}/${total}`, 300, footerBaseline)],
  });
  const ok = [{ name: "limitation", text: "the bounded limitation" }];
  const checks = (pages: PageGeometry[], req = ok) => checkReportGeometry(pages, { requiredStatements: req }).map((f) => f.check);

  it("a clean page passes", () => {
    expect(checks([page(1, 1, [text("the bounded limitation", 60, 100)])])).toEqual([]);
  });
  it("content in the footer zone, off the page, above the top margin or into the side margin is refused", () => {
    const zone = H - REPORT_PAGE_PT.footerZone;
    expect(checks([page(1, 1, [text("the bounded limitation", 60, 100), text("late row", 60, zone + 4)])])).toEqual(["FOOTER_ZONE"]);
    expect(checks([page(1, 1, [text("the bounded limitation", 60, 100), text("past the edge", W - 10, 300)])])).toEqual(["PAGE_BOUNDS"]);
    expect(checks([page(1, 1, [text("the bounded limitation", 60, 100), text("header", 60, 12)])])).toEqual(["PAGE_MARGIN"]);
    expect(checks([page(1, 1, [text("the bounded limitation", 60, 100), text("0123456789", W - 60, 300)])])).toEqual(["HORIZONTAL_OVERFLOW"]);
  });
  it("a page without its own footer, a blank page and an orphaned section title are refused", () => {
    const noFooter: PageGeometry = { number: 1, width: W, height: H, items: [text("the bounded limitation", 60, 100)] };
    expect(checks([noFooter])).toEqual(["PAGE_FOOTER"]);
    expect(checks([page(1, 2, [text("the bounded limitation", 60, 100)]), page(2, 2, [])])).toEqual(["BLANK_PAGE"]);
    expect(checks([page(1, 1, [text("the bounded limitation", 60, 100), text("Chain of Custody", 60, 700, 14)])])).toEqual(["ORPHANED_HEADING"]);
    // A page holding only a section kicker (letter-spaced in the PDF) and nothing else.
    expect(checks([page(1, 2, [text("the bounded limitation", 60, 100)]), page(2, 2, [text("P R O O V R A  V E R I F I C A T I O N  R E P O R T", 60, 60, 6)])])).toEqual(["ORPHANED_HEADING"]);
  });
  it("a required statement that is absent or cut is refused", () => {
    expect(checks([page(1, 1, [text("the bounded", 60, 100)])])).toEqual(["REQUIRED_STATEMENT"]);
  });
  it("the stylesheet's @page margins are THE page's, so they agree with the renderer's", () => {
    const css = getReportCss();
    expect(css).toContain(`margin: ${REPORT_PAGE.marginTopMm}mm 0 ${REPORT_PAGE.marginBottomMm}mm 0;`);
    expect(css).not.toMatch(/(?<!min-)height:\s*297mm/);
  });
});

// ---------------------------------------------------------------------------
// Every variant, through Chromium.
// ---------------------------------------------------------------------------

describe.skipIf(!BROWSER)("every layout variant renders onto usable pages", () => {
  for (const options of LAYOUT_VARIANTS) {
    it(
      options.name,
      async () => {
        const { input } = layoutVariant(options);
        const html = await htmlOf(input);
        const pdf = await renderPdfFromHtml(html);
        const findings = checkReportGeometry(await readReportGeometry(pdf), { requiredStatements: required(input) });
        expect(findings).toEqual([]);

        const text = (await extractPdfText(pdf)).replace(/\s+/g, " ");
        // No raw status codes in primary prose; caveats stated, not repeated.
        expect(text).not.toMatch(/\b(NOT_CHECKED|NOT_APPLICABLE)\b/);
        expect((text.match(/admissib/gi) ?? []).length).toBeLessThanOrEqual(4);
        // The canonical gate accepts it: the PDF's facts and its pages.
        await assertRenderedReport(Buffer.from(pdf), factsOf(input), input.version, {
          supersedesVersion: input.supersession?.previousVersion ?? null,
        });
      },
      RENDER_TIMEOUT,
    );
  }

  it(
    "a Web Upload states the provenance panel once, in the canonical words",
    async () => {
      const { input } = layoutVariant(LAYOUT_VARIANTS[0]!);
      const text = (await extractPdfText(await renderPdfFromHtml(await htmlOf(input)))).replace(/\s+/g, " ");
      for (const row of ["Method", "Observed by PROOVRA", "Reported by the submitter or capture client", "Not observed by PROOVRA", "Evidence boundary"]) {
        expect(text).toContain(row);
      }
      const sentence =
        "Files were submitted through PROOVRA Web Upload. PROOVRA observed receipt, preservation and integrity from intake onward. Creation, authorship and editing before submission were not observed.";
      expect(text.split(sentence).length - 1).toBe(1);
    },
    RENDER_TIMEOUT,
  );

  it(
    "the PDF names its renderer neutrally, never the host's user agent",
    async () => {
      const { input } = layoutVariant(LAYOUT_VARIANTS[0]!);
      const doc = await openPdf(await renderPdfFromHtml(await htmlOf(input)));
      try {
        const info = ((await doc.getMetadata()).info ?? {}) as Record<string, unknown>;
        expect(info.Creator).toBe(REPORT_PDF_CREATOR);
        expect(JSON.stringify(info)).not.toMatch(/Mozilla|HeadlessChrome|Windows NT|X11|Linux x86_64/);
      } finally {
        await doc.destroy();
      }
    },
    RENDER_TIMEOUT,
  );

  it("JOURNEY C: a proof committed to another digest is refused before rendering — whatever its recorded status, on every retry", () => {
    const { input } = layoutVariant({ name: "proof invalid", ots: "proof_invalid" });
    const facts = factsOf(input);
    expect(facts.otsDigestBinding).toBe("MISMATCH");
    for (const otsStatus of [input.evidence.otsStatus, "FAILED", "PENDING", "ANCHORED"]) {
      let err: unknown = null;
      try {
        assertOtsProofBinding(facts, { otsStatus });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(OutputVerificationError);
      expect((err as OutputVerificationError).retriable).toBe(false);
      expect((err as OutputVerificationError).findings.map((f) => f.check)).toEqual(["OTS_PROOF_DIGEST_MISMATCH"]);
    }
  });

  it("a correctly bound proof that no verifier checked is NOT refused: it publishes as Attestation recorded", () => {
    for (const ots of ["attestation_not_verified", "verification_unavailable", "pending", "chain_verified"] as const) {
      const { input } = layoutVariant({ name: ots, ots });
      const facts = factsOf(input);
      expect(facts.otsDigestBinding).toBe("MATCH");
      expect(() => assertOtsProofBinding(facts, input.evidence)).not.toThrow();
    }
  });

  it(
    "THE OTS CARD: one status and one sentence, no internal states, technical details only in the appendix",
    async () => {
      const cards = {
        pending: ["Pending", "The anchoring proof is still being prepared."],
        attestation_not_verified: ["Attestation recorded", "Independent Bitcoin verification was not performed."],
        verification_unavailable: ["Attestation recorded", "Independent verification is currently unavailable."],
        chain_verified: ["Verified", "The proof was independently verified against the Bitcoin blockchain."],
      } as const;
      for (const [ots, [status, sentence]] of Object.entries(cards)) {
        const { input } = layoutVariant({ name: ots, ots: ots as keyof typeof cards });
        const pdf = await renderPdfFromHtml(await htmlOf(input));
        const pages = await readReportGeometry(pdf);
        const pageText = pages.map((p) => p.items.map((i) => i.str).join(" ").replace(/\s+/g, " "));
        const all = pageText.join(" ");
        // The card, once: title, status, one sentence.
        expect(all, ots).toContain(`OpenTimestamps ${status} ${sentence}`);
        expect(all.split(sentence).length - 1, ots).toBe(1);
        // No internal state, raw code or legacy overclaim anywhere in the report.
        expect(all, ots).not.toMatch(/NOT_CHECKED|PROOF_STRUCTURE|BITCOIN_VERIFIED|PROOF_HASH_MISMATCH|CHAIN_VERIFI|ATTESTATION_PRESENT|Bitcoin attestation present|Anchored at|Bitcoin time|RPC/);
        // The technical material lives in the appendix only.
        const appendix = pageText.findIndex((t) => t.includes("Technical Appendix — Timestamp & Anchoring"));
        expect(appendix, ots).toBeGreaterThan(0);
        pageText.forEach((t, i) => {
          if (i === appendix) return;
          expect(t, `${ots} p${i + 1}`).not.toMatch(/Reported by the OpenTimestamps proof|BITCOIN TRANSACTION ID|BLOCK HEIGHT|CONFIRMATIONS|VERIFIED BITCOIN BLOCK|cccccccccccccccc/i);
        });
        // The gate (geometry included: nothing in the footer zone) accepts it.
        await assertRenderedReport(Buffer.from(pdf), factsOf(input), input.version, { supersedesVersion: null });
      }
    },
    RENDER_TIMEOUT * 2,
  );

  it(
    "a 120-event custody chain prints every row the HTML carries (none clipped away)",
    async () => {
      const { input } = layoutVariant(LAYOUT_VARIANTS.find((v) => v.parts === 100)!);
      const html = await htmlOf(input);
      const text = (await extractPdfText(await renderPdfFromHtml(html))).replace(/\s+/g, "");
      const hashes = input.custodyEvents.map((e) => e.eventHash!).filter((h) => html.includes(h));
      expect(hashes.length).toBeGreaterThan(100);
      expect(hashes.filter((h) => !text.includes(h))).toEqual([]);
    },
    RENDER_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Mutation proofs: the defects come back, the gate refuses them.
// ---------------------------------------------------------------------------

describe.skipIf(!BROWSER)("mutation proofs", () => {
  const long = layoutVariant(LAYOUT_VARIANTS.find((v) => v.parts === 20)!).input;
  const v2 = layoutVariant(LAYOUT_VARIANTS.find((v) => v.supersession)!).input;

  it(
    "reintroducing the zero page margin is refused",
    async () => {
      const html = (await htmlOf(long)).replace(
        `margin: ${REPORT_PAGE.marginTopMm}mm 0 ${REPORT_PAGE.marginBottomMm}mm 0;`,
        "margin: 0;",
      );
      const pdf = await renderPdfFromHtml(html);
      const err = await refusal(() =>
        assertRenderedReport(Buffer.from(pdf), factsOf(long), long.version, { supersedesVersion: null }),
      );
      expect(err.code).toBe("REPORT_OUTPUT_INCONSISTENT");
      expect(err.findings.map((f) => f.check)).toEqual(expect.arrayContaining(["PAGE_MARGIN"]));
      expect(err.findings.some((f) => f.check === "FOOTER_ZONE" || f.check === "PAGE_MARGIN")).toBe(true);
    },
    RENDER_TIMEOUT,
  );

  it(
    "reintroducing a fixed 297mm page with hidden overflow is refused before printing",
    async () => {
      const html = (await htmlOf(long)).replace(
        "</style>",
        ".report-page { height: 297mm !important; overflow: hidden !important; }</style>",
      );
      const err = await refusal(() => renderPdfFromHtml(html));
      expect(err.code).toBe("REPORT_OUTPUT_INCONSISTENT");
      expect(err.retriable).toBe(false);
      expect(err.findings.map((f) => f.check)).toContain("CLIPPED_CONTENT");
    },
    RENDER_TIMEOUT,
  );

  it(
    "removing the provenance boundary or the supersession notice is refused",
    async () => {
      const html = await htmlOf(v2);
      const withoutBoundary = html.replace(PROVENANCE_BOUNDARY_STATEMENT, "");
      const withoutNotice = html.replace(supersessionStatement(v2.supersession!.previousVersion), "This version");
      for (const [mutated, name] of [
        [withoutBoundary, "provenance boundary"],
        [withoutNotice, "supersession notice"],
      ] as const) {
        const pdf = await renderPdfFromHtml(mutated);
        const err = await refusal(() =>
          assertRenderedReport(Buffer.from(pdf), factsOf(v2), v2.version, { supersedesVersion: v2.supersession!.previousVersion }),
        );
        expect(err.findings).toEqual(
          expect.arrayContaining([expect.objectContaining({ check: "REQUIRED_STATEMENT", detail: expect.stringContaining(name) })]),
        );
      }
    },
    RENDER_TIMEOUT,
  );

  it(
    "a long manifest URL wraps inside the page and passes",
    async () => {
      const { input } = layoutVariant(LAYOUT_VARIANTS.find((v) => v.mode === "browser_capture")!);
      const pdf = await renderPdfFromHtml(await htmlOf(input));
      expect((await extractPdfText(pdf)).replace(/\s+/g, "")).toContain(LONG_MANIFEST_URL);
      expect(checkReportGeometry(await readReportGeometry(pdf), { requiredStatements: required(input) })).toEqual([]);
    },
    RENDER_TIMEOUT,
  );
});
