#!/usr/bin/env node
/**
 * Read an output the stack produced, for the free-evidence journey:
 *   node extract.mjs pdf <file>   -> the PDF's text (pdfjs-dist, the worker's own copy)
 *   node extract.mjs zip <file>   -> JSON {entries, texts} (jszip, the web app's own copy)
 * Run as a child process so the Playwright transform never touches the ESM build.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const [cmd, file] = process.argv.slice(2);
const bytes = readFileSync(file);

if (cmd === "pdf") {
  const pdfjs = await import(
    pathToFileURL(resolve(ROOT, "services/worker/node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href
  );
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    out.push(tc.items.map((it) => ("str" in it ? it.str : "")).join(" "));
  }
  process.stdout.write(JSON.stringify({ pages: doc.numPages, text: out.join("\n") }));
} else if (cmd === "zip") {
  const require = createRequire(resolve(ROOT, "apps/web/package.json"));
  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const texts = {};
  for (const n of entries) {
    if (/\.(json|txt|sig|pem)$/i.test(n)) texts[n] = await zip.files[n].async("string");
  }
  process.stdout.write(JSON.stringify({ entries, texts }));
} else {
  console.error("usage: extract.mjs pdf|zip <file>");
  process.exit(2);
}
