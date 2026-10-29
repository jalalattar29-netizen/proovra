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
import { VERIFICATION_LIMITATION } from "@proovra/shared";
import { describe, expect, it } from "vitest";

import { OutputVerificationError } from "../src/output-verification-error.js";
import { assertOtsProofBinding, assertRenderedReport, extractPdfText } from "../src/output-verification.js";
import { checkReportGeometry, readReportGeometry, type PageGeometry } from "../src/pdf/report-geometry.js";
import { buildReportViewModel } from "../src/report-v2/build-view-model.js";
import { REPORT_PAGE, REPORT_PAGE_PT } from "../src/report-v2/page-geometry.js";
import { renderReportHtml } from "../src/report-v2/render-html.js";
import { REPORT_PDF_CREATOR, renderPdfFromHtml, resolveBrowserExecutablePath } from "../src/report-v2/render-pdf.js";
import { openPdf } from "../src/pdf/pdfjs-runtime.js";
import { supersessionStatement } from "../src/report-v2/required-statements.js";
import { getReportCss } from "../src/report-v2/templates/report.css.js";
import type { ReportV2Input } from "../src/report-v2/types.js";
import { canonicalFactsOf, LAYOUT_VARIANTS, LONG_MANIFEST_URL, layoutVariant, regressionRecordInput } from "./fixtures/report-layout-variants.js";

const BROWSER = resolveBrowserExecutablePath();
// CI runners carry Chrome; a CI run without one is a broken gate, not a skip.
if (!BROWSER && process.env.CI) throw new Error("report layout tests need Chromium (PUPPETEER_EXECUTABLE_PATH or a system Chrome)");
const RENDER_TIMEOUT = 180_000;
// A cold Chrome on a loaded CI runner can take longer than Puppeteer's 30 s to
// print its endpoint (seen twice on the full worker suite). The headroom is
// for the launch only; every render and validation timeout is unchanged.
const LAUNCH_TIMEOUT_MS = 90_000;
const renderPdf = (html: string) => renderPdfFromHtml(html, { launchTimeoutMs: LAUNCH_TIMEOUT_MS });

function required(input: ReportV2Input) {
  return [
    { name: "verification limitation", text: VERIFICATION_LIMITATION },
    ...(input.supersession ? [{ name: "supersession notice", text: supersessionStatement(input.supersession.previousVersion) }] : []),
  ];
}

async function htmlOf(input: ReportV2Input): Promise<string> {
  return renderReportHtml(await buildReportViewModel(input));
}

const factsOf = canonicalFactsOf;

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
        const pdf = await renderPdf(html);
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
    "a Web Upload prints no observation-boundary sentence and no provenance essay (2026-10-14)",
    async () => {
      const { input } = layoutVariant(LAYOUT_VARIANTS[0]!);
      const text = (await extractPdfText(await renderPdf(await htmlOf(input)))).replace(/\s+/g, " ");
      const sentence = "PROOVRA observed the files from upload onward; creation and editing before upload were not observed.";
      expect(text).not.toContain(sentence);
      expect(text).not.toMatch(/How this record entered PROOVRA|Observed by PROOVRA|Not observed by PROOVRA|Pre-PROOVRA provenance/);
    },
    RENDER_TIMEOUT,
  );

  it(
    "the PDF names its renderer neutrally, never the host's user agent — under full Chrome and chrome-headless-shell alike",
    async () => {
      // Whichever Chromium the run resolved (full Chrome writes its user agent
      // as /Creator, chrome-headless-shell writes "Chromium", both write
      // "Skia/PDF m<N>" as /Producer), the report states one renderer name.
      const { input } = layoutVariant(LAYOUT_VARIANTS[0]!);
      const pdf = await renderPdf(await htmlOf(input));
      const browserIdentity = /Mozilla|HeadlessChrome|Chrom(e|ium)|Skia|Windows NT|Macintosh|X11|Linux/;
      // Not even the superseded value survives in the bytes (one revision).
      expect(pdf.toString("latin1")).not.toMatch(/\/(Creator|Producer)\s*\((?!PROOVRA)/);
      const doc = await openPdf(pdf);
      try {
        const info = ((await doc.getMetadata()).info ?? {}) as Record<string, unknown>;
        expect(info.Creator).toBe(REPORT_PDF_CREATOR);
        expect(info.Producer).toBe(REPORT_PDF_CREATOR);
        expect(JSON.stringify(info)).not.toMatch(browserIdentity);
      } finally {
        await doc.destroy();
      }
    },
    RENDER_TIMEOUT,
  );

  it("JOURNEY C: a proof committed to another digest is refused before rendering — whatever its recorded status, on every retry", () => {
    const { input } = layoutVariant({ name: "proof invalid", ots: "proof_invalid" });
    const facts = factsOf(input);
    expect(facts.otsState).toBe("FAILED");
    expect(facts.otsFailureCode).toBe("PROOF_HASH_MISMATCH");
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

  it("pending, anchored, budget-failed and unavailable proofs are NOT refused", () => {
    for (const ots of ["pending", "anchored", "anchored_no_txid", "budget_failed", "unavailable"] as const) {
      const { input } = layoutVariant({ name: ots, ots });
      expect(() => assertOtsProofBinding(factsOf(input), input.evidence), ots).not.toThrow();
    }
  });

  it(
    "THE OTS CARD: one status and one sentence per state, no internal states, technical details only in the appendix",
    async () => {
      // 2026-10-15: the card states the canonical VERIFICATION. An upgraded
      // proof not checked against the chain is "Attestation recorded" — no ✓.
      const cards = {
        pending: ["Pending", "OpenTimestamps proof pending", "Submitted to OpenTimestamps calendars; no Bitcoin attestation yet."],
        anchored: ["Attestation recorded", "Bitcoin attestation recorded", "The proof names Bitcoin block 860000; PROOVRA has not checked it against the Bitcoin main chain."],
        budget_failed: ["Failed", "Bitcoin anchoring failed", "Bitcoin anchoring did not complete for this record."],
        // AUD-48 (2026-10-20) — the PDF is a snapshot: stated as of issue, never "currently".
        unavailable: ["Unavailable", "Bitcoin anchoring proof could not be read when this report was issued", "The OpenTimestamps proof material could not be read when this report was issued."],
      } as const;
      for (const [ots, [status, title, sentence]] of Object.entries(cards)) {
        const { input } = layoutVariant({ name: ots, ots: ots as keyof typeof cards });
        const pdf = await renderPdf(await htmlOf(input));
        const pages = await readReportGeometry(pdf);
        const pageText = pages.map((p) => p.items.map((i) => i.str).join(" ").replace(/\s+/g, " "));
        const all = pageText.join(" ");
        // The Bitcoin anchoring card, once: label, status, title, one sentence.
        // No ✓ for any of these states: only CHAIN_VERIFIED carries one (2026-10-15).
        expect(all, ots).toMatch(new RegExp(`Bitcoin anchoring ${status} ${title} ${sentence.replace(/\./g, "\\.")}`));
        expect(all, ots).not.toMatch(/Bitcoin anchoring ✓/);
        expect(all.split(sentence).length - 1, ots).toBe(1);
        // The boundary is stated once, for an anchored proof only.
        expect(all.split("The stored OpenTimestamps proof names a Bitcoin block for the recorded evidence digest.").length - 1, ots).toBe(ots === "anchored" ? 1 : 0);
        // No internal state, raw code, verified claim or retired wording anywhere in the report.
        expect(all, ots).not.toMatch(/NOT_CHECKED|PROOF_STRUCTURE|BITCOIN_VERIFIED|PROOF_HASH_MISMATCH|CHAIN_VERIFI|ATTESTATION_PRESENT|ATTESTATION_RECORDED|Independently verified|independently verified against|anchored in Bitcoin|Anchored at|Bitcoin time|RPC/);
        // The technical material lives in the appendix only.
        const appendix = pageText.findIndex((t) => t.includes("Technical Appendix — Timestamp & Anchoring"));
        expect(appendix, ots).toBeGreaterThan(0);
        pageText.forEach((t, i) => {
          if (i === appendix) return;
          expect(t, `${ots} p${i + 1}`).not.toMatch(/BITCOIN TRANSACTION ID|BITCOIN BLOCK HEIGHT|PROOF SHA-256|PROOF VALIDATOR/i);
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
      const text = (await extractPdfText(await renderPdf(html))).replace(/\s+/g, "");
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
      const pdf = await renderPdf(html);
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
      const err = await refusal(() => renderPdf(html));
      expect(err.code).toBe("REPORT_OUTPUT_INCONSISTENT");
      expect(err.retriable).toBe(false);
      expect(err.findings.map((f) => f.check)).toContain("CLIPPED_CONTENT");
    },
    RENDER_TIMEOUT,
  );

  it(
    "removing the supersession notice is refused",
    async () => {
      const html = await htmlOf(v2);
      const withoutNotice = html.replace(supersessionStatement(v2.supersession!.previousVersion), "This version");
      for (const [mutated, name] of [
        [withoutNotice, "supersession notice"],
      ] as const) {
        const pdf = await renderPdf(mutated);
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
      const pdf = await renderPdf(await htmlOf(input));
      expect((await extractPdfText(pdf)).replace(/\s+/g, "")).toContain(LONG_MANIFEST_URL);
      expect(checkReportGeometry(await readReportGeometry(pdf), { requiredStatements: required(input) })).toEqual([]);
    },
    RENDER_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// (2026-10-13) The restored evidence report, rendered: full-A4 background on
// every page, no sparse page, no stranded custody row, the gate accepts it.
// ---------------------------------------------------------------------------

type Raster = { width: number; height: number; data: Uint8ClampedArray };

/** Every page, rasterized by the worker's own PDF.js build onto a canvas. */
async function rasterPages(pdf: Uint8Array | Buffer, scale = 0.35): Promise<Raster[]> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const doc = (await openPdf(pdf)) as unknown as {
    numPages: number;
    getPage(n: number): Promise<{
      getViewport(o: { scale: number }): { width: number; height: number };
      render(o: Record<string, unknown>): { promise: Promise<void> };
    }>;
    destroy(): Promise<void>;
  };
  const out: Raster[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      out.push({ width: canvas.width, height: canvas.height, data: img.data as unknown as Uint8ClampedArray });
    }
  } finally {
    await doc.destroy();
  }
  return out;
}

/** Bands of the page (fractions of its height) where only background shows: a pure-white row there is a gap. */
function whiteBands(r: Raster): number[] {
  const rows = [0.01, 0.02, 0.955, 0.985, 0.995].map((f) => Math.min(r.height - 1, Math.floor(r.height * f)));
  return rows.filter((y) => {
    let white = 0;
    for (let x = 0; x < r.width; x++) {
      const i = (y * r.width + x) * 4;
      if (r.data[i]! >= 253 && r.data[i + 1]! >= 253 && r.data[i + 2]! >= 253) white += 1;
    }
    return white > r.width * 0.5;
  });
}

const TIMESTAMP = /^\d{2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}:\d{2} UTC$/;

describe.skipIf(!BROWSER)("the restored evidence report, rendered", () => {
  it(
    "the regression record: every page has a full-A4 background, no page is sparse, no custody row stands alone, the gate accepts it",
    async () => {
      const input = regressionRecordInput("absent");
      const pdf = await renderPdf(await htmlOf(input));
      const pages = await readReportGeometry(pdf);
      // The original v2 was 16 pages; the restored report is markedly shorter.
      expect(pages.length).toBeLessThanOrEqual(12);
      const rasters = await rasterPages(pdf);
      rasters.forEach((r, i) => expect(whiteBands(r), `page ${i + 1} has a white band`).toEqual([]));
      const text = pages.map((p) => p.items.map((i) => i.str).join(" ").replace(/\s+/g, " "));
      text.forEach((t, i) => expect(t.length, `page ${i + 1} is sparse`).toBeGreaterThan(400));
      // Custody pages: from the timeline to the workflow page, every page holds 0 or ≥ 2 rows.
      const start = text.findIndex((t) => t.includes("Chain of Custody"));
      const end = text.findIndex((t) => t.includes("Reviewer Verification Workflow"));
      expect(start).toBeGreaterThan(0);
      for (let i = start; i < end; i++) {
        const rows = pages[i]!.items.filter((it) => TIMESTAMP.test(it.str.trim())).length;
        expect(rows === 0 || rows >= 2, `page ${i + 1} holds ${rows} custody row(s)`).toBe(true);
      }
      await assertRenderedReport(Buffer.from(pdf), factsOf(input), input.version, { supersedesVersion: input.supersession!.previousVersion });
    },
    RENDER_TIMEOUT * 2,
  );

  it(
    "MUTATION: a page background tied to the content again leaves white bands, and the check finds them",
    async () => {
      const input = regressionRecordInput("absent");
      const html = (await htmlOf(input)).replace("</style>", "html { background: none !important; } </style>");
      const rasters = await rasterPages(await renderPdf(html));
      expect(rasters.some((r) => whiteBands(r).length > 0)).toBe(true);
    },
    RENDER_TIMEOUT,
  );

  it(
    "MUTATION: the PENDING sentence beside an upgraded proof, or a retired card, is refused by the gate",
    async () => {
      const input = regressionRecordInput("absent");
      const html = await htmlOf(input);
      for (const [mutated, check] of [
        // 2026-10-15 wording: the pending sentence beside an attested proof,
        // the retired "anchored in Bitcoin" claim, and a verified label for a
        // proof that was never checked against the chain are all refused.
        [html.replace("The proof names Bitcoin block 860000; PROOVRA has not checked it against the Bitcoin main chain.", "Submitted to OpenTimestamps calendars; no Bitcoin attestation yet."), "OTS_CONTRADICTION"],
        [html.replace("Bitcoin attestation recorded", "OpenTimestamps proof anchored in Bitcoin"), "OTS_RETIRED_WORDING"],
        [html.replace("Bitcoin attestation recorded", "Independently verified against the Bitcoin main chain"), "OTS_OVERCLAIM"],
        [html.replace("Account authentication", "Pre-PROOVRA provenance"), "RETIRED_SIGNAL"],
      ] as const) {
        const pdf = await renderPdf(mutated);
        const err = await refusal(() =>
          assertRenderedReport(Buffer.from(pdf), factsOf(input), input.version, { supersedesVersion: input.supersession!.previousVersion }),
        );
        expect(err.findings.map((f) => f.check)).toContain(check);
      }
    },
    RENDER_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// (2026-10-14) The removed sections and the corrected account and package
// rows, through Chromium: absent from the PDF's own text, no gap where they
// were, the canonical gate accepts the report — and refuses a restored block.
// ---------------------------------------------------------------------------

/** The largest vertical gap between consecutive body lines of a page (footer excluded), in points. */
function largestInnerGap(page: PageGeometry): number {
  const body = page.items.filter((it) => !/^Page \d+\/\d+$/.test(it.str.trim()) && it.bottom < page.height - REPORT_PAGE_PT.footerZone);
  const sorted = [...body].sort((a, b) => a.top - b.top);
  let bottom = sorted[0]?.bottom ?? 0;
  let gap = 0;
  for (const it of sorted.slice(1)) {
    gap = Math.max(gap, it.top - bottom);
    bottom = Math.max(bottom, it.bottom);
  }
  return gap;
}

describe.skipIf(!BROWSER)("the corrected rows and the removed sections, rendered (2026-10-14)", () => {
  const REMOVED = [
    "What this report is",
    "What it does not establish",
    "Embedded previews are reviewer aids",
    "Location metadata was not recorded for this evidence.",
    "PROOVRA observed the files from upload onward",
    "Workspace identity",
    "paired with this report",
  ];

  for (const location of ["absent", "recorded"] as const) {
    it(
      `regression record, location ${location}: rows state the canonical facts, removed text is gone, no gap is left`,
      async () => {
        const input = regressionRecordInput(location);
        const pdf = await renderPdf(await htmlOf(input));
        const pages = await readReportGeometry(pdf);
        const pageText = pages.map((p) => p.items.map((i) => i.str).join(" ").replace(/\s+/g, " "));
        const all = pageText.join(" ");
        expect(all).toMatch(/Account authentication (?:✓ )?Verified Authenticated email account recorded at submission This verifies the account context, not the person's real-world identity\./);
        expect(all).toMatch(/Verification package (?:i )?Paired Verification package v2 is produced after this report/);
        for (const phrase of REMOVED) expect(all, phrase).not.toContain(phrase);
        expect(all.split("Report boundary.").length - 1).toBe(1);
        expect(all.includes("CAPTURE LOCATION") || all.includes("Capture location")).toBe(location === "recorded");
        // The Executive Summary and the review index close cleanly: no gap
        // where the removed blocks stood.
        for (const title of ["Executive Summary", "Court & Technical Review Index"]) {
          const i = pageText.findIndex((t) => t.includes(title));
          expect(i, title).toBeGreaterThan(0);
          expect(largestInnerGap(pages[i]!), title).toBeLessThan(40);
        }
        await assertRenderedReport(Buffer.from(pdf), factsOf(input), input.version, { supersedesVersion: input.supersession!.previousVersion });
      },
      RENDER_TIMEOUT,
    );
  }

  it(
    "MUTATION: the review index's Report boundary block restored, or a Verified account the snapshot does not support, is refused",
    async () => {
      const input = regressionRecordInput("absent");
      const html = await htmlOf(input);
      const restored = html.replace(
        '<section class="executive-trust-decision-panel">',
        '<section><div>Report boundary</div><div>What it does not establish</div><div>Factual truth, authorship, intent, context, completeness, admissibility or evidentiary weight.</div></section><section class="executive-trust-decision-panel">',
      );
      const unverified = { ...input, evidence: { ...input.evidence, acquisitionIdentity: { ...input.evidence.acquisitionIdentity!, emailVerified: false, identityLevel: "BASIC_ACCOUNT" } } } as ReportV2Input;
      for (const [mutatedHtml, facts, check] of [
        [restored, factsOf(input), "RETIRED_SECTION"],
        // The report printed for a verified snapshot, checked against a record whose snapshot is not verified.
        [html, factsOf(unverified), "IDENTITY_STATUS"],
      ] as const) {
        const pdf = await renderPdf(mutatedHtml);
        const err = await refusal(() =>
          assertRenderedReport(Buffer.from(pdf), facts, input.version, { supersedesVersion: input.supersession!.previousVersion }),
        );
        expect(err.findings.map((f) => f.check)).toContain(check);
      }
    },
    RENDER_TIMEOUT,
  );
});

/*
 * AUD-18 (2026-10-20) — THE REPORT PRINTS THE VERIFICATION REFERENCE, NEVER THE
 * INTERNAL EVIDENCE UUID. Characterization (rendered, before): the cover card
 * "Evidence Reference" and every page footer "ID: 4f8d2c1a-…" printed the
 * record's internal id — and the footer scraped any UUID out of the body when
 * the card was absent. Now every page states `Ref: pvr_…`, and with no
 * reference recorded the report says so; the UUID is in no page's text.
 */
describe.skipIf(!BROWSER)("the report names the record by its verification reference (AUD-18)", () => {
  const REF = "pvr_Q2hQd3c4bHhFdGVzdFJlZmVyZW5jZQ";
  const pageTexts = async (input: ReportV2Input) =>
    (await readReportGeometry(await renderPdf(await htmlOf(input)))).map((p) => p.items.map((i) => i.str).join(" ").replace(/\s+/g, " "));

  it(
    "every page footer and the cover state pvr_; the internal UUID appears nowhere",
    async () => {
      const base = regressionRecordInput("absent");
      const uuid = base.evidence.id;
      expect(uuid).toMatch(/^[0-9a-f]{8}-/);
      // As the worker passes them: the reference and the verify URL built from it.
      const texts = await pageTexts({ ...base, verificationRef: REF, verifyUrl: `https://app.proovra.example/verify/${REF}` });
      expect(texts.length).toBeGreaterThan(3);
      texts.forEach((t, i) => {
        expect(t, `page ${i + 1} footer`).toContain(`Ref: ${REF}`);
        expect(t, `page ${i + 1} prints the internal id`).not.toContain(uuid);
        expect(t).not.toMatch(/\bID: [0-9a-f]{8}-/);
      });
      // The cover card (the stylesheet sets the label in capitals).
      expect(texts[0]).toMatch(new RegExp(`Verification Reference ${REF}`, "i"));
      expect(texts.join(" ")).not.toMatch(/Evidence Reference/i);
    },
    RENDER_TIMEOUT,
  );

  it(
    "with no reference recorded the report says so, and still never prints the UUID",
    async () => {
      const base = regressionRecordInput("absent");
      const texts = await pageTexts({ ...base, verificationRef: null, verifyUrl: null });
      texts.forEach((t, i) => {
        expect(t, `page ${i + 1}`).not.toContain(base.evidence.id);
        expect(t).toContain("Ref: N/A");
      });
      expect(texts[0]).toMatch(/Verification Reference\s*Not recorded/i);
    },
    RENDER_TIMEOUT,
  );
});

/*
 * THE REPORT'S AUDIENCE DECIDES WHETHER COORDINATES PRINT (supersedes AUD-19).
 * The authorized report (the processor passes recordedLocationDisclosed: true
 * under every public policy) prints the opted-in location. A projection for an
 * audience that may not see it (false / absent) prints no coordinate, no map
 * and no "Capture location" panel — and states the location as WITHHELD, never
 * "not recorded" (which would be false) and never silence.
 */
describe.skipIf(!BROWSER)("the report's recorded location follows its audience", () => {
  const pdfText = async (input: ReportV2Input) =>
    (await readReportGeometry(await renderPdf(await htmlOf(input)))).map((p) => p.items.map((i) => i.str).join(" ")).join(" ").replace(/\s+/g, " ");

  it(
    "withheld audience: no coordinate, no map, and the location is stated as withheld — never 'not recorded'",
    async () => {
      const recorded = regressionRecordInput("recorded");
      for (const decision of [undefined, false] as const) {
        const input = { ...recorded, recordedLocationDisclosed: decision } as ReportV2Input;
        const html = await htmlOf(input);
        expect(html).not.toContain(`<img class="capture-context-map"`);
        expect(html).not.toContain('data-capture-location="recorded"');
        expect(html).toContain('data-capture-location="withheld"');
        const text = await pdfText(input);
        expect(text).not.toMatch(/52\.521|13\.405/);
        expect(text).not.toMatch(/Latitude|Longitude|Accuracy radius|Capture location/i);
        expect(text).not.toMatch(/Location (metadata )?(was )?not recorded/i);
        expect(text).toMatch(/Location withheld/);
      }
    },
    RENDER_TIMEOUT * 2,
  );

  it(
    "authorized report: the coordinates and the map print",
    async () => {
      const input = regressionRecordInput("recorded");
      expect(input.recordedLocationDisclosed).toBe(true);
      expect(await htmlOf(input)).toContain(`<img class="capture-context-map"`);
      expect(await pdfText(input)).toMatch(/52\.521/);
    },
    RENDER_TIMEOUT,
  );
});
