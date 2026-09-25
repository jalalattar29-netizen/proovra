/**
 * V4 INSTRUMENT — EXPORT-SCOPED EXTRACTION (read-only).
 *
 * WHY THIS EXISTS — a systematic false-positive found in the v3 pass.
 *
 * `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx` exports
 * NINE independent panels, each mounted on a DIFFERENT host page (its own header
 * says so: "Is mounted exactly once on its canonical host page"). Three of those
 * hosts are ENTERPRISE surfaces outside the applicable set.
 *
 * The v3 crawler walked whole files, so a route importing ONE export
 * (`EvidenceRequestEventsTab`) was charged with the elements of all nine — 90
 * occurrences of which most are unreachable from that route. The same artifact
 * inflates every multi-export module: `ui-legacy.tsx` (60),
 * `PersonalSecuritySections.tsx` (123), and the biggest single offender,
 * `CommandCenter.tsx` (248), which is enterprise-only and reachable from no
 * applicable route at all.
 *
 * This module resolves, per route, the set of (file, exportName) pairs actually
 * REACHED, and extracts only the subtree of those exported declarations plus the
 * local declarations they reference inside the same file.
 *
 * It does NOT guess. An export it cannot bind is reported, never dropped.
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolveImport, ROOT } from "./03-deep-extract.mjs";

const ts = createRequire(`${ROOT}/apps/mobile/package.json`)("typescript");

const sfCache = new Map();
function sourceFile(abs) {
  if (sfCache.has(abs)) return sfCache.get(abs);
  const text = readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true,
    /\.tsx$/.test(abs) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  sfCache.set(abs, sf);
  return sf;
}

/**
 * Index a module: exported name -> declaration node; plus every local
 * declaration, its import bindings, and its `export ... from` re-exports.
 */
const modCache = new Map();
export function moduleIndex(abs) {
  if (modCache.has(abs)) return modCache.get(abs);
  const sf = sourceFile(abs);
  const exports = new Map();      // exported name -> node
  const locals = new Map();       // local name -> node
  const imports = new Map();      // local name -> specifier
  const reExports = [];           // { name|null (star), specifier }
  let defaultExport = null;

  const isExported = (n) =>
    n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  const isDefault = (n) =>
    n.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;

  const visit = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name) {
      locals.set(n.name.text, n);
      if (isExported(n)) exports.set(isDefault(n) ? "default" : n.name.text, n);
    }
    if (ts.isClassDeclaration(n) && n.name) {
      locals.set(n.name.text, n);
      if (isExported(n)) exports.set(isDefault(n) ? "default" : n.name.text, n);
    }
    if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        locals.set(d.name.text, d.initializer ?? d);
        if (isExported(n)) exports.set(d.name.text, d.initializer ?? d);
      }
    }
    if (ts.isExportAssignment(n)) defaultExport = n.expression;
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text;
      const c = n.importClause;
      if (c?.name) imports.set(c.name.text, spec);
      if (c?.namedBindings) {
        if (ts.isNamedImports(c.namedBindings)) {
          for (const e of c.namedBindings.elements) imports.set(e.name.text, spec);
        } else if (ts.isNamespaceImport(c.namedBindings)) {
          imports.set(c.namedBindings.name.text, spec);
        }
      }
    }
    if (ts.isExportDeclaration(n)) {
      const spec = n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : null;
      if (n.exportClause && ts.isNamedExports(n.exportClause)) {
        for (const e of n.exportClause.elements) {
          reExports.push({ name: e.name.text, from: (e.propertyName ?? e.name).text, specifier: spec });
        }
      } else if (spec) {
        reExports.push({ name: null, from: null, specifier: spec }); // export * from
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (defaultExport) exports.set("default", defaultExport);

  const v = { sf, exports, locals, imports, reExports };
  modCache.set(abs, v);
  return v;
}

/** Identifiers referenced inside a node (for local-helper closure). */
function referencedNames(node, sf) {
  const out = new Set();
  const walk = (n) => {
    if (ts.isIdentifier(n)) out.add(n.text);
    else if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const t = n.tagName.getText(sf);
      out.add(t.split(".")[0]);
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return out;
}

/**
 * Walk the route's reachable graph at EXPORT granularity.
 * Returns Map<absFile, { used:Set<exportName>, nodes:Node[] }> plus diagnostics.
 */
export function scopedCrawl(entryAbs, { maxNodes = 40000 } = {}) {
  const reached = new Map();      // abs -> { used:Set, nodes:[] }
  const unbound = [];             // exports we could not bind
  const external = new Set();
  const seen = new Set();

  const want = (abs, name) => {
    if (!existsSync(abs)) return;
    const key = `${abs}::${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > maxNodes) return;

    const m = moduleIndex(abs);
    if (!reached.has(abs)) reached.set(abs, { used: new Set(), nodes: [] });
    const slot = reached.get(abs);

    // Explicit re-export:  export { X } from "./y"
    for (const r of m.reExports) {
      if (!r.specifier || r.name === null) continue;
      if (r.name === name) {
        const t = resolveImport(r.specifier, abs);
        if (t) { want(t, r.from ?? name); return; }
        external.add(r.specifier);
        return;
      }
    }

    // Star barrel:  export * from "./y".  `packages/shared/src/index.ts` has
    // ~40 of these. Probing every target and reporting each miss produced 96
    // phantom "unbound" rows on one route — the name IS exported by exactly one
    // target. Bind against the target that actually declares it; report unbound
    // only when NONE does.
    const stars = m.reExports.filter((r) => r.name === null && r.specifier);
    if (stars.length && !m.exports.has(name)) {
      let bound = false;
      for (const r of stars) {
        const t = resolveImport(r.specifier, abs);
        if (!t || !existsSync(t)) continue;
        const tm = moduleIndex(t);
        const hasIt = tm.exports.has(name) ||
          tm.reExports.some((x) => x.name === name) ||
          tm.reExports.some((x) => x.name === null);
        if (hasIt) { want(t, name); bound = true; break; }
      }
      if (bound) return;
    }

    const node = m.exports.get(name) ?? null;
    if (name === "*") {                             // namespace import: take all
      for (const [n, nd] of m.exports) { slot.used.add(n); slot.nodes.push(nd); expand(abs, nd, m); }
      return;
    }
    if (!node) {
      unbound.push({ file: abs.replace(ROOT + "/", ""), name });
      return;
    }
    slot.used.add(name);
    slot.nodes.push(node);
    expand(abs, node, m);
  };

  const expand = (abs, node, m) => {
    const refs = referencedNames(node, m.sf);
    for (const r of refs) {
      if (m.locals.has(r) && !m.exports.has(r)) {
        const slot = reached.get(abs);
        const nd = m.locals.get(r);
        if (!slot.nodes.includes(nd)) { slot.nodes.push(nd); expand(abs, nd, m); }
        continue;
      }
      if (m.locals.has(r) && m.exports.has(r)) {
        const slot = reached.get(abs);
        const nd = m.locals.get(r);
        if (!slot.nodes.includes(nd)) { slot.used.add(r); slot.nodes.push(nd); expand(abs, nd, m); }
        continue;
      }
      if (m.imports.has(r)) {
        const spec = m.imports.get(r);
        const t = resolveImport(spec, abs);
        if (t) want(t, r);
        else external.add(spec);
      }
    }
  };

  // The entry is a route file: its default export is what renders.
  want(entryAbs, "default");
  // Next.js route files may also export metadata/layout helpers that render nothing.
  return { reached, unbound, external: [...external] };
}

/** Extract elements/texts from ONLY the reached nodes of a file. */
export function extractScoped(abs, nodes) {
  const m = moduleIndex(abs);
  const sf = m.sf;
  const elements = [], texts = [];
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const TEXT_PROPS = new Set(["label", "title", "subtitle", "placeholder", "alt", "aria-label",
    "ariaLabel", "heading", "description", "accessibilityLabel", "confirmLabel", "cancelLabel", "actionLabel"]);

  const walk = (n) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName.getText(sf);
      const el = { tag, line: lineOf(n), props: {} };
      for (const a of n.attributes.properties) {
        if (!ts.isJsxAttribute(a)) continue;
        const nm = a.name.getText(sf);
        const init = a.initializer;
        let val = true, literal = false;
        if (init) {
          if (ts.isStringLiteral(init)) { val = init.text; literal = true; }
          else if (ts.isJsxExpression(init) && init.expression) {
            if (ts.isStringLiteral(init.expression)) { val = init.expression.text; literal = true; }
            else if (ts.isNoSubstitutionTemplateLiteral(init.expression)) { val = init.expression.text; literal = true; }
            else val = init.expression.getText(sf).replace(/\s+/g, " ").slice(0, 200);
          }
        }
        el.props[nm] = { v: val, literal };
        if (TEXT_PROPS.has(nm) && literal) texts.push({ v: String(val).replace(/\s+/g, " ").trim(), kind: `prop:${nm}`, line: lineOf(a) });
      }
      elements.push(el);
    }
    if (ts.isJsxText(n)) {
      const v = n.text.replace(/\s+/g, " ").trim();
      if (v) texts.push({ v, kind: "jsxText", line: lineOf(n) });
    }
    ts.forEachChild(n, walk);
  };
  for (const nd of nodes) walk(nd);
  /* Normalise to a repo-relative POSIX path. Node's `resolve()` yields Windows
   * backslashes here, so a bare `replace(ROOT + "/", "")` left absolute
   * `D:\digital-witness\...` strings — which silently defeated every
   * path-based rule downstream (the enterprise/shell exclusions matched
   * nothing). */
  const rel = abs.split("\\").join("/").replace(`${ROOT}/`, "");
  return { file: rel, elements, texts };
}

/* ======================================================================= main */
if (process.argv[1] && process.argv[1].endsWith("10-scoped-extract.mjs")) {
  const probe = process.argv[2] ?? "apps/web/app/(app)/evidence-requests/[id]/page.tsx";
  const { reached, unbound, external } = scopedCrawl(`${ROOT}/${probe}`);
  let els = 0, txt = 0;
  const perFile = [];
  for (const [abs, slot] of reached) {
    const ex = extractScoped(abs, slot.nodes);
    els += ex.elements.length; txt += ex.texts.length;
    perFile.push({ f: ex.file, used: [...slot.used], els: ex.elements.length });
  }
  console.log("probe:", probe);
  console.log("files reached:", reached.size, "| elements:", els, "| texts:", txt);
  console.log("unbound exports:", unbound.length, "| external:", external.length);
  perFile.sort((a, b) => b.els - a.els);
  console.log("top files (scoped):");
  for (const p of perFile.slice(0, 10)) console.log(`  ${String(p.els).padStart(4)}  ${p.f}  used=[${p.used.slice(0, 4).join(",")}]`);
}
