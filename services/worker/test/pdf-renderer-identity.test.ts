/**
 * The report PDF's /Creator and /Producer are the product's renderer name,
 * whatever browser printed it (pdf-renderer-identity.ts). No browser here:
 * the input PDFs stand in for what full Chrome and chrome-headless-shell
 * write, and the browser-backed proof lives in report-pdf-layout.test.ts.
 */
import { describe, expect, it } from "vitest";

import { openPdf } from "../src/pdf/pdfjs-runtime.js";
import { PdfRendererIdentityError, setPdfRendererIdentity } from "../src/report-v2/pdf-renderer-identity.js";
import { REPORT_PDF_CREATOR } from "../src/report-v2/render-pdf.js";

const pdfLiteral = (v: string) => `(${v.replace(/[\\()]/g, (c) => `\\${c}`)})`;

/**
 * A two-page PDF in Skia's shape: object 1 is a direct-literal /Info written
 * FIRST (so every later offset moves when it is rewritten), a classic xref
 * table in one subsection, one revision.
 */
function pdfWithInfo(info: Record<string, string>): Promise<Buffer> {
  const dict = Object.entries(info).map(([k, v]) => `/${k} ${pdfLiteral(v)}`).join("\n");
  const content = (text: string) => `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    `<<${dict}\n/CreationDate (D:20261024000000+00'00')\n/ModDate (D:20261024000000+00'00')>>`,
    "<</Type /Catalog /Pages 3 0 R>>",
    "<</Type /Pages /Kids [4 0 R 5 0 R] /Count 2>>",
    "<</Type /Page /Parent 3 0 R /MediaBox [0 0 595 842] /Resources <</Font <</F1 8 0 R>>>> /Contents 6 0 R>>",
    "<</Type /Page /Parent 3 0 R /MediaBox [0 0 595 842] /Resources <</Font <</F1 8 0 R>>>> /Contents 7 0 R>>",
    `<</Length ${content("the bounded limitation").length}>>\nstream\n${content("the bounded limitation")}\nendstream`,
    `<</Length ${content("second page").length}>>\nstream\n${content("second page")}\nendstream`,
    "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>",
  ];
  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<</Size ${objects.length + 1}\n/Root 2 0 R\n/Info 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Promise.resolve(Buffer.from(out, "latin1"));
}

/** Every in-use xref entry points at its own object header. */
function assertXrefConsistent(pdf: Buffer): void {
  const s = pdf.toString("latin1");
  const start = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(s)![1]);
  expect(s.slice(start, start + 4)).toBe("xref");
  const lines = s.slice(start).split("\n");
  const count = Number(lines[1]!.split(" ")[1]);
  for (let i = 0; i < count; i++) {
    const [offset, , kind] = lines[2 + i]!.trim().split(" ");
    if (kind !== "n") continue;
    expect(s.slice(Number(offset), Number(offset) + `${i} 0 obj`.length)).toBe(`${i} 0 obj`);
  }
}

async function infoOf(pdf: Buffer): Promise<Record<string, unknown>> {
  const doc = await openPdf(pdf);
  try {
    return ((await doc.getMetadata()).info ?? {}) as Record<string, unknown>;
  } finally {
    await doc.destroy();
  }
}

// What each runtime writes (shapes only; the versions are placeholders).
const RUNTIMES = {
  "full Chrome (user agent as Creator)": {
    Title: "PROOVRA Verification Report",
    Creator: "Mozilla/5.0 (Placeholder OS; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/0.0.0.0 Safari/537.36",
    Producer: "Skia/PDF m0",
  },
  "chrome-headless-shell": { Title: "PROOVRA Verification Report", Creator: "Chromium", Producer: "Skia/PDF m0" },
} as const;

describe("the report PDF names its renderer, never the browser that printed it", () => {
  for (const [runtime, info] of Object.entries(RUNTIMES)) {
    it(`${runtime}: Creator and Producer are the renderer name; the title is kept; the file stays one consistent revision`, async () => {
      const before = await pdfWithInfo(info);
      const after = setPdfRendererIdentity(before, REPORT_PDF_CREATOR);

      const meta = await infoOf(after);
      expect(meta.Creator).toBe(REPORT_PDF_CREATOR);
      expect(meta.Producer).toBe(REPORT_PDF_CREATOR);
      expect(meta.Title).toBe(info.Title);
      expect(JSON.stringify(meta)).not.toMatch(/Mozilla|HeadlessChrome|Chromium|Skia|Placeholder OS/);

      const bytes = after.toString("latin1");
      expect(bytes).not.toMatch(/HeadlessChrome|Chromium|Skia/);
      expect(bytes.match(/startxref/g)).toHaveLength(1);
      expect(bytes).not.toMatch(/\/Prev\b/);
      assertXrefConsistent(after);
      expect((await openPdf(after)).numPages).toBe(2);
    });
  }

  it("both runtimes yield the same identity, and setting it twice changes nothing", async () => {
    const [a, b] = await Promise.all(Object.values(RUNTIMES).map((i) => pdfWithInfo(i)));
    const ia = await infoOf(setPdfRendererIdentity(a!, REPORT_PDF_CREATOR));
    const ib = await infoOf(setPdfRendererIdentity(b!, REPORT_PDF_CREATOR));
    expect([ia.Creator, ia.Producer]).toEqual([ib.Creator, ib.Producer]);
    const once = setPdfRendererIdentity(a!, REPORT_PDF_CREATOR);
    expect(setPdfRendererIdentity(once, REPORT_PDF_CREATOR).equals(once)).toBe(true);
  });

  it("a PDF it cannot rewrite safely is refused, never shipped with the browser's identity", () => {
    expect(() => setPdfRendererIdentity(Buffer.from("%PDF-1.7\n%%EOF\n"), REPORT_PDF_CREATOR)).toThrow(PdfRendererIdentityError);
  });

  it("an identity held in another object (which would survive the rewrite) is refused", async () => {
    const pdf = (await pdfWithInfo(RUNTIMES["chrome-headless-shell"])).toString("latin1");
    const indirect = Buffer.from(pdf.replace("/Creator (Chromium)", "/Creator 8 0 R     "), "latin1"); // same length: offsets hold
    expect(() => setPdfRendererIdentity(indirect, REPORT_PDF_CREATOR)).toThrow(/not a direct string/);
  });

  it("the renderer name is a plain PDF literal", async () => {
    const pdf = await pdfWithInfo(RUNTIMES["chrome-headless-shell"]);
    expect(() => setPdfRendererIdentity(pdf, "a (b)")).toThrow(PdfRendererIdentityError);
  });
});
