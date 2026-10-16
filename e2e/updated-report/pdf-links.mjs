/**
 * Print the verification links a PDF (argv[2]) carries — annotations and the
 * printed text — with the worker's OWN reader (the one the orphaned-link
 * recovery uses). Run with cwd = services/worker and `--import tsx`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { extractPdfVerifyLinks } = await import(
  pathToFileURL(resolve(process.cwd(), "src/verification-link-recovery.ts")).href
);
process.stdout.write(JSON.stringify(await extractPdfVerifyLinks(readFileSync(process.argv[2]))));
