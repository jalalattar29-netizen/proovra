/**
 * V3 INSTRUMENT — DEEP RECURSIVE EXTRACTOR (read-only).
 *
 * For every applicable route, on BOTH platforms, resolve the complete component
 * tree through real module resolution (relative, workspace alias, barrel,
 * `export { default } from`, index files) and extract, per file:
 *
 *   elements     every JSX opening element: tag, line, and the props that carry
 *                user-visible meaning (className/style/aria-label/placeholder/
 *                title/href/alt/src/label/tone/variant) plus its handler props
 *   texts        every JSX text node + every user-visible string-literal prop
 *   handlers     onClick/onPress/onSubmit/onChange/... with the callee name
 *   conditionals ternary / && / .map guards (the conditional-state inventory)
 *   apiPaths     /v1/... literals and template heads, plus apiFetch/fetch callees
 *   assets       image/svg/font imports and require()s
 *   styleRefs    className token lists, inline style object keys,
 *                StyleSheet.create rule -> property map, theme.* token reads
 *
 * Emits one JSON per route per platform into routes-raw/. Prints counts only.
 *
 * NOTHING IS WRITTEN OUTSIDE docs/audit/pwa-native-2026-09-24-v2/.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve, join, relative } from "node:path";
import { createRequire } from "node:module";

const _req = createRequire("D:/digital-witness/apps/mobile/package.json");
const ts = _req("typescript");

export const ROOT = "D:/digital-witness";
const OUT = `${ROOT}/docs/audit/pwa-native-2026-09-24-v2`;
const RAW = `${OUT}/routes-raw`;
mkdirSync(RAW, { recursive: true });

const rel = (p) => relative(ROOT, p).split("\\").join("/");

/* ========================================================== module resolution */

const EXTS = [".tsx", ".ts", ".jsx", ".js", ".mjs"];
const ALIAS = {
  "@proovra/ui": `${ROOT}/packages/ui/src/index.ts`,
  "@proovra/shared": `${ROOT}/packages/shared/src/index.ts`,
  "@proovra/shared-runtime": `${ROOT}/packages/shared-runtime/src/index.ts`,
  "@proovra/shared-billing": `${ROOT}/packages/shared-billing/src/index.ts`,
  "@proovra/shared-evidence-presentation": `${ROOT}/packages/shared-evidence-presentation/src/index.ts`,
  "@proovra/shared-timestamping": `${ROOT}/packages/shared-timestamping/src/index.ts`,
};

/**
 * Try a path with each extension, then as a directory index.
 *
 * NOTE: `packages/shared` is authored with ESM-style `./foo.js` specifiers that
 * resolve to `./foo.ts` sources. Without stripping that extension the crawler
 * loses the whole shared-domain layer (measured: 183 unresolved on /home alone),
 * which would silently understate every downstream count.
 */
function tryFile(base) {
  const cands = [base];
  const m = base.match(/^(.*)\.(js|jsx|mjs)$/);
  if (m) cands.push(m[1]);
  for (const c of cands) {
    if (existsSync(c) && statSync(c).isFile() && /\.(tsx?|jsx?|mjs)$/.test(c)) return c;
    for (const e of EXTS) if (existsSync(c + e)) return c + e;
    for (const e of EXTS) {
      const ix = join(c, "index" + e);
      if (existsSync(ix)) return ix;
    }
  }
  return null;
}

/** Resolve an import specifier from `fromFile`. Returns abs path or null (external). */
export function resolveImport(spec, fromFile) {
  if (spec.startsWith(".")) return tryFile(resolve(dirname(fromFile), spec));
  for (const [k, v] of Object.entries(ALIAS)) {
    if (spec === k) return tryFile(v);
    if (spec.startsWith(k + "/")) {
      const pkgRoot = v.replace(/\/src\/index\.ts$/, "/src");
      return tryFile(join(pkgRoot, spec.slice(k.length + 1)));
    }
  }
  // CSS / asset imports are recorded by the caller, not resolved here
  return null;
}

/* ============================================================ prop vocabulary */

const TEXT_PROPS = new Set([
  "label", "title", "subtitle", "placeholder", "alt", "aria-label", "ariaLabel",
  "aria-describedby", "heading", "description", "helperText", "caption",
  "emptyLabel", "errorLabel", "accessibilityLabel", "accessibilityHint",
  "confirmLabel", "cancelLabel", "actionLabel", "badge", "tooltip", "name",
]);
const HANDLER_PROPS = /^on[A-Z]/;
const STYLE_PROPS = new Set(["className", "style", "tone", "variant", "size", "color", "weight"]);
const NAV_PROPS = new Set(["href", "to", "src", "action"]);

/* ================================================================= extraction */

function textOf(node, sf) {
  try { return node.getText(sf); } catch { return ""; }
}
function lineOf(node, sf) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

export function extractFile(file) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true,
    /\.tsx?$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.JS);

  const out = {
    file: rel(file),
    imports: [], cssImports: [], assetImports: [], reExports: [],
    elements: [], texts: [], handlers: [], conditionals: [],
    apiPaths: [], styleRefs: [], stylesheets: [], themeTokens: [],
  };

  const pushText = (value, kind, node) => {
    const v = String(value).replace(/\s+/g, " ").trim();
    if (!v) return;
    out.texts.push({ v, kind, line: lineOf(node, sf) });
  };

  const walk = (node) => {
    // ---- imports / re-exports
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const s = node.moduleSpecifier.text;
      if (/\.css$/.test(s)) out.cssImports.push(s);
      else if (/\.(png|jpe?g|gif|webp|svg|ttf|otf|woff2?)$/i.test(s)) out.assetImports.push(s);
      else out.imports.push(s);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.imports.push(node.moduleSpecifier.text);
      out.reExports.push(node.moduleSpecifier.text);
    }

    // ---- JSX elements
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = textOf(node.tagName, sf);
      const line = lineOf(node, sf);
      const el = { tag, line, props: {}, handlers: [] };
      for (const a of node.attributes.properties) {
        if (!ts.isJsxAttribute(a)) { el.props["{...spread}"] = true; continue; }
        const nm = a.name.getText(sf);
        const init = a.initializer;
        let val = true, literal = false;
        if (init) {
          if (ts.isStringLiteral(init)) { val = init.text; literal = true; }
          else if (ts.isJsxExpression(init) && init.expression) {
            if (ts.isStringLiteral(init.expression)) { val = init.expression.text; literal = true; }
            else if (ts.isNoSubstitutionTemplateLiteral(init.expression)) { val = init.expression.text; literal = true; }
            else val = textOf(init.expression, sf).replace(/\s+/g, " ").slice(0, 200);
          }
        }
        if (HANDLER_PROPS.test(nm)) {
          el.handlers.push(nm);
          out.handlers.push({ prop: nm, tag, line, expr: String(val).slice(0, 200), literal: false });
          continue;
        }
        el.props[nm] = { v: val, literal };
        if (TEXT_PROPS.has(nm) && literal) pushText(val, `prop:${nm}`, a);
        if (STYLE_PROPS.has(nm)) out.styleRefs.push({ tag, line, prop: nm, v: String(val).slice(0, 300), literal });
        if (NAV_PROPS.has(nm)) out.styleRefs.push({ tag, line, prop: nm, v: String(val).slice(0, 300), literal });
      }
      out.elements.push(el);
    }

    // ---- JSX text nodes
    if (ts.isJsxText(node)) pushText(node.text, "jsxText", node);

    // ---- conditionals (the conditional-state inventory)
    if (ts.isConditionalExpression(node)) {
      out.conditionals.push({ kind: "ternary", line: lineOf(node, sf), guard: textOf(node.condition, sf).replace(/\s+/g, " ").slice(0, 140) });
    }
    if (ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
         node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
      out.conditionals.push({ kind: node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? "and" : "nullish", line: lineOf(node, sf), guard: textOf(node.left, sf).replace(/\s+/g, " ").slice(0, 140) });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.getText(sf) === "map") {
      out.conditionals.push({ kind: "map", line: lineOf(node, sf), guard: textOf(node.expression.expression, sf).replace(/\s+/g, " ").slice(0, 140) });
    }

    // ---- API paths
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (/^\/v1\//.test(node.text)) out.apiPaths.push({ p: node.text, line: lineOf(node, sf) });
    }
    if (ts.isTemplateExpression(node)) {
      const head = node.head.text;
      if (/^\/v1\//.test(head)) out.apiPaths.push({ p: head + "${…}", line: lineOf(node, sf) });
    }

    // ---- StyleSheet.create  -> rule: {prop: value}
    if (ts.isCallExpression(node) && textOf(node.expression, sf) === "StyleSheet.create" && node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0])) {
      for (const p of node.arguments[0].properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isObjectLiteralExpression(p.initializer)) continue;
        const ruleName = p.name.getText(sf).replace(/['"]/g, "");
        const decls = {};
        for (const d of p.initializer.properties) {
          if (!ts.isPropertyAssignment(d)) continue;
          decls[d.name.getText(sf).replace(/['"]/g, "")] = textOf(d.initializer, sf).replace(/\s+/g, " ").slice(0, 160);
        }
        out.stylesheets.push({ rule: ruleName, line: lineOf(p, sf), decls });
      }
    }

    // ---- theme.* token reads (native) — the resolved-value bridge
    if (ts.isPropertyAccessExpression(node)) {
      const t = textOf(node, sf);
      if (/^theme\.(color|space|radius|type|elevation)\./.test(t)) out.themeTokens.push({ t, line: lineOf(node, sf) });
    }

    ts.forEachChild(node, walk);
  };
  walk(sf);

  // dedupe cheap repeats
  out.themeTokens = [...new Map(out.themeTokens.map((x) => [x.t + ":" + x.line, x])).values()];
  return out;
}

/* ============================================================== tree crawling */

export function crawl(entry, { maxFiles = 4000 } = {}) {
  const seen = new Map();
  const missing = [];
  const external = new Set();
  const stack = [{ f: entry, d: 0 }];
  while (stack.length) {
    const { f, d } = stack.pop();
    if (seen.has(f)) continue;
    if (seen.size >= maxFiles) break;
    let ex;
    try { ex = extractFile(f); } catch (e) { missing.push({ f: rel(f), err: String(e).slice(0, 120) }); continue; }
    ex.depth = d;
    seen.set(f, ex);
    for (const spec of ex.imports) {
      const r = resolveImport(spec, f);
      if (r) { if (!seen.has(r)) stack.push({ f: r, d: d + 1 }); }
      else if (!spec.startsWith(".")) external.add(spec);
      else missing.push({ from: rel(f), spec });
    }
  }
  return { files: [...seen.values()], missing, external: [...external] };
}

/* ==================================================================== totals */

export function totals(tree) {
  const T = {
    files: tree.files.length, elements: 0, texts: 0, distinctTexts: 0, handlers: 0,
    conditionals: 0, apiPaths: 0, distinctApi: 0, styleRefs: 0, stylesheetRules: 0,
    themeTokens: 0, cssImports: 0, assetImports: 0, maxDepth: 0,
  };
  const tset = new Set(), aset = new Set();
  for (const f of tree.files) {
    T.elements += f.elements.length; T.texts += f.texts.length;
    T.handlers += f.handlers.length; T.conditionals += f.conditionals.length;
    T.apiPaths += f.apiPaths.length; T.styleRefs += f.styleRefs.length;
    T.stylesheetRules += f.stylesheets.length; T.themeTokens += f.themeTokens.length;
    T.cssImports += f.cssImports.length; T.assetImports += f.assetImports.length;
    T.maxDepth = Math.max(T.maxDepth, f.depth ?? 0);
    for (const t of f.texts) tset.add(t.v.toLowerCase());
    for (const a of f.apiPaths) aset.add(a.p);
  }
  T.distinctTexts = tset.size; T.distinctApi = aset.size;
  return T;
}

/* ======================================================================= main */

if (import.meta.url.endsWith(process.argv[1]?.split("\\").join("/").split("/").pop() ?? "")) {
  const probe = process.argv[2];
  if (probe) {
    const t = crawl(resolve(ROOT, probe));
    console.log(JSON.stringify(totals(t), null, 1));
    console.log("missing:", t.missing.length, "external:", t.external.length);
    console.log("top files:", t.files.slice(0, 12).map((f) => f.file));
  }
}
