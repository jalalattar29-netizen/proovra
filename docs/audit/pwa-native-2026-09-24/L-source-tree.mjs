/**
 * L — RECURSIVE SOURCE COMPONENT-TREE EXTRACTOR  (AUDIT INSTRUMENT — read-only)
 *
 * The audit's earlier control inventory stopped at one file. That is exactly
 * what this audit was told not to do: `apps/web/app/(app)/cases/page.tsx` is 20
 * lines and renders nothing itself, and `home/page.tsx` is 108 lines with six
 * imports. A per-file reading of either reports an empty surface.
 *
 * So this resolves the tree the way the renderer does:
 *   1. parse a file with the TypeScript AST (not regex),
 *   2. collect every JSX element it renders, with line, conditional context,
 *      className/style/handler attributes,
 *   3. for every JSX tag whose name is an identifier imported from a LOCAL
 *      module, resolve that module and recurse into it,
 *   4. stop at cycles, at node_modules, and at a depth bound that is reported
 *      rather than hidden.
 *
 * "Renders" is deliberately narrower than "imports": a module imported for a
 * type or a helper is not part of the element tree and is not recursed into.
 * Imported-and-rendered is the edge that matters.
 *
 * Output is DATA. Pairing and judgement happen elsewhere — this file makes no
 * claim about parity.
 */
import { readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

/**
 * typescript is not resolvable from docs/ under pnpm strict layout, so it is
 * resolved from a workspace package that declares it and loaded by path. Adding
 * a dependency just to make an audit script resolve would change the tree being
 * audited.
 */
const REPO_HINT = resolve(process.env.PROOVRA_AUDIT_REPO ?? resolve(import.meta.dirname, "..", "..", ".."));
const require_ = createRequire(join(REPO_HINT, "apps/mobile/package.json"));
const ts = require_("typescript");

const REPO = resolve(process.env.PROOVRA_AUDIT_REPO ?? resolve(import.meta.dirname, "..", "..", ".."));
const rel = (abs) => relative(REPO, abs).split(sep).join("/");

const UI_PKG = join(REPO, "packages/ui/src/index.ts");
const EXTS = ["", ".tsx", ".ts", "/index.tsx", "/index.ts"];

/** Resolve an import specifier to a real file in this repo, or null. */
export function resolveSpecifier(spec, fromFile) {
  if (spec === "@proovra/ui") return existsSync(UI_PKG) ? UI_PKG : null;
  if (spec.startsWith("@proovra/")) {
    const pkg = spec.split("/")[1];
    for (const cand of [
      join(REPO, "packages", pkg, "src/index.ts"),
      join(REPO, "packages", pkg, "src/index.tsx"),
    ]) if (existsSync(cand)) return cand;
    return null;
  }
  if (!spec.startsWith(".")) return null; // node_modules / react-native — not our source
  const base = resolve(dirname(fromFile), spec);
  for (const e of EXTS) {
    const cand = base + e;
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

const srcCache = new Map();
function parse(file) {
  if (srcCache.has(file)) return srcCache.get(file);
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const v = { sf, text };
  srcCache.set(file, v);
  return v;
}

const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** Attribute value as source text, trimmed. */
function attrText(sf, attr) {
  if (!attr.initializer) return "true";
  if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
  if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
    return attr.initializer.expression.getText(sf).replace(/\s+/g, " ").trim();
  }
  return attr.initializer.getText(sf).replace(/\s+/g, " ").trim();
}

/**
 * Literal text directly inside an element (not its nested components). Used to
 * pair elements across platforms by their visible words. Interpolated segments
 * become `{…}` so a label that is computed at runtime is visibly not a literal
 * rather than silently blank.
 */
function jsxText(openNode) {
  const parent = openNode.parent;
  if (!parent || !ts.isJsxElement(parent)) return "";
  const parts = [];
  for (const c of parent.children) {
    if (ts.isJsxText(c)) {
      const t = c.text.trim();
      if (t) parts.push(t);
    } else if (ts.isJsxExpression(c) && c.expression) {
      const raw = c.expression.getText().replace(/\s+/g, " ").trim();
      if (ts.isStringLiteral(c.expression)) parts.push(c.expression.text);
      else if (raw.length < 60) parts.push(`{${raw}}`);
      else parts.push("{…}");
    }
  }
  return parts.join(" ").slice(0, 160);
}

const HANDLER_RE = /^on[A-Z]/;
const STYLE_ATTRS = new Set(["className", "style", "sx", "contentContainerStyle", "titleStyle", "labelStyle", "imageStyle"]);

/**
 * Elements rendered by one file, plus which local modules it imports.
 */
export function analyseFile(file) {
  const { sf } = parse(file);
  /** imported identifier -> specifier */
  const importedFrom = new Map();
  const elements = [];
  const localComponents = new Set();
  const styleSheets = [];

  function conditionalDepth(node) {
    // Is this JSX inside a ternary or && guard?
    let n = node.parent;
    const guards = [];
    while (n) {
      if (ts.isConditionalExpression(n)) guards.push("ternary");
      else if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) guards.push("guard");
      else if (ts.isCallExpression(n) && n.expression.getText(sf).endsWith(".map")) guards.push("list");
      n = n.parent;
    }
    return guards;
  }

  (function walk(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const c = node.importClause;
      if (c) {
        if (c.name) importedFrom.set(c.name.text, spec);
        if (c.namedBindings) {
          if (ts.isNamedImports(c.namedBindings)) {
            for (const el of c.namedBindings.elements) importedFrom.set(el.name.text, spec);
          } else if (ts.isNamespaceImport(c.namedBindings)) {
            importedFrom.set(c.namedBindings.name.text, spec);
          }
        }
      }
    }

    // component declarations in this file
    if ((ts.isFunctionDeclaration(node) || ts.isVariableStatement(node)) && node.getText(sf).includes("return")) {
      if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text)) localComponents.add(node.name.text);
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && /^[A-Z]/.test(d.name.text)) localComponents.add(d.name.text);
        }
      }
    }

    // StyleSheet.create({...}) — native
    if (ts.isCallExpression(node) && node.expression.getText(sf) === "StyleSheet.create" && node.arguments[0]) {
      styleSheets.push({ line: lineOf(sf, node), text: node.arguments[0].getText(sf) });
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      const rec = {
        tag,
        line: lineOf(sf, node),
        guards: conditionalDepth(node),
        styleAttrs: {},
        handlers: {},
        otherAttrs: {},
        /**
         * The element's own literal text. Pairing a web `<button>Archive</button>`
         * with a native `<ProovraButton label="Archive" />` is only possible if
         * the visible words are captured on both sides — the tag names never
         * match across platforms, but the labels do.
         */
        text: jsxText(node),
      };
      for (const a of node.attributes.properties) {
        if (!ts.isJsxAttribute(a) || !a.name) continue;
        const name = a.name.getText(sf);
        const val = attrText(sf, a);
        if (STYLE_ATTRS.has(name)) rec.styleAttrs[name] = val;
        else if (HANDLER_RE.test(name)) rec.handlers[name] = val.slice(0, 200);
        else rec.otherAttrs[name] = val.slice(0, 120);
      }
      elements.push(rec);
    }
    ts.forEachChild(node, walk);
  })(sf);

  return { file: rel(file), elements, importedFrom, localComponents, styleSheets, reExports: reExportsOf(sf), redirectTarget: redirectTargetOf(sf), clientRedirect: clientRedirectOf(sf) };
}

/**
 * BARREL RE-EXPORTS. `components/ui/index.ts` is 14 export statements and zero
 * JSX, so a tree that stops at it reports PageShell, FilterBar and
 * CreateCaseModal as rendering nothing — which is how a whole page's layout
 * primitives go uninspected. This maps an exported NAME to the module that
 * actually defines it, so the walk can continue to the implementation.
 *
 *   export { A, B as C } from "./x"   -> A->./x, C->./x
 *   export * from "./y"               -> recorded as a wildcard to search
 */
function reExportsOf(sf) {
  const named = new Map();
  const wildcards = [];
  let defaultFrom = null;
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    if (!st.exportClause) { wildcards.push(spec); continue; }
    if (ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        named.set(el.name.text, spec);
        // `export { default } from "../inbox/page"` — /notifications IS /inbox.
        if (el.name.text === "default") defaultFrom = spec;
      }
    }
  }
  return { named, wildcards, defaultFrom };
}

/**
 * A page whose whole body is `redirect("/x")` renders NOTHING. Eight applicable
 * routes are exactly that. Reporting them as "0 elements, 0 missing" would be
 * true and useless; what a reader needs is that the surface lives at the
 * target, and that Native must be compared against THAT.
 */
function redirectTargetOf(sf) {
  let target = null;
  (function w(n) {
    if (target) return;
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "redirect" && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      target = n.arguments[0].text;
      return;
    }
    ts.forEachChild(n, w);
  })(sf);
  return target;
}

/**
 * A CLIENT redirect — `router.replace(...)` inside an effect — renders a real
 * (tiny) placeholder before navigating. Two applicable routes are retired
 * shims of this shape. Without detecting it the register shows "web 2 elements,
 * native 159" and reads as Native having MORE, when in truth the web surface
 * moved and the shim is all that is left.
 */
function clientRedirectOf(sf) {
  let target = null;
  (function w(n) {
    if (target) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      if (/^router\.(replace|push)$/.test(callee) && n.arguments[0]) {
        target = n.arguments[0].getText(sf).replace(/\s+/g, " ").slice(0, 120);
        return;
      }
    }
    ts.forEachChild(n, w);
  })(sf);
  return target;
}

/**
 * Follow `name` through a barrel to the file that defines it. Returns the
 * resolved absolute path, or null when it cannot be decided statically.
 */
export function resolveThroughBarrel(name, barrelAbs, depth = 0) {
  if (depth > 6) return null;
  const a = analyseFile(barrelAbs);
  const spec = a.reExports.named.get(name);
  if (spec) {
    const next = resolveSpecifier(spec, barrelAbs);
    if (!next) return null;
    const na = analyseFile(next);
    if (na.reExports.named.has(name)) return resolveThroughBarrel(name, next, depth + 1);
    return next;
  }
  for (const w of a.reExports.wildcards) {
    const next = resolveSpecifier(w, barrelAbs);
    if (!next) continue;
    const na = analyseFile(next);
    if (na.localComponents.has(name)) return next;
    const deeper = resolveThroughBarrel(name, next, depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * Build the rendered tree from an entry file.
 * `maxDepth` is reported in the result so a truncated branch is visible.
 */
export function buildTree(entryAbs, maxDepth = 8) {
  const visited = new Map();
  const truncated = [];
  let nodeCount = 0;

  function visit(abs, depth, viaTag) {
    const key = rel(abs);
    if (visited.has(key)) return { file: key, repeated: true, viaTag };
    if (depth > maxDepth) {
      truncated.push({ file: key, depth, viaTag });
      return { file: key, truncatedAtDepth: depth, viaTag };
    }
    const a = analyseFile(abs);
    visited.set(key, true);
    nodeCount++;

    // which rendered tags come from local modules?
    const childFiles = new Map();
    for (const el of a.elements) {
      const root = el.tag.split(".")[0];
      if (!/^[A-Z]/.test(root)) continue; // host element (div, View) — not a module
      const spec = a.importedFrom.get(root);
      if (!spec) continue;
      let resolved = resolveSpecifier(spec, abs);
      if (!resolved) continue;
      // If the target is a barrel that only re-exports, follow the NAME to the
      // module that defines it — otherwise the walk stops at an index.ts with
      // no JSX and the primitive is never inspected.
      const target = analyseFile(resolved);
      if (target.elements.length === 0 && (target.reExports.named.size > 0 || target.reExports.wildcards.length > 0)) {
        const through = resolveThroughBarrel(root, resolved);
        if (through) resolved = through;
      }
      if (!childFiles.has(resolved)) childFiles.set(resolved, new Set());
      childFiles.get(resolved).add(el.tag);
    }

    const children = [];
    for (const [cf, tags] of childFiles) {
      children.push(visit(cf, depth + 1, [...tags].join(",")));
    }

    return {
      file: key,
      viaTag,
      depth,
      elementCount: a.elements.length,
      elements: a.elements,
      styleSheets: a.styleSheets,
      children,
    };
  }

  /**
   * An entry that only re-exports a default is the SAME surface as its target
   * (`/notifications` is literally `export { default } from "../inbox/page"`).
   * Not following it reports an empty tree for a fully-built page.
   */
  let realEntry = entryAbs;
  const followed = [];
  for (let i = 0; i < 4; i++) {
    const a = analyseFile(realEntry);
    if (a.elements.length > 0 || !a.reExports.defaultFrom) break;
    const next = resolveSpecifier(a.reExports.defaultFrom, realEntry);
    if (!next) break;
    followed.push({ from: rel(realEntry), to: rel(next) });
    realEntry = next;
  }
  const entryInfo = analyseFile(realEntry);

  const root = visit(realEntry, 0, "(entry)");
  return {
    root, filesVisited: visited.size, nodeCount, truncated,
    followedDefaultExports: followed,
    redirectTarget: entryInfo.redirectTarget,
    clientRedirect: entryInfo.clientRedirect,
    resolvedEntry: rel(realEntry),
  };
}

/** Flatten a tree into one element list carrying provenance. */
export function flatten(tree) {
  const out = [];
  (function w(n) {
    if (!n || n.repeated || n.truncatedAtDepth) return;
    for (const el of n.elements ?? []) out.push({ ...el, file: n.file, depth: n.depth });
    for (const c of n.children ?? []) w(c);
  })(tree.root);
  return out;
}

/* ------------------------------------------------------------------ CLI */

/** Only act as a CLI when run directly — importing this module must not run it. */
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN && process.argv[2]) {
  const entry = resolve(REPO, process.argv[2]);
  const t = buildTree(entry, Number(process.argv[3] ?? 8));
  const flat = flatten(t);
  console.log("entry          :", rel(entry));
  console.log("files visited  :", t.filesVisited);
  console.log("elements total :", flat.length);
  console.log("truncated      :", t.truncated.length);
  const byFile = {};
  for (const e of flat) byFile[e.file] = (byFile[e.file] || 0) + 1;
  for (const [f, n] of Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log("  ", String(n).padStart(4), f);
  }
  if (process.env.DUMP) writeFileSync(process.env.DUMP, JSON.stringify({ tree: t, flat }, null, 1));
}
