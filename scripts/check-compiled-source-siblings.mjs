#!/usr/bin/env node
/**
 * GATE — no compiled JavaScript beside TypeScript source.
 *
 * Every package compiles to its own `dist/` (services/api, services/worker and
 * packages/* all set `outDir: "dist"`). A `.js` file next to a `.ts` file of
 * the same name under a source directory is therefore never authored code: it
 * is the output of an old in-place build. Such a file is loadable — Node and
 * Vite resolve the NodeNext specifier `./x.js` to it before the TypeScript
 * source — so it silently replaces current code with stale code.
 *
 * Exits non-zero, listing every offender, when one exists. Untracked and
 * gitignored files are checked too: ignoring a stale file hides it from git,
 * not from the module resolver.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOTS = [
  "services/api/src",
  "services/worker/src",
  "packages/shared/src",
  "packages/shared-billing/src",
  "packages/shared-evidence-presentation/src",
  "packages/shared-runtime/src",
  "packages/ui/src",
  "apps/mobile/src",
];
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".turbo", "coverage"]);
const JS = /\.(m?js)$/;

export function findCompiledSiblings(root = ROOT, sourceRoots = SOURCE_ROOTS) {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const m = JS.exec(name);
      if (!m) continue;
      const base = full.slice(0, -m[0].length);
      const siblings = m[1] === "mjs" ? [".mts"] : [".ts", ".tsx"];
      if (siblings.some((ext) => existsSync(base + ext))) offenders.push(path.relative(root, full));
    }
  };
  for (const rel of sourceRoots) {
    const dir = path.join(root, rel);
    if (existsSync(dir)) walk(dir);
  }
  return offenders.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const offenders = findCompiledSiblings();
  if (offenders.length > 0) {
    console.error(
      `[compiled-source-siblings] ${offenders.length} compiled file(s) sit beside their TypeScript source and would be loaded instead of it:`,
    );
    for (const f of offenders) console.error(`  ${f}`);
    console.error("Delete them; builds write to dist/.");
    process.exit(1);
  }
  console.log("[compiled-source-siblings] OK — no compiled JavaScript beside TypeScript source.");
}
