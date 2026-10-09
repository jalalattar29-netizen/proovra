/**
 * Print the text of a PDF (argv[2]) with the worker's OWN text extractor — the
 * one PDF.js runtime (services/worker/src/pdf/pdfjs-runtime.ts) the
 * rendered-report gate reads. Run with cwd = services/worker and `--import tsx`
 * so the TypeScript module and its pinned pdfjs-dist resolve from the worker.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { extractPdfTextWithPdfjs } = await import(
  pathToFileURL(resolve(process.cwd(), "src/pdf/pdfjs-runtime.ts")).href
);
process.stdout.write(await extractPdfTextWithPdfjs(readFileSync(process.argv[2])));
