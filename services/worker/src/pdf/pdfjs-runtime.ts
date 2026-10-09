/**
 * THE ONE PDF.js RUNTIME OF THE WORKER (2026-10-09).
 *
 * Production failed every report into the DLQ with
 *
 *   UnknownErrorException: The API version "5.4.296" does not match the
 *   Worker version "5.6.205".
 *
 * Two PDF.js builds lived in one process. `pdf-parse` (used to read a rendered
 * report back) BUNDLES its own PDF.js 5.4.296 inside its dist; the preview,
 * technical-metadata and redaction paths imported the worker's direct
 * `pdfjs-dist` 5.6.205. In Node, PDF.js runs a "fake worker" whose message
 * handler is cached process-wide on `globalThis.pdfjsWorker`, and every later
 * `getDocument` — from either build — reuses it. Whichever build loaded first
 * claimed the handler; the other then failed its API/worker version check. A
 * long-lived worker process that had rendered a PDF preview could therefore
 * never verify a report again, while an isolated test run (which loads only
 * one build) passed.
 *
 * The rule now: every PDF.js use in the worker goes through `loadPdfjs()`, which
 * loads the ONE `pdfjs-dist` the lockfile resolves (pinned exactly in
 * package.json, no second copy anywhere in the tree), and refuses to run if the
 * API it loaded is not that exact version or a different build has already
 * claimed the process-wide worker handler. A mismatch is a typed, stable
 * failure (`PDFJS_RUNTIME_MISMATCH`), never a parse of the wrong build.
 *
 * `scripts/check-pdfjs-integrity.mjs` enforces the same rule statically in CI.
 */
import { createRequire } from "node:module";

/** The subset of the PDF.js API the worker uses. */
export type PdfjsTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
};
export type PdfjsPage = {
  getViewport(options: { scale: number }): {
    width: number;
    height: number;
    convertToViewportPoint(x: number, y: number): [number, number];
  };
  getTextContent(options?: { includeMarkedContent?: boolean; disableNormalization?: boolean }): Promise<{
    items: Array<PdfjsTextItem | { type: string }>;
  }>;
  render(options: Record<string, unknown>): { promise: Promise<void> };
  cleanup(): void;
};
export type PdfjsDocument = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfjsPage>;
  getMetadata(): Promise<{ info?: Record<string, unknown> | null; metadata?: unknown }>;
  destroy(): Promise<void>;
};
export type PdfjsModule = {
  version: string;
  build: string;
  VerbosityLevel: { ERRORS: number };
  getDocument(options: Record<string, unknown>): { promise: Promise<PdfjsDocument> };
};

export class PdfjsRuntimeError extends Error {
  readonly code = "PDFJS_RUNTIME_MISMATCH";
  constructor(message: string) {
    super(`PDFJS_RUNTIME_MISMATCH: ${message}`);
    this.name = "PdfjsRuntimeError";
  }
}

const requireFromWorker = createRequire(import.meta.url);

/** The exact `pdfjs-dist` version this worker resolves (its package.json). */
export function resolvedPdfjsPackageVersion(): string {
  const pkg = requireFromWorker("pdfjs-dist/package.json") as { version?: unknown };
  if (typeof pkg.version !== "string") throw new PdfjsRuntimeError("pdfjs-dist/package.json has no version");
  return pkg.version;
}

type WorkerModule = { WorkerMessageHandler: unknown };
/**
 * pdfjs-dist ships no types for its worker module; held in a constant so the
 * import is checked at runtime (the identity assertion below), not by tsc.
 */
const PDFJS_WORKER_MODULE = "pdfjs-dist/legacy/build/pdf.worker.mjs";
let loaded: Promise<PdfjsModule> | null = null;
let ownWorker: WorkerModule | null = null;

/**
 * Load the worker's ONE PDF.js build (legacy build — the Node-compatible one):
 * its API AND its worker module, from the same package. Importing the worker
 * module installs ITS message handler as the process-wide fake worker, so the
 * API never falls back to a handler some other build left behind. Memoised:
 * loaded once per process.
 */
export function loadPdfjs(): Promise<PdfjsModule> {
  loaded ??= (async () => {
    const mod = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule;
    const worker = (await import(PDFJS_WORKER_MODULE)) as WorkerModule;
    const expected = resolvedPdfjsPackageVersion();
    if (mod.version !== expected) {
      throw new PdfjsRuntimeError(`API ${mod.version} loaded, package resolves ${expected}`);
    }
    ownWorker = worker;
    return mod;
  })();
  loaded.catch(() => {
    loaded = null;
  });
  return loaded;
}

/**
 * Open a PDF with the worker's PDF.js. The process-wide fake-worker handler
 * must be THIS package's: if any other PDF.js build has replaced it, this
 * refuses with a typed error instead of letting PDF.js fail mid-parse with a
 * version mismatch.
 */
export async function openPdf(data: Uint8Array | Buffer, options: Record<string, unknown> = {}): Promise<PdfjsDocument> {
  const pdfjs = await loadPdfjs();
  assertOwnWorkerHandler(pdfjs.version);
  const bytes = Buffer.isBuffer(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : data;
  return pdfjs
    .getDocument({
      verbosity: pdfjs.VerbosityLevel.ERRORS,
      isEvalSupported: false,
      useWorkerFetch: false,
      ...options,
      data: bytes,
    })
    .promise;
}

/** The handler PDF.js will use is the one this package's worker module installed. */
export function assertOwnWorkerHandler(apiVersion: string): void {
  const claimed = (globalThis as { pdfjsWorker?: WorkerModule }).pdfjsWorker;
  if (!ownWorker || claimed?.WorkerMessageHandler !== ownWorker.WorkerMessageHandler) {
    throw new PdfjsRuntimeError(
      `the process-wide PDF.js worker handler is not pdfjs-dist ${apiVersion}'s (another PDF.js build was loaded in this process)`,
    );
  }
}

// ---------------------------------------------------------------------------
// TEXT — the algorithm the rendered-report gate has always read
// ---------------------------------------------------------------------------

/**
 * The text of a PDF, from its bytes.
 *
 * This is pdf-parse 2.4.5's default `getText()` algorithm, ported onto the one
 * runtime unchanged (line enforcement at 4.6 units, tab between cells more than
 * 7 units apart on one line, `-- n of N --` page joiner), so every rendered-
 * report check reads exactly the text it was written against.
 */
export async function extractPdfTextWithPdfjs(pdf: Uint8Array | Buffer): Promise<string> {
  const doc = await openPdf(pdf);
  try {
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      pages.push(await pageText(page));
      page.cleanup();
    }
    let text = "";
    pages.forEach((pageTextValue, i) => {
      text += `${pageTextValue}\n\n-- ${i + 1} of ${doc.numPages} --\n\n`;
    });
    return text;
  } finally {
    await doc.destroy();
  }
}

const LINE_THRESHOLD = 4.6;
const CELL_THRESHOLD = 7;
const CELL_SEPARATOR = "\t";

async function pageText(page: PdfjsPage): Promise<string> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
  const out: string[] = [];
  let lastX: number | undefined;
  let lastY: number | undefined;
  let lineHeight = 0;
  for (const raw of content.items) {
    if (!("str" in raw)) continue;
    const item = raw as PdfjsTextItem;
    let str = item.str;
    const [x, y] = viewport.convertToViewportPoint(item.transform[4]!, item.transform[5]!);

    if (lastY !== undefined && Math.abs(lastY - y) > LINE_THRESHOLD) {
      const lastItem = out.length ? out[out.length - 1] : undefined;
      const itemStartsLine = str.startsWith("\n") || (str.trim() === "" && item.hasEOL);
      if (lastItem?.endsWith("\n") === false && !itemStartsLine && Math.abs(lastY - y) - 1 > lineHeight) {
        out.push("\n");
        lineHeight = 0;
      }
    }
    if (lastY !== undefined && Math.abs(lastY - y) < LINE_THRESHOLD && lastX !== undefined && Math.abs(lastX - x) > CELL_THRESHOLD) {
      str = `${CELL_SEPARATOR}${str}`;
    }

    out.push(str);
    lastX = x + item.width;
    lastY = y;
    lineHeight = Math.max(lineHeight, item.height);
    if (item.hasEOL) out.push("\n");
    if (item.hasEOL || str.endsWith("\n")) lineHeight = 0;
  }
  return out.join("");
}
