/**
 * THE ONE PDF.js RUNTIME (2026-10-09).
 *
 * Production failed every report with "The API version 5.4.296 does not match
 * the Worker version 5.6.205": pdf-parse bundled a second PDF.js, and in one
 * long-lived process whichever build parsed a PDF first claimed the
 * process-wide worker handler. These cases pin the corrected contract:
 *
 *   * the worker loads exactly one PDF.js, at the version its package pins;
 *   * report text extraction works AFTER another path parsed a PDF (the order
 *     production hit) and before it (the other order);
 *   * a foreign handler in the process is refused with a typed error, never
 *     parsed with;
 *   * an unreadable rendered PDF fails the report gate with a STABLE,
 *     NON-RETRYABLE code — never a retry loop, never success;
 *   * the CI integrity gate passes on this tree and fails on the defective
 *     layout.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";

import { deriveCanonicalArtifactFacts } from "@proovra/shared";

import { assertRenderedReport, OutputVerificationError } from "../src/output-verification.js";
import {
  assertOwnWorkerHandler,
  extractPdfTextWithPdfjs,
  loadPdfjs,
  openPdf,
  PdfjsRuntimeError,
  resolvedPdfjsPackageVersion,
} from "../src/pdf/pdfjs-runtime.js";
import { isRetriableError } from "../src/processor.js";
import { parsePdfMetadata } from "../src/technical-metadata/pdf-parser.js";

const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function pdfOf(lines: Array<{ text: string; x?: number; y?: number }>, pages = 1): Promise<Buffer> {
  return new Promise((res) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => res(Buffer.concat(chunks)));
    for (let p = 0; p < pages; p += 1) {
      doc.addPage();
      for (const l of lines) {
        if (l.x != null && l.y != null) doc.text(l.text, l.x, l.y, { lineBreak: false });
        else doc.text(l.text);
      }
    }
    doc.end();
  });
}

describe("one PDF.js build per worker process", () => {
  it("loads the API at exactly the version the worker package pins, with that package's own worker handler", async () => {
    const pinned = (JSON.parse(readFileSync(join(workerDir, "package.json"), "utf8")) as { dependencies: Record<string, string> })
      .dependencies["pdfjs-dist"];
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(resolvedPdfjsPackageVersion()).toBe(pinned);
    const api = await loadPdfjs();
    expect(api.version).toBe(pinned);
    expect(() => assertOwnWorkerHandler(api.version)).not.toThrow();
  });

  it("PRODUCTION ORDER: report text is extracted after the metadata path parsed a PDF, and the metadata path still works after", async () => {
    const upload = await pdfOf([{ text: "An uploaded PDF the worker previewed earlier." }]);
    expect((await parsePdfMetadata(upload, "application/pdf")).parseResult).toBe("OK");
    const report = await pdfOf([{ text: "PROOVRA Evidence Report v1" }]);
    expect(await extractPdfTextWithPdfjs(report)).toContain("PROOVRA Evidence Report v1");
    expect((await parsePdfMetadata(upload, "application/pdf")).parseResult).toBe("OK");
  });

  // The expected text is what pdf-parse 2.4.5 itself returned for this exact
  // PDF (captured before it was removed), so the gate reads what it always read.
  it("keeps pdf-parse's text layout byte for byte: lines, cells on one line, and the page joiner", async () => {
    const pdf = await pdfOf(
      [
        { text: "Left cell", x: 72, y: 100 },
        { text: "Right cell", x: 300, y: 100 },
        { text: "Next line", x: 72, y: 140 },
      ],
      2,
    );
    expect(await extractPdfTextWithPdfjs(pdf)).toBe(
      "Left cell Right cell\nNext line\n\n-- 1 of 2 --\n\nLeft cell Right cell\nNext line\n\n-- 2 of 2 --\n\n",
    );
  });

  it("refuses to parse when another PDF.js build has claimed the process-wide worker handler", async () => {
    await loadPdfjs();
    const g = globalThis as { pdfjsWorker?: unknown };
    const own = g.pdfjsWorker;
    g.pdfjsWorker = { WorkerMessageHandler: { setup() {} } };
    try {
      await expect(openPdf(await pdfOf([{ text: "x" }]))).rejects.toBeInstanceOf(PdfjsRuntimeError);
      await expect(openPdf(await pdfOf([{ text: "x" }]))).rejects.toThrow(/PDFJS_RUNTIME_MISMATCH/);
    } finally {
      g.pdfjsWorker = own;
    }
  });
});

describe("an unreadable rendered report fails the gate with a stable, terminal code", () => {
  const facts = deriveCanonicalArtifactFacts(
    { fileSha256: "a".repeat(64), tsaTokenPresent: false, otsProofPresent: false } as never,
    [],
  );

  it("bytes that are not a PDF: REPORT_PDF_VERIFICATION_FAILED, not retryable, never success", async () => {
    let err: unknown;
    try {
      await assertRenderedReport(Buffer.from("not a pdf at all"), facts, 1);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OutputVerificationError);
    expect((err as OutputVerificationError).code).toBe("REPORT_PDF_VERIFICATION_FAILED");
    expect(isRetriableError(err), "a deterministic read failure is not retried").toBe(false);
  });

  it("the production failure (a foreign worker handler) is the same stable code, naming the runtime mismatch", async () => {
    const pdf = await pdfOf([{ text: "PROOVRA Evidence Report v1" }]);
    const g = globalThis as { pdfjsWorker?: unknown };
    const own = g.pdfjsWorker;
    g.pdfjsWorker = { WorkerMessageHandler: { setup() {} } };
    let err: unknown;
    try {
      await assertRenderedReport(pdf, facts, 1);
    } catch (e) {
      err = e;
    } finally {
      g.pdfjsWorker = own;
    }
    expect((err as OutputVerificationError).code).toBe("REPORT_PDF_VERIFICATION_FAILED");
    expect(String((err as Error).message)).toContain("PDFJS_RUNTIME_MISMATCH");
    expect(isRetriableError(err)).toBe(false);
  });
});

describe("CI integrity gate", () => {
  const gate = join(workerDir, "scripts", "check-pdfjs-integrity.mjs");
  const run = (env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [gate], { encoding: "utf8", env: { ...process.env, ...env } });

  it("passes on this tree", () => {
    const r = run();
    expect(r.status, r.stderr).toBe(0);
  });

  it("fails on the defective layout (range pin, pdf-parse, two resolutions, direct imports)", () => {
    const root = mkdtempSync(join(tmpdir(), "pdfjs-gate-"));
    try {
      const w = join(root, "services", "worker");
      mkdirSync(join(w, "src", "preview"), { recursive: true });
      writeFileSync(
        join(w, "package.json"),
        JSON.stringify({ name: "fixture-worker", dependencies: { "pdf-parse": "^2.4.5", "pdfjs-dist": "^5.6.205" } }),
      );
      writeFileSync(join(root, "pnpm-lock.yaml"), "packages:\n\n  pdf-parse@2.4.5:\n    resolution: {}\n\n  pdfjs-dist@5.4.296:\n    resolution: {}\n\n  pdfjs-dist@5.6.205:\n    resolution: {}\n");
      writeFileSync(join(w, "src", "output-verification.ts"), 'const m = await import("pdf-parse");\n');
      writeFileSync(join(w, "src", "preview", "extract.ts"), 'const p = await import("pdfjs-dist/legacy/build/pdf.mjs");\n');
      const r = run({ PDFJS_GATE_WORKER_DIR: w, PDFJS_GATE_REPO_DIR: root });
      expect(r.status).toBe(1);
      for (const v of [
        "not pinned exactly",
        "depends on pdf-parse",
        "resolves 2 pdfjs-dist versions",
        "contains pdf-parse",
        "src/output-verification.ts imports pdf-parse",
        "src/preview/extract.ts imports pdfjs-dist directly",
      ]) {
        expect(r.stderr, v).toContain(v);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
