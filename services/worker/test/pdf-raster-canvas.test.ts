/**
 * PDF RASTERIZATION ON THE WORKER'S CANVAS (AUD-0063 follow-up, 2026-11-11).
 *
 * pdfjs-dist 6 draws through its own copy of @napi-rs/canvas (Path2D,
 * DOMMatrix) onto the canvas the caller creates. When the worker pinned a
 * different major of @napi-rs/canvas, every fill failed with "Value is none of
 * these types `String`, `Path`": the PDF first-page preview fell back to the
 * generic card, the redaction derivative of a PDF failed, and the report
 * layout raster checks failed in CI. These run without Chromium, on a PDF
 * built here, through the production functions.
 */
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: {} }));
vi.mock("../src/logger.js", () => ({ logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
vi.mock("../src/storage.js", () => ({ getObjectRange: vi.fn(), putObjectBuffer: vi.fn() }));

import { closePdf, openPdf } from "../src/pdf/pdfjs-runtime.js";
import { extractPreviewForAsset } from "../src/preview/extract.js";
import { renderRedactedPdf } from "../src/redaction/redaction-derivative.processor.js";

const PAGE = { r: 0x12, g: 0x34, b: 0x56 };

/** One A4 page, painted edge to edge in PAGE's colour, with a line of white text. */
function paintedPdf(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const d = new PDFDocument({ size: "A4", margin: 0 });
    const chunks: Buffer[] = [];
    d.on("data", (c: Buffer) => chunks.push(c));
    d.on("end", () => resolve(Buffer.concat(chunks)));
    d.on("error", reject);
    d.rect(0, 0, 595.28, 841.89).fill("#123456");
    d.fillColor("white").fontSize(24).text("Preserved evidence page", 72, 400);
    d.end();
  });
}

async function rasterFirstPage(pdf: Buffer): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const doc = await openPdf(pdf);
  try {
    const page = (await doc.getPage(1)) as unknown as {
      getViewport(o: { scale: number }): { width: number; height: number };
      render(o: Record<string, unknown>): { promise: Promise<void> };
    };
    const vp = page.getViewport({ scale: 0.25 });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, data: img.data as unknown as Uint8ClampedArray };
  } finally {
    await closePdf(doc);
  }
}

function pixel(r: { width: number; data: Uint8ClampedArray }, x: number, y: number) {
  const i = (Math.floor(y) * r.width + Math.floor(x)) * 4;
  return { r: r.data[i]!, g: r.data[i + 1]!, b: r.data[i + 2]! };
}

const near = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) =>
  Math.abs(a.r - b.r) <= 6 && Math.abs(a.g - b.g) <= 6 && Math.abs(a.b - b.b) <= 6;

describe("PDF pages rasterize onto the worker's canvas", () => {
  it("the worker and PDF.js resolve one and the same @napi-rs/canvas", () => {
    const fromWorker = createRequire(path.resolve("package.json"));
    const pdfjsPkg = realpathSync(path.dirname(fromWorker.resolve("pdfjs-dist/package.json")));
    const fromPdfjs = createRequire(path.join(pdfjsPkg, "package.json"));
    expect(realpathSync(fromWorker.resolve("@napi-rs/canvas"))).toBe(realpathSync(fromPdfjs.resolve("@napi-rs/canvas")));
  });

  it("a painted page rasterizes in its own colour", async () => {
    const r = await rasterFirstPage(await paintedPdf());
    expect(near(pixel(r, r.width / 2, r.height / 4), PAGE)).toBe(true);
  });

  it("the PDF preview is the rendered first page, not the fallback card", async () => {
    const preview = await extractPreviewForAsset({ kind: "pdf", mimeType: "application/pdf", buffer: await paintedPdf() });
    expect(preview.previewCaption).toBe("PDF first-page reviewer preview");
    const png = Buffer.from(preview.previewDataUrl!.replace(/^data:image\/png;base64,/, ""), "base64");
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const i = (Math.floor(info.height / 4) * info.width + Math.floor(info.width / 2)) * info.channels;
    expect(near({ r: data[i]!, g: data[i + 1]!, b: data[i + 2]! }, PAGE)).toBe(true);
  });

  it("a PDF redaction burns the region black and keeps the rest of the page", async () => {
    const out = await renderRedactedPdf(await paintedPdf(), [{ page: 1, x: 0, y: 0, width: 0.5, height: 0.5 }]);
    const r = await rasterFirstPage(out);
    expect(near(pixel(r, r.width * 0.25, r.height * 0.25), { r: 0, g: 0, b: 0 })).toBe(true);
    expect(near(pixel(r, r.width * 0.75, r.height * 0.25), PAGE)).toBe(true);
  });
});
