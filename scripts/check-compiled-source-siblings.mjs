#!/usr/bin/env node
/**
 * GATE — no compiled JavaScript beside TypeScript source, and none left over.
 *
 * Every package compiles to its own `dist/` (services/api, services/worker and
 * packages/* all set `outDir: "dist"`). A `.js` file under a source root is
 * therefore never authored code when either
 *   1. it sits beside a `.ts`/`.tsx` of the same name (an in-place build), or
 *   2. git does not track it (an old build's orphan — its `.ts` was deleted
 *      or renamed, and gitignore hides the leftover).
 * Both are loadable: Node and Vite resolve the NodeNext specifier `./x.js` to
 * them, and reachability analysers count them as product modules.
 *
 * Exits non-zero, listing every offender, when one exists. Untracked and
 * gitignored files are checked too: ignoring a stale file hides it from git,
 * not from the module resolver.
 */
import { execFileSync } from "node:child_process";
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

/** Files git tracks under the roots, or null when git is unavailable here. */
function trackedFiles(root, sourceRoots) {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", ...sourceRoots], { cwd: root, encoding: "utf8" });
    return new Set(out.split("\0").filter(Boolean).map((f) => path.normalize(f)));
  } catch {
    return null;
  }
}

export function findCompiledSiblings(root = ROOT, sourceRoots = SOURCE_ROOTS, tracked = trackedFiles(root, sourceRoots)) {
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
      const rel = path.relative(root, full);
      const base = full.slice(0, -m[0].length);
      const siblings = m[1] === "mjs" ? [".mts"] : [".ts", ".tsx"];
      const isSibling = siblings.some((ext) => existsSync(base + ext));
      const isUntracked = tracked !== null && !tracked.has(path.normalize(rel));
      if (isSibling || isUntracked) offenders.push(rel);
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
      `[compiled-source-siblings] ${offenders.length} compiled or untracked JavaScript file(s) under a source root would be loaded as product code:`,
    );
    for (const f of offenders) console.error(`  ${f}`);
    console.error("Delete them; builds write to dist/.");
    process.exit(1);
  }
  console.log("[compiled-source-siblings] OK — no compiled or untracked JavaScript under source roots.");
}
