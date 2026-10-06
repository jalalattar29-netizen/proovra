/**
 * Print the text of a PDF (argv[2]) using the worker's own pdf-parse. Run with
 * cwd = services/worker so the dependency resolves from the worker package.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), "package.json"));
const mod = require("pdf-parse");
const data = readFileSync(process.argv[2]);

let text;
if (typeof mod.PDFParse === "function") {
  const parser = new mod.PDFParse({ data });
  text = (await parser.getText()).text;
  await parser.destroy?.();
} else {
  const fn = typeof mod === "function" ? mod : mod.default;
  text = (await fn(data)).text;
}
process.stdout.write(text);
