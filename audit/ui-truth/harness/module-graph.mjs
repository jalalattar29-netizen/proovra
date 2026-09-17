/**
 * PHASE UI-TRUTH — shared module graph for the label and data-truth harnesses
 * (AUDIT HARNESS, not product code).
 *
 * This is the SAME walk `controls.mjs` performs — owned files from
 * placement.json, plus the apps/web files they import, two hops — lifted into
 * one place so the label inventory and the data-element inventory see exactly
 * the file set the control inventory saw. It is a copy of that harness's graph
 * rather than an edit to it, because regenerating controls.json is not part of
 * this pass and its bytes must not move.
 *
 * Deterministic: sorted output, repo-relative forward-slash paths, no
 * timestamps, no absolute paths in anything returned.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

import { REPO } from "./surfaces.mjs";

const require = createRequire(import.meta.url);
/** The repo pins typescript through pnpm; resolve it without a package.json edit. */
export const ts = require(resolve(REPO, "node_modules/.pnpm/typescript@5.9.3/node_modules/typescript"));

export const rel = (p) => relative(REPO, p).split("\\").join("/");
export const abs = (p) => resolve(REPO, p);

/** Files we follow into. Product code only; never node_modules, never tests. */
const FOLLOWABLE = [/^apps\/web\//];
/** How far we follow imports out of an owned file. Same as controls.mjs. */
export const MAX_JSX_DEPTH = 2;

const EXTS = [".tsx", ".ts", ".jsx", ".js"];

const moduleCache = new Map();
const stopped = new Map();

function noteStop(spec, reason) {
  const key = `${spec}::${reason}`;
  stopped.set(key, { specifier: spec, reason, count: (stopped.get(key)?.count ?? 0) + 1 });
}

export function importsStoppedAt() {
  return [...stopped.values()]
    .map(({ specifier, reason, count }) => ({ specifier, reason, count }))
    .sort((a, b) => (`${a.specifier}|${a.reason}` < `${b.specifier}|${b.reason}` ? -1 : 1));
}

const isFollowable = (relPath) => FOLLOWABLE.some((re) => re.test(relPath));

function resolveImport(fromAbs, spec) {
  if (!spec.startsWith(".")) {
    noteStop(spec, spec.startsWith("@proovra/") ? "WORKSPACE_PACKAGE_NOT_FOLLOWED" : "EXTERNAL_MODULE_NOT_FOLLOWED");
    return null;
  }
  const base = resolve(dirname(fromAbs), spec);
  const candidates = [...EXTS.map((e) => base + e), ...EXTS.map((e) => join(base, "index" + e)), base];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) {
        const r = rel(c);
        if (!isFollowable(r)) {
          noteStop(spec, "OUTSIDE_APPS_WEB");
          return null;
        }
        return c;
      }
    } catch {
      /* next candidate */
    }
  }
  noteStop(spec, "UNRESOLVABLE_SPECIFIER");
  return null;
}

export function loadModule(absPath) {
  const key = rel(absPath);
  if (moduleCache.has(key)) return moduleCache.get(key);
  let text;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    moduleCache.set(key, null);
    return null;
  }
  const sf = ts.createSourceFile(key, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rec = { path: key, absPath, text, sf, specifiers: [] };
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      rec.specifiers.push(st.moduleSpecifier.text);
      continue;
    }
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    rec.specifiers.push(st.moduleSpecifier.text);
  }
  moduleCache.set(key, rec);
  return rec;
}

/** Owned files plus the apps/web files they import, to MAX_JSX_DEPTH hops. */
export function collectSurfaceFiles(ownedFiles) {
  const parsed = new Map(); // relPath -> depth
  const queue = [];
  for (const f of ownedFiles) {
    const a = abs(f);
    if (!existsSync(a)) continue;
    queue.push([a, 0]);
  }
  while (queue.length) {
    const [absPath, depth] = queue.shift();
    const key = rel(absPath);
    if (parsed.has(key) && parsed.get(key) <= depth) continue;
    parsed.set(key, depth);
    const rec = loadModule(absPath);
    if (!rec || depth >= MAX_JSX_DEPTH) continue;
    for (const spec of [...new Set(rec.specifiers)].sort()) {
      const t = resolveImport(rec.absPath, spec);
      if (t) queue.push([t, depth + 1]);
    }
  }
  return parsed;
}

export const lineOf = (node, sf) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

export function textOf(node, sf) {
  try {
    return node.getText(sf).replace(/\s+/g, " ").trim();
  } catch {
    return "UNRESOLVED_DYNAMIC";
  }
}

export function walk(node, fn) {
  fn(node);
  ts.forEachChild(node, (c) => walk(c, fn));
}

export function tagNameOf(el) {
  const opening = ts.isJsxElement(el) ? el.openingElement : el;
  const n = opening.tagName;
  return typeof n.text === "string" ? n.text : n.getText(opening.getSourceFile());
}

/** JSX text keeps HTML entities verbatim; a label must read as the user sees it. */
const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&rsquo;": "\u2019",
  "&lsquo;": "\u2018",
  "&mdash;": "\u2014",
  "&ndash;": "\u2013",
  "&hellip;": "\u2026",
  "&ldquo;": "\u201c",
  "&rdquo;": "\u201d",
  "&middot;": "\u00b7",
  "&times;": "\u00d7",
};
export const decodeEntities = (t) =>
  t.replace(/&(amp|lt|gt|quot|#39|apos|nbsp|rsquo|lsquo|mdash|ndash|hellip|ldquo|rdquo|middot|times);/g, (m) => ENTITIES[m]);

/** The 168 in-scope surfaces, with their owned files and endpoints. */
export function inScopeSurfaces(DATA) {
  const surfaces = JSON.parse(readFileSync(join(DATA, "surfaces.json"), "utf8")).surfaces.filter((s) => s.inScope);
  const placement = JSON.parse(readFileSync(join(DATA, "placement.json"), "utf8"));
  const byId = new Map(placement.rows.map((r) => [r.surfaceId, r]));
  return surfaces
    .map((s) => {
      const p = byId.get(s.surfaceId);
      return {
        surfaceId: s.surfaceId,
        route: s.route,
        file: s.file,
        area: s.area,
        ownedFiles: p ? p.ownedFiles : [s.file],
        endpoints: p ? p.endpoints : [],
      };
    })
    .sort((a, b) => (a.surfaceId < b.surfaceId ? -1 : 1));
}

/**
 * Who reads this surface. Derived from the surface's AREA in surfaces.json —
 * never from the URL text, and never from the file's own words.
 */
export function audienceOf(area) {
  if (area === "PLATFORM_ADMIN_NAMESPACE") return "PLATFORM_OPERATOR";
  if (area === "EXTERNAL_PORTAL") return "EXTERNAL_PORTAL";
  return "TENANT_USER";
}

export const tally = (rows, pick) => {
  const out = {};
  for (const r of rows) {
    const k = pick(r);
    if (k === null || k === undefined) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
};
