/**
 * RT-018 — WHAT A FILE'S BYTES MAY DO TO ITS REPORT. Real extraction, real HTML,
 * real Chromium, the real gate.
 *
 * One megabyte of random bytes declared as text/plain sealed to SIGNED and then
 * failed report generation for good: the bytes reached an SVG as control
 * characters, the card failed to render, and the fallback printed 500 wide
 * replacement characters into a fixed box the layout audit correctly refused.
 * The gate stays. What changes is what reaches it.
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { assertRenderedReport } from "../src/output-verification.js";
import { extractPreviewForAsset } from "../src/preview/extract.js";
import { buildReportViewModel } from "../src/report-v2/build-view-model.js";
import { renderReportHtml } from "../src/report-v2/render-html.js";
import { renderPdfFromHtml, resolveBrowserExecutablePath } from "../src/report-v2/render-pdf.js";
import type { ReportV2Input } from "../src/report-v2/types.js";
import { canonicalFactsOf, layoutVariant } from "./fixtures/report-layout-variants.js";

const BROWSER = resolveBrowserExecutablePath();
if (!BROWSER && process.env.CI) throw new Error("report render tests need Chromium (PUPPETEER_EXECUTABLE_PATH or a system Chrome)");
const RENDER_TIMEOUT = 180_000;

const line = "Synthetic witness note. The vehicle entered the loading bay at about nine in the morning and stopped by the second door.\n";
const MiB = 1024 * 1024;

const CASES: ReadonlyArray<readonly [string, string, Buffer]> = [
  ["short text", "text/plain", Buffer.from(line.repeat(3))],
  ["1 MiB normal text", "text/plain", Buffer.from(line.repeat(Math.ceil(MiB / line.length)))],
  ["1 MiB single line", "text/plain", Buffer.from("x ".repeat(MiB / 2))],
  ["1 MiB unbroken", "text/plain", Buffer.from("x".repeat(MiB))],
  ["1 MiB unbroken wide letters", "text/plain", Buffer.from("W".repeat(MiB))],
  ["binary declared as text", "text/plain", randomBytes(MiB)],
  ["all NUL declared as text", "text/plain", Buffer.alloc(MiB)],
  ["PE header declared as text", "text/plain", Buffer.concat([Buffer.from("MZ"), randomBytes(4096)])],
  ["CSV export", "text/csv", Buffer.from(`id,name,amount\n${Array.from({ length: 30000 }, (_, i) => `${i},Item ${i},${i * 3}`).join("\n")}\n`)],
  ["JSON", "application/json", Buffer.from(JSON.stringify(Array.from({ length: 20000 }, (_, i) => ({ id: i, note: "synthetic" }))))],
  ["text with terminal escapes", "text/plain", Buffer.from(`\u001b[31mERROR\u001b[0m ${line}`.repeat(2000))],
  ["Arabic text", "text/plain", Buffer.from("هذه ملاحظة شاهد اصطناعية عن المركبة التي دخلت ساحة التحميل. ".repeat(2000))],
  ["Chinese text", "text/plain", Buffer.from("这是一份关于车辆进入装卸区的合成证人记录。".repeat(4000))],
  ["emoji text", "text/plain", Buffer.from("🚚🏭📦".repeat(40000))],
  ["Windows-1252 text", "text/plain", Buffer.from(`Caf\xe9 d\xe9j\xe0 vu \x96 r\xe9sum\xe9. `.repeat(20000), "latin1")],
  ["UTF-16 text", "text/plain", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(line.repeat(2000), "utf16le")])],
];

/** The report a record with this one file produces, through the real preview extractor. */
async function inputFor(mimeType: string, buffer: Buffer, withCard: boolean): Promise<ReportV2Input> {
  const input = layoutVariant({ name: "text evidence", parts: 1 }).input;
  const preview = await extractPreviewForAsset({ kind: "text", mimeType, buffer } as never);
  const evidence = input.evidence as unknown as Record<string, unknown> & { contentItems: Array<Record<string, unknown>> };
  const item = { ...evidence.contentItems[0], kind: "text", mimeType, previewable: true, ...preview };
  if (!withCard) item.previewDataUrl = null;
  evidence.contentItems = [item];
  evidence.primaryContentItem = item;
  return input;
}

describe("what the bytes are decides what is printed", () => {
  const extract = (buffer: Buffer) => extractPreviewForAsset({ kind: "text", mimeType: "text/plain", buffer } as never);

  it("bytes that are not text get a card that says so, and no excerpt", async () => {
    for (const buffer of [randomBytes(4096), Buffer.alloc(4096), Buffer.concat([Buffer.from("MZ"), randomBytes(512)])]) {
      const preview = await extract(buffer);
      expect(preview.previewTextExcerpt).toBeNull();
      expect(preview.previewCaption).toBe("Binary content, no text excerpt");
      expect(preview.previewDataUrl).toMatch(/^data:image\/jpeg/);
    }
  });

  it("legacy single-byte and UTF-16 text is read as text, not as garbage", async () => {
    const legacy = await extract(Buffer.from("Caf\xe9 d\xe9j\xe0 vu r\xe9sum\xe9", "latin1"));
    expect(legacy.previewTextExcerpt).toBe("Café déjà vu résumé");
    const utf16 = await extract(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Witness note", "utf16le")]));
    expect(utf16.previewTextExcerpt).toBe("Witness note");
  });

  it("an excerpt carries no terminal escape or control character, so its card always renders", async () => {
    const preview = await extract(Buffer.from("\u001b[31mERROR\u001b[0m line\u0001 two"));
    expect(preview.previewTextExcerpt).toBe("ERROR line two");
    expect(preview.previewDataUrl).toMatch(/^data:image\/jpeg/);
  });

  it("an excerpt never ends on half of a character", async () => {
    const preview = await extract(Buffer.from("🚚".repeat(600)));
    expect(preview.previewTextExcerpt).toMatch(/🚚…$/);
  });
});

describe.skipIf(!BROWSER)("a file's bytes never cost a record its report", () => {
  for (const [name, mimeType, buffer] of CASES) {
    // The fallback is the path that clipped. The card path renders an image and
    // is exercised for the two cases that used to break it.
    for (const withCard of /binary|Chinese/.test(name) ? [true, false] : [false]) {
      it(
        `${name}, ${withCard ? "with the review card" : "when the card is unavailable"}: the report passes the gate`,
        async () => {
          const input = await inputFor(mimeType, buffer, withCard);
          const html = renderReportHtml(await buildReportViewModel(input));
          const pdf = await renderPdfFromHtml(html, { launchTimeoutMs: 90_000 });
          await assertRenderedReport(Buffer.from(pdf), canonicalFactsOf(input), input.version, { supersedesVersion: null });
        },
        RENDER_TIMEOUT,
      );
    }
  }
});
