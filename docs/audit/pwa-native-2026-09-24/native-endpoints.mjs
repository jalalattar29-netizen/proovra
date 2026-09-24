/**
 * NATIVE ENDPOINT EXTRACTOR  (AUDIT INSTRUMENT — read-only)
 *
 * WHY THIS EXISTS. The runtime capability map records 258 MOBILE consumer
 * sites and NONE in `apps/mobile/src/product/evidence-detail.ts` — a module
 * defining 22 `/v1/...` path builders the screens call. The map detects a
 * call site by the literal path AT the call, so every native call routed
 * through a builder module is invisible to it. An inverse-coverage join built
 * on that map reports capabilities as ABSENT that are demonstrably present:
 * Archive / Unarchive / Unlock on `/evidence/[id]` are implemented
 * (`buildEvidenceArchivePath`) and were reported missing.
 *
 * Builders COMPOSE — `buildEvidenceArchivePath` returns
 * `${buildEvidencePath(id)}/archive` — so a literal scan finds the base path
 * and loses every leaf. This resolves the composition to a fixed point before
 * normalising, which is the same lesson the contract audit already records.
 *
 * Used ONLY in the direction it is sound: deciding whether native calls a
 * given endpoint AT ALL. It over-approximates which SCREEN reaches it.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const REPO = resolve("D:/digital-witness");
const MOBILE = join(REPO, "apps/mobile");
const OUT = resolve(import.meta.dirname, ".");

const files = [];
const skip = new Set(["node_modules", ".expo", "dist", "coverage", "android", "ios", "build", "tools"]);
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    if (skip.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(tsx?|mjs|js)$/.test(e.name)) files.push(full);
  }
})(MOBILE);

const rel = (abs) => relative(REPO, abs).split(sep).join("/");
const TEST = /(\/test\/|\.test\.|\.spec\.|__tests__|\/e2e\/)/;
const sources = files.map(rel).filter((r) => !TEST.test(r));

/* ------------------------------------------------- builder template table */

/** name -> raw returned template (may contain ${buildOther(...)}) */
const builders = new Map();
const fileOfBuilder = new Map();

for (const r of sources) {
  const src = readFileSync(join(REPO, r), "utf8");
  // export function buildX(...): string { return `...`; }
  for (const m of src.matchAll(
    /(?:export\s+)?(?:function|const)\s+([A-Za-z0-9_]*(?:[Pp]ath|Url|Endpoint)[A-Za-z0-9_]*)\s*(?:=\s*)?\([^)]*\)[^{=]*(?:=>)?\s*\{?\s*return\s+`([^`]*)`/g,
  )) {
    if (!builders.has(m[1])) {
      builders.set(m[1], m[2]);
      fileOfBuilder.set(m[1], r);
    }
  }
  // arrow one-liners: const buildX = (a) => `...`
  for (const m of src.matchAll(
    /(?:export\s+)?const\s+([A-Za-z0-9_]*(?:[Pp]ath|Url|Endpoint)[A-Za-z0-9_]*)\s*=\s*\([^)]*\)\s*(?::[^=]*)?=>\s*`([^`]*)`/g,
  )) {
    if (!builders.has(m[1])) {
      builders.set(m[1], m[2]);
      fileOfBuilder.set(m[1], r);
    }
  }
}

/** Resolve `${buildOther(...)}` references to a fixed point. */
function resolveTemplate(tpl, depth = 0) {
  if (depth > 12) return tpl;
  let changed = false;
  const out = tpl.replace(/\$\{\s*([A-Za-z0-9_]+)\s*\([^}]*\)\s*\}/g, (whole, name) => {
    if (!builders.has(name)) return whole;
    changed = true;
    return builders.get(name);
  });
  return changed ? resolveTemplate(out, depth + 1) : out;
}

const resolvedBuilders = new Map();
for (const [name, tpl] of builders) resolvedBuilders.set(name, resolveTemplate(tpl));

/* ------------------------------------------------------------ normalise */

function normalise(p) {
  return p
    .replace(/\$\{[^}]*\}/g, ":param")
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":param")
    .replace(/\?.*$/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

/* ------------------------------------------- collect paths per source file */

const pathsByFile = new Map();
const add = (file, p) => {
  if (!p.startsWith("/v1/")) return;
  if (!pathsByFile.has(file)) pathsByFile.set(file, new Set());
  pathsByFile.get(file).add(normalise(p));
};

for (const r of sources) {
  const src = readFileSync(join(REPO, r), "utf8");
  for (const m of src.matchAll(/["'`](\/v1\/[^"'`\s]*)["'`]/g)) add(r, m[1]);
  for (const m of src.matchAll(/["'`](\/v1\/[^"'`]*)$/gm)) add(r, m[1]);
}
// every resolved builder counts as a path owned by its defining file
for (const [name, tpl] of resolvedBuilders) {
  if (tpl.startsWith("/v1/")) add(fileOfBuilder.get(name), tpl);
}

/* --------------------------------------------------------- method pairing */

const endpointSet = new Set();
const siteIndex = new Map();

for (const [file, paths] of pathsByFile) {
  const src = readFileSync(join(REPO, file), "utf8");
  const methods = new Set(["GET"]);
  for (const m of src.matchAll(/method\s*:\s*["'`](GET|POST|PATCH|PUT|DELETE|HEAD)["'`]/g)) methods.add(m[1]);
  for (const p of paths) {
    for (const mth of methods) {
      const id = `${mth} ${p}`;
      endpointSet.add(id);
      if (!siteIndex.has(id)) siteIndex.set(id, []);
      siteIndex.get(id).push(file);
    }
  }
}

const distinctPaths = new Set([...pathsByFile.values()].flatMap((s) => [...s]));

writeFileSync(
  join(OUT, "native-endpoints.json"),
  JSON.stringify(
    {
      filesScanned: sources.length,
      buildersResolved: resolvedBuilders.size,
      filesWithPaths: pathsByFile.size,
      distinctPaths: distinctPaths.size,
      endpointCandidates: endpointSet.size,
      paths: [...distinctPaths].sort(),
      pathsByFile: Object.fromEntries([...pathsByFile].map(([k, v]) => [k, [...v].sort()])),
      siteIndex: Object.fromEntries(siteIndex),
    },
    null,
    1,
  ),
);

console.log("files scanned        :", sources.length);
console.log("builders resolved    :", resolvedBuilders.size);
console.log("files with /v1 paths :", pathsByFile.size);
console.log("distinct paths       :", distinctPaths.size);
console.log("endpoint candidates  :", endpointSet.size);
console.log("\nevidence-detail.ts paths:");
for (const p of (pathsByFile.get("apps/mobile/src/product/evidence-detail.ts") ?? [])) console.log("   ", p);
