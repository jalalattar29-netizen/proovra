/**
 * PDF.js API/WORKER INTEGRITY GATE (2026-10-09).
 *
 *   node services/worker/scripts/check-pdfjs-integrity.mjs
 *
 * Production failed every report with "The API version 5.4.296 does not match
 * the Worker version 5.6.205": the worker shipped two PDF.js builds (its own
 * pdfjs-dist and the copy pdf-parse bundles), and in one process whichever
 * parsed a PDF first claimed the process-wide worker handler. This gate fails
 * CI if the worker could pair incompatible PDF.js API and worker versions again:
 *
 *   1. the worker pins pdfjs-dist to ONE exact version (no range);
 *   2. the lockfile resolves exactly one pdfjs-dist, at that version;
 *   3. no package known to bundle its own PDF.js is in the lockfile;
 *   4. worker source imports PDF.js only through src/pdf/pdfjs-runtime.ts, and
 *      nothing imports pdf-parse;
 *   5. when installed: the resolved pdfjs-dist, its API build (pdf.mjs) and its
 *      worker build (pdf.worker.mjs) all state that exact version, and no
 *      PDF.js worker file is copied into the worker's sources or build output.
 *
 * Exit 0 = intact; exit 1 = every violation printed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Overridable only so the gate's own test can run it against a defective fixture tree.
const workerDir = resolve(process.env.PDFJS_GATE_WORKER_DIR || resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const repoDir = resolve(process.env.PDFJS_GATE_REPO_DIR || resolve(workerDir, "..", ".."));
const RUNTIME = "src/pdf/pdfjs-runtime.ts";
/** Packages that ship their own PDF.js inside their dist. */
const PDFJS_BUNDLERS = ["pdf-parse", "pdf2json", "react-pdf", "pdfjs"];

const violations = [];
const fail = (msg) => violations.push(msg);

// 1. one exact pin
const pkg = JSON.parse(readFileSync(join(workerDir, "package.json"), "utf8"));
const pin = pkg.dependencies?.["pdfjs-dist"];
if (!pin) fail("services/worker/package.json does not depend on pdfjs-dist");
else if (!/^\d+\.\d+\.\d+$/.test(pin)) fail(`pdfjs-dist is not pinned exactly (found "${pin}")`);
for (const b of PDFJS_BUNDLERS) {
  if (pkg.dependencies?.[b] || pkg.devDependencies?.[b]) fail(`services/worker depends on ${b}, which bundles its own PDF.js`);
}

// 2 + 3. the lockfile
const lock = readFileSync(join(repoDir, "pnpm-lock.yaml"), "utf8");
const resolved = [...new Set([...lock.matchAll(/^ {2}'?pdfjs-dist@([^:'(]+)'?:/gm)].map((m) => m[1]))];
if (resolved.length !== 1) fail(`pnpm-lock.yaml resolves ${resolved.length} pdfjs-dist versions: ${resolved.join(", ") || "none"}`);
else if (pin && resolved[0] !== pin) fail(`pnpm-lock.yaml resolves pdfjs-dist ${resolved[0]}, package.json pins ${pin}`);
for (const b of PDFJS_BUNDLERS) {
  if (new RegExp(`^ {2}'?${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@`, "m").test(lock)) {
    fail(`pnpm-lock.yaml contains ${b}, which bundles its own PDF.js`);
  }
}

// 4. source imports
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
for (const file of walk(join(workerDir, "src")).filter((f) => /\.(m?[jt]s)$/.test(f))) {
  const rel = relative(workerDir, file).replace(/\\/g, "/");
  const src = readFileSync(file, "utf8");
  if (/from\s+["']pdf-parse["']|import\(\s*["']pdf-parse["']\s*\)|require\(\s*["']pdf-parse["']\s*\)/.test(src)) {
    fail(`${rel} imports pdf-parse`);
  }
  if (rel !== RUNTIME && !rel.endsWith(".d.ts") && /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']pdfjs-dist(?:\/[^"']*)?["']/.test(src)) {
    fail(`${rel} imports pdfjs-dist directly; use ${RUNTIME}`);
  }
}

// 5. the installed build, when there is one
const req = createRequire(join(workerDir, "package.json"));
let installedDir = null;
try {
  installedDir = dirname(req.resolve("pdfjs-dist/package.json"));
} catch {
  console.log("pdfjs-dist is not installed here; skipping the installed-build checks.");
}
if (installedDir) {
  const installed = JSON.parse(readFileSync(join(installedDir, "package.json"), "utf8")).version;
  if (pin && installed !== pin) fail(`installed pdfjs-dist is ${installed}, package.json pins ${pin}`);
  for (const f of ["legacy/build/pdf.mjs", "legacy/build/pdf.worker.mjs"]) {
    const head = readFileSync(join(installedDir, f), "utf8").slice(0, 4096);
    const v = /pdfjsVersion = ([\d.]+)/.exec(head)?.[1];
    if (v !== installed) fail(`${f} states PDF.js ${v ?? "unknown"}, package is ${installed}`);
  }
}
for (const dir of ["src", "dist"]) {
  for (const file of walk(join(workerDir, dir))) {
    if (/pdf\.worker(\.min)?\.m?js$/.test(file)) fail(`a copied PDF.js worker file is shipped: ${relative(workerDir, file)}`);
  }
}

if (violations.length) {
  for (const v of violations) console.error(`PDFJS_INTEGRITY: ${v}`);
  process.exit(1);
}
console.log(`PDF.js integrity OK: pdfjs-dist ${pin} is the worker's only PDF.js (API and worker build).`);
