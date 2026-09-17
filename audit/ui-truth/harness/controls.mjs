/**
 * PHASE UI-TRUTH — interactive control inventory (AUDIT HARNESS, not product code).
 *
 * For every in-scope surface in `data/surfaces.json`, parses the surface's
 * owned files (from `data/placement.json`) and the app files they import, with
 * the TypeScript compiler API, and records EVERY interactive control found in
 * the JSX: what it is, what names it, what hides it, what disables it, what it
 * calls, and which canonical endpoint that call lands on.
 *
 * Endpoint facts are REUSED from placement.json (which came from the canonical
 * capability map). This harness never re-derives gates, scope or tenancy.
 *
 * Deterministic: sorted keys and arrays, repo-relative forward-slash paths, no
 * timestamps and no run ids. Two runs on an unchanged tree are byte-identical.
 *
 * Nothing that cannot be decided statically is guessed. Every such field is the
 * literal marker "UNRESOLVED_DYNAMIC" carrying its own reason.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO } from "./surfaces.mjs";

const require = createRequire(import.meta.url);
/** The repo pins typescript through pnpm; resolve it without a package.json edit. */
const ts = require(resolve(REPO, "node_modules/.pnpm/typescript@5.9.3/node_modules/typescript"));

const HARNESS = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HARNESS, "..", "data");

const UNRESOLVED = "UNRESOLVED_DYNAMIC";

const rel = (p) => relative(REPO, p).split("\\").join("/");
const abs = (p) => resolve(REPO, p);

/* ------------------------------------------------------------------ *
 * Module graph
 * ------------------------------------------------------------------ */

/** Files we follow into. Product code only; never node_modules, never tests. */
const FOLLOWABLE = [/^apps\/web\//];
/** How far we follow imports out of an owned file when hunting for JSX. */
const MAX_JSX_DEPTH = 2;
/** How far we follow calls out of a handler when hunting for an API call. */
const MAX_CALL_DEPTH = 3;

const EXTS = [".tsx", ".ts", ".jsx", ".js"];

const moduleCache = new Map();
/** Import specifiers we deliberately stopped at, so coverage stays honest. */
const stopped = new Map();

function noteStop(spec, reason) {
  const key = `${spec}::${reason}`;
  stopped.set(key, { specifier: spec, reason, count: (stopped.get(key)?.count ?? 0) + 1 });
}

function isFollowable(relPath) {
  return FOLLOWABLE.some((re) => re.test(relPath));
}

/** Resolve a relative import specifier to a real file under the repo. */
function resolveImport(fromAbs, spec) {
  if (!spec.startsWith(".")) {
    noteStop(spec, spec.startsWith("@proovra/") ? "WORKSPACE_PACKAGE_NOT_FOLLOWED" : "EXTERNAL_MODULE_NOT_FOLLOWED");
    return null;
  }
  const base = resolve(dirname(fromAbs), spec);
  const candidates = [
    ...EXTS.map((e) => base + e),
    ...EXTS.map((e) => join(base, "index" + e)),
    base,
  ];
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

function loadModule(absPath) {
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
  const rec = {
    path: key,
    absPath,
    sf,
    /** local name -> { specifier, imported } for every import binding */
    imports: new Map(),
    /** every import specifier, in source order */
    specifiers: [],
  };
  indexImports(rec);
  moduleCache.set(key, rec);
  return rec;
}

function indexImports(rec) {
  for (const st of rec.sf.statements) {
    // `export { default } from "./x"` is how a canonical route re-exports a
    // shared implementation; it must be followed or the surface reads as empty.
    if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      rec.specifiers.push(st.moduleSpecifier.text);
      continue;
    }
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    rec.specifiers.push(spec);
    const clause = st.importClause;
    if (!clause) continue;
    if (clause.name) rec.imports.set(clause.name.text, { specifier: spec, imported: "default" });
    const nb = clause.namedBindings;
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        rec.imports.set(el.name.text, {
          specifier: spec,
          imported: (el.propertyName ?? el.name).text,
        });
      }
    }
    if (nb && ts.isNamespaceImport(nb)) {
      rec.imports.set(nb.name.text, { specifier: spec, imported: "*" });
    }
  }
}

/** The files a module imports that we are willing to parse. */
function followTargets(rec) {
  const out = [];
  for (const spec of [...new Set(rec.specifiers)].sort()) {
    const target = resolveImport(rec.absPath, spec);
    if (target) out.push(target);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Small AST helpers
 * ------------------------------------------------------------------ */

const lineOf = (node, sf) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
const textOf = (node, sf) => {
  try {
    return node.getText(sf).replace(/\s+/g, " ").trim();
  } catch {
    return UNRESOLVED;
  }
};
const truncate = (s, n) => (s.length > n ? s.slice(0, n) : s);

/** JSX text keeps HTML entities verbatim; a name must read as the user sees it. */
const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
};
const decodeEntities = (t) => t.replace(/&(amp|lt|gt|quot|#39|apos|nbsp|rsquo|lsquo|mdash|ndash|hellip);/g, (m) => ENTITIES[m]);

function walk(node, fn) {
  fn(node);
  ts.forEachChild(node, (c) => walk(c, fn));
}

function tagNameOf(el) {
  const n = el.tagName;
  return typeof n.text === "string" ? n.text : n.getText(el.getSourceFile());
}

function attrsOf(el) {
  const map = new Map();
  let hasSpread = false;
  for (const p of el.attributes.properties) {
    if (ts.isJsxSpreadAttribute(p)) {
      hasSpread = true;
      continue;
    }
    const name = ts.isIdentifier(p.name) ? p.name.text : p.name.getText(el.getSourceFile());
    map.set(name, p);
  }
  return { map, hasSpread };
}

/** The literal string an attribute carries, or null when it is not literal. */
function literalAttr(attr, sf) {
  if (!attr) return null;
  const init = attr.initializer;
  if (init === undefined) return "true"; // bare boolean attribute
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression) {
    const e = init.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (e.kind === ts.SyntaxKind.TrueKeyword) return "true";
    if (e.kind === ts.SyntaxKind.FalseKeyword) return "false";
  }
  return null;
}

/** Literal text of an element's children, when every part of it is literal. */
function literalChildren(el, sf, depth = 0, conditionalName = { hit: false }) {
  if (depth > 3) return null;
  const children = el.children ?? [];
  const parts = [];
  for (const c of children) {
    if (ts.isJsxText(c)) {
      const t = decodeEntities(c.text).replace(/\s+/g, " ").trim();
      if (t) parts.push(t);
      continue;
    }
    if (ts.isJsxExpression(c)) {
      const e = c.expression;
      if (!e) continue;
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
        parts.push(e.text);
        continue;
      }
      // {busy ? "Loading…" : "Refresh"} — both labels are knowable, so record
      // BOTH rather than throwing the name away.
      if (
        ts.isConditionalExpression(e) &&
        (ts.isStringLiteral(e.whenTrue) || ts.isNoSubstitutionTemplateLiteral(e.whenTrue)) &&
        (ts.isStringLiteral(e.whenFalse) || ts.isNoSubstitutionTemplateLiteral(e.whenFalse))
      ) {
        parts.push(`${e.whenTrue.text} | ${e.whenFalse.text}`);
        conditionalName.hit = true;
        continue;
      }
      return null;
    }
    if (ts.isJsxElement(c)) {
      const inner = literalChildren(c, sf, depth + 1, conditionalName);
      if (inner === null) return null;
      if (inner) parts.push(inner);
      continue;
    }
    if (ts.isJsxSelfClosingElement(c)) {
      // An icon-only child contributes no text; an aria-label on it might.
      const { map } = attrsOf(c);
      const label = literalAttr(map.get("aria-label"), sf);
      if (label) parts.push(label);
      continue;
    }
    if (ts.isJsxFragment(c)) {
      const inner = literalChildren(c, sf, depth + 1);
      if (inner === null) return null;
      if (inner) parts.push(inner);
      continue;
    }
    return null;
  }
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  return joined || null;
}

/* ------------------------------------------------------------------ *
 * Control detection
 * ------------------------------------------------------------------ */

/**
 * Intrinsic elements that ARE controls. `label` and `option` are deliberately
 * absent: a label is captured through the input it wraps and an option is part
 * of its select, so counting them would double-count one control.
 */
const INTRINSIC_INTERACTIVE = new Set(["a", "button", "form", "input", "select", "textarea", "summary", "details"]);

const COMPONENT_RE =
  /Button|Link|Tab|Toggle|Switch|Checkbox|Radio|Select|Listbox|Menu|Dialog|Drawer|Modal|Field|Input|Search|Filter|Pager|Pagination|Upload|Download|Export/;

const HANDLER_ATTRS = ["onClick", "onSubmit", "onChange", "onInput", "onKeyDown", "onKeyUp", "onToggle", "onSelect"];
const PRIMARY_HANDLER_ATTRS = ["onClick", "onSubmit", "onChange"];

const TEST_ATTR_RE = /^data-/;
/**
 * Only a TEST/AUTOMATION data attribute makes an otherwise inert element a
 * control. This codebase also uses data-* for styling (data-variant, data-tone,
 * data-state); treating those as controls turned every styled div into one.
 */
const AUTOMATION_DATA_RE = /^data-(testid|test|test-id|qa|qa-id|cy|e2e|automation|automation-id|track|tracking|analytics)$/;

function isInteractive(tag, attrNames) {
  const reasons = [];
  if (INTRINSIC_INTERACTIVE.has(tag)) reasons.push("INTRINSIC_ELEMENT");
  if (/^[A-Z]/.test(tag) && COMPONENT_RE.test(tag)) reasons.push("COMPONENT_NAME_PATTERN");
  if (tag === "Link" || tag === "NextLink") reasons.push("COMPONENT_NAME_PATTERN");
  for (const h of PRIMARY_HANDLER_ATTRS) if (attrNames.has(h)) reasons.push(`HAS_${h.toUpperCase()}`);
  if (attrNames.has("href")) reasons.push("HAS_HREF");
  if (attrNames.has("role")) reasons.push("HAS_ROLE");
  if ([...attrNames].some((a) => AUTOMATION_DATA_RE.test(a))) reasons.push("HAS_AUTOMATION_DATA_ATTRIBUTE");
  return [...new Set(reasons)].sort();
}

function classifyType(tag, attrs, sf) {
  const role = literalAttr(attrs.get("role"), sf);
  const type = literalAttr(attrs.get("type"), sf);
  const t = tag.toLowerCase();
  if (role === "tab" || /(^|[A-Z])Tab(s|Bar|List|Button)?$/.test(tag) || tag === "Tab") return "TAB";
  if (t === "form" || /Form$/.test(tag)) return "FORM";
  if (t === "input") {
    if (type === "checkbox") return "CHECKBOX";
    if (type === "radio") return "RADIO";
    if (type === "file") return "UPLOAD";
    if (type === "submit" || type === "button") return "BUTTON";
    return "INPUT";
  }
  if (t === "textarea") return "INPUT";
  if (t === "select") return "SELECT";
  if (t === "a" || tag === "Link" || tag === "NextLink" || /Link$/.test(tag)) return "LINK";
  if (t === "button") return "BUTTON";
  if (/Upload|Dropzone|FilePicker/.test(tag)) return "UPLOAD";
  if (/Checkbox/.test(tag)) return "CHECKBOX";
  if (/Radio/.test(tag)) return "RADIO";
  if (/Toggle|Switch/.test(tag)) return "TOGGLE";
  if (/Select|Listbox|Dropdown|Combobox/.test(tag)) return "SELECT";
  if (/Input|Field|Search|Filter/.test(tag)) return "INPUT";
  if (/Button/.test(tag)) return "BUTTON";
  if (role === "button") return "BUTTON";
  if (role === "link") return "LINK";
  if (attrs.has("href")) return "LINK";
  return "OTHER";
}

/** Every parameter binding name of the functions enclosing a node (props). */
function enclosingParameterNames(node) {
  const names = new Set();
  let cur = node.parent;
  while (cur) {
    if (isFunctionish(cur)) {
      for (const p of cur.parameters ?? []) collectBindingNames(p.name, names);
    }
    cur = cur.parent;
  }
  return names;
}

function collectBindingNames(name, out) {
  if (!name) return;
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) collectBindingNames(el.name, out);
    }
  }
}

/** The nearest conditional that decides whether this element renders at all. */
function visibilityCondition(el, sf) {
  let node = el;
  let parent = el.parent;
  let guard = null;
  while (parent) {
    if (ts.isConditionalExpression(parent)) {
      if (parent.whenTrue === node) guard = textOf(parent.condition, sf);
      else if (parent.whenFalse === node) guard = `!(${textOf(parent.condition, sf)})`;
    } else if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      if (parent.right === node) {
        if (op === ts.SyntaxKind.AmpersandAmpersandToken) guard = textOf(parent.left, sf);
        else if (op === ts.SyntaxKind.BarBarToken) guard = `!(${textOf(parent.left, sf)})`;
        else if (op === ts.SyntaxKind.QuestionQuestionToken) guard = `${textOf(parent.left, sf)} == null`;
      }
    } else if (ts.isIfStatement(parent)) {
      if (parent.thenStatement === node) guard = textOf(parent.expression, sf);
      else if (parent.elseStatement === node) guard = `!(${textOf(parent.expression, sf)})`;
    } else if (
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isArrowFunction(parent) ||
      ts.isMethodDeclaration(parent)
    ) {
      // Unconditional inside its own render function. Whether that function is
      // itself called is a separate (and unrepresented) question.
      return null;
    }
    if (guard) return truncate(guard, 200);
    node = parent;
    parent = parent.parent;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Handler and API-call resolution
 * ------------------------------------------------------------------ */

const CONFIRM_RE = /confirm|useConfirmAction|ConfirmActionModal|requireConfirmation|areYouSure/i;

function isFunctionish(node) {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** Find a named function-ish declaration inside a module. */
function findLocalFunction(rec, name) {
  let found = null;
  walk(rec.sf, (n) => {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      if (isFunctionish(n.initializer)) found = n.initializer;
      else if (
        ts.isCallExpression(n.initializer) &&
        n.initializer.arguments.length &&
        isFunctionish(n.initializer.arguments[0])
      ) {
        // useCallback(fn, deps) and friends.
        found = n.initializer.arguments[0];
      }
    }
  });
  return found;
}

/** Resolve an identifier to a function body, following imports one module hop. */
function resolveFunction(rec, name, depth = 0) {
  const local = findLocalFunction(rec, name);
  if (local) return { node: local, rec };
  const imp = rec.imports.get(name);
  if (!imp || depth >= 2) return null;
  const target = resolveImport(rec.absPath, imp.specifier);
  if (!target) return null;
  const next = loadModule(target);
  if (!next) return null;
  const wanted = imp.imported === "default" ? null : imp.imported;
  if (!wanted) return null;
  return resolveFunction(next, wanted, depth + 1);
}

function pathFromArg(arg, sf) {
  if (!arg) return { path: UNRESOLVED, reason: "NO_PATH_ARGUMENT" };
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return { path: arg.text };
  if (ts.isTemplateExpression(arg)) {
    let out = arg.head.text;
    for (const span of arg.templateSpans) out += "{param}" + span.literal.text;
    // A template whose FIRST piece is a substitution is built on a base held in
    // a variable; printing it would invent a path that is not in the source.
    if (!out.startsWith("/")) return { path: UNRESOLVED, reason: "PATH_BUILT_ON_A_NON_LITERAL_PREFIX" };
    return { path: out };
  }
  return { path: UNRESOLVED, reason: "NON_LITERAL_PATH_EXPRESSION" };
}

function methodFromArg(arg, sf) {
  if (!arg) return "GET";
  if (!ts.isObjectLiteralExpression(arg)) return UNRESOLVED;
  for (const p of arg.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
    if (key !== "method") continue;
    if (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer)) {
      return p.initializer.text.toUpperCase();
    }
    return UNRESOLVED;
  }
  return "GET";
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/**
 * Walk a handler body (and the local/imported functions it calls) collecting
 * every API call, navigation and local-state write it can reach.
 */
function analyzeBody(node, rec, depth, seen, acc) {
  if (!node) return;
  const sf = rec.sf;
  walk(node, (n) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      if (!name) return;
      const isMethodCall = ts.isPropertyAccessExpression(n.expression);
      if (CONFIRM_RE.test(name)) acc.confirm = true;
      if (name === "apiFetch" || name === "fetch" || name === "apiFetchRaw") {
        const { path, reason } = pathFromArg(n.arguments[0], sf);
        const method = methodFromArg(n.arguments[1], sf);
        acc.calls.push({
          method,
          path,
          primitive: name,
          file: rec.path,
          line: lineOf(n, sf),
          ...(reason ? { reason } : {}),
        });
        return;
      }
      if (name === "push" || name === "replace" || name === "redirect" || name === "assign") {
        const owner = ts.isPropertyAccessExpression(n.expression) ? textOf(n.expression.expression, sf) : "";
        if (/router|location|window\.location/.test(owner) || name === "redirect") {
          const target = n.arguments[0] ? pathFromArg(n.arguments[0], sf) : { path: UNRESOLVED };
          acc.navigations.push({ target: target.path, file: rec.path, line: lineOf(n, sf) });
        }
        return;
      }
      if (/^set[A-Z]/.test(name) || /^use[A-Z]/.test(name)) {
        acc.localState = true;
        return;
      }
      // `e.stopPropagation()`, `navigator.clipboard.writeText()`, `.catch()` —
      // a method on a value, never a module-level function we could follow.
      if (isMethodCall) return;
      if (depth >= MAX_CALL_DEPTH) {
        acc.truncatedAt.push(`${rec.path}:${name}`);
        return;
      }
      const key = `${rec.path}#${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      const resolved = resolveFunction(rec, name);
      if (resolved) analyzeBody(resolved.node, resolved.rec, depth + 1, seen, acc);
      else acc.unresolvedCalls.push(name);
    } else if (ts.isAwaitExpression(n) || ts.isIdentifier(n)) {
      if (ts.isIdentifier(n) && CONFIRM_RE.test(n.text)) acc.confirm = true;
    }
  });
}

/* ------------------------------------------------------------------ *
 * Endpoint matching
 * ------------------------------------------------------------------ */

function segments(p) {
  return p.split("?")[0].split("#")[0].split("/").filter(Boolean);
}

function matchEndpoint(call, endpoints, universe) {
  const own = matchAgainst(call, endpoints);
  if (own.routeId !== UNMATCHED) return own;
  if (own.reason === "NON_LITERAL_PATH_EXPRESSION") return own;
  // The call is real but the capability map did not attribute that endpoint to
  // THIS surface (typically a shared component reached through an import).
  const global = matchAgainst(call, universe);
  if (global.routeId !== UNMATCHED) {
    return {
      routeId: global.routeId,
      reason: "MATCHED_IN_THE_GLOBAL_ENDPOINT_UNIVERSE_BUT_NOT_ATTRIBUTED_TO_THIS_SURFACE_BY_PLACEMENT",
    };
  }
  return { routeId: UNMATCHED, reason: "NO_ENDPOINT_ANYWHERE_IN_PLACEMENT_WITH_THIS_METHOD_AND_PATH" };
}

function matchAgainst(call, endpoints) {
  if (call.path === UNRESOLVED) return { routeId: UNMATCHED, reason: "NON_LITERAL_PATH_EXPRESSION" };
  const callSegs = segments(call.path);
  const candidates = [];
  for (const ep of endpoints) {
    const epSegs = segments(ep.path);
    if (epSegs.length !== callSegs.length) continue;
    let ok = true;
    for (let i = 0; i < epSegs.length; i += 1) {
      const a = epSegs[i];
      const b = callSegs[i];
      if (a.startsWith(":") || b === "{param}") continue;
      if (a !== b) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (call.method !== UNRESOLVED && ep.method !== call.method) continue;
    candidates.push(ep);
  }
  if (candidates.length === 0) {
    return {
      routeId: UNMATCHED,
      reason: "NO_ENDPOINT_ON_THIS_SURFACE_WITH_THIS_METHOD_AND_PATH",
    };
  }
  const exact = candidates.find((ep) => ep.path === call.path.split("?")[0]);
  const chosen = exact ?? candidates.slice().sort((a, b) => (a.routeId < b.routeId ? -1 : 1))[0];
  return { routeId: chosen.routeId, ...(exact ? {} : { reason: "MATCHED_BY_PARAMETERISED_PATH" }) };
}

const UNMATCHED = "UNMATCHED";

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

function collectSurfaceFiles(ownedFiles) {
  const parsed = new Map(); // relPath -> depth
  const queue = [];
  for (const f of ownedFiles) {
    const a = abs(f);
    if (!existsSync(a)) continue;
    queue.push([a, 0]);
  }
  const notFollowed = [];
  while (queue.length) {
    const [absPath, depth] = queue.shift();
    const key = rel(absPath);
    if (parsed.has(key) && parsed.get(key) <= depth) continue;
    parsed.set(key, depth);
    const rec = loadModule(absPath);
    if (!rec) continue;
    if (depth >= MAX_JSX_DEPTH) {
      for (const spec of [...new Set(rec.specifiers)].sort()) {
        if (spec.startsWith(".")) notFollowed.push(`${key} -> ${spec}`);
      }
      continue;
    }
    for (const t of followTargets(rec)) queue.push([t, depth + 1]);
  }
  return { parsed, notFollowed: [...new Set(notFollowed)].sort() };
}

function inventoryFile(rec, surface, endpoints, universe, depth) {
  const sf = rec.sf;
  const controls = [];
  const seenIds = new Map();

  const elements = [];
  walk(sf, (n) => {
    if (ts.isJsxSelfClosingElement(n)) elements.push({ open: n, el: n });
    else if (ts.isJsxElement(n)) elements.push({ open: n.openingElement, el: n });
  });
  elements.sort((a, b) => a.open.getStart(sf) - b.open.getStart(sf));

  for (const { open, el } of elements) {
    const tag = tagNameOf(open);
    const { map: attrs, hasSpread } = attrsOf(open);
    const attrNames = new Set(attrs.keys());
    const reasons = isInteractive(tag, attrNames);
    if (reasons.length === 0) continue;
    // `role` alone only counts for the interactive roles named in the method.
    if (reasons.every((r) => r === "HAS_ROLE" || r === "HAS_AUTOMATION_DATA_ATTRIBUTE") && attrNames.has("role")) {
      const role = literalAttr(attrs.get("role"), sf);
      if (!["button", "tab", "link", "menuitem", "switch", "checkbox", "radio"].includes(role ?? "")) continue;
    }

    const line = lineOf(open, sf);
    const base = `${surface.surfaceId}::${basename(rec.path)}:${line}:${tag}`;
    const n = (seenIds.get(base) ?? 0) + 1;
    seenIds.set(base, n);
    const controlId = n === 1 ? base : `${base}#${n}`;

    // ---- accessible name
    let accessibleName = literalAttr(attrs.get("aria-label"), sf);
    let nameSource = accessibleName ? "aria-label" : null;
    const condName = { hit: false };
    if (!accessibleName) {
      const kids = ts.isJsxElement(el) ? literalChildren(el, sf, 0, condName) : null;
      if (kids) {
        accessibleName = kids;
        // "Saving… | Save" — the element carries two labels and which one shows
        // is a runtime state, so both are reported rather than one guessed.
        nameSource = condName.hit ? "children-both-branches-of-a-conditional" : "children";
      }
    }
    if (!accessibleName) {
      const title = literalAttr(attrs.get("title"), sf);
      if (title) {
        accessibleName = title;
        nameSource = "title";
      }
    }
    if (!accessibleName) {
      for (const p of ["label", "placeholder", "alt", "name"]) {
        const v = literalAttr(attrs.get(p), sf);
        if (v) {
          accessibleName = v;
          nameSource = p;
          break;
        }
      }
    }
    const nameReason = accessibleName
      ? null
      : attrNames.has("aria-label") || attrNames.has("title") || attrNames.has("label")
        ? "NAME_PROP_IS_A_NON_LITERAL_EXPRESSION"
        : hasSpread
          ? "PROPS_ARRIVE_THROUGH_A_SPREAD"
          : "NO_LITERAL_NAME_ON_THE_ELEMENT";

    // ---- data attributes
    const dataAttributes = [...attrs.entries()]
      .filter(([k]) => TEST_ATTR_RE.test(k))
      .map(([k, a]) => ({ name: k, value: literalAttr(a, sf) ?? UNRESOLVED }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));

    // ---- disabled / href
    const disabledAttr = attrs.get("disabled") ?? attrs.get("aria-disabled") ?? attrs.get("isDisabled");
    const disabledExpression = disabledAttr
      ? truncate(
          disabledAttr.initializer === undefined
            ? "true"
            : ts.isJsxExpression(disabledAttr.initializer) && disabledAttr.initializer.expression
              ? textOf(disabledAttr.initializer.expression, sf)
              : textOf(disabledAttr.initializer, sf),
          200,
        )
      : null;

    let href = null;
    if (attrs.has("href")) {
      href = literalAttr(attrs.get("href"), sf) ?? UNRESOLVED;
    }

    // ---- handler
    let handlerName = null;
    let handlerAttr = null;
    for (const h of HANDLER_ATTRS) {
      if (attrs.has(h)) {
        handlerAttr = h;
        break;
      }
    }
    const acc = {
      calls: [],
      navigations: [],
      localState: false,
      confirm: false,
      unresolvedCalls: [],
      truncatedAt: [],
    };
    let handlerFile = null;
    let handlerResolution = null;
    if (handlerAttr) {
      const init = attrs.get(handlerAttr).initializer;
      const expr = init && ts.isJsxExpression(init) ? init.expression : null;
      if (!expr) {
        handlerName = UNRESOLVED;
        handlerResolution = "HANDLER_PROP_HAS_NO_EXPRESSION";
      } else if (isFunctionish(expr)) {
        handlerName = "INLINE";
        handlerFile = rec.path;
        handlerResolution = "INLINE_IN_THIS_FILE";
        analyzeBody(expr, rec, 0, new Set(), acc);
      } else if (ts.isIdentifier(expr)) {
        handlerName = expr.text;
        const resolved = resolveFunction(rec, expr.text);
        if (resolved) {
          handlerFile = resolved.rec.path;
          handlerResolution = resolved.rec.path === rec.path ? "DECLARED_IN_THIS_FILE" : "DECLARED_IN_AN_IMPORTED_FILE";
          analyzeBody(resolved.node, resolved.rec, 0, new Set(), acc);
        } else if (/^set[A-Z]/.test(expr.text)) {
          // A useState setter passed straight through: a local state write.
          handlerResolution = "HANDLER_IS_A_LOCAL_STATE_SETTER";
          acc.localState = true;
        } else if (enclosingParameterNames(open).has(expr.text)) {
          handlerResolution = "HANDLER_IS_A_PROP_SUPPLIED_BY_THE_PARENT";
        } else {
          handlerResolution = "HANDLER_IDENTIFIER_NOT_STATICALLY_RESOLVABLE";
        }
      } else if (ts.isCallExpression(expr)) {
        const name = calleeName(expr.expression);
        handlerName = name ? `${name}(...)` : UNRESOLVED;
        const resolved = name ? resolveFunction(rec, name) : null;
        if (resolved) {
          handlerFile = resolved.rec.path;
          handlerResolution = "HANDLER_IS_A_FACTORY_CALL";
          analyzeBody(resolved.node, resolved.rec, 0, new Set(), acc);
        } else {
          handlerResolution = "HANDLER_FACTORY_NOT_STATICALLY_RESOLVABLE";
        }
      } else {
        handlerName = truncate(textOf(expr, sf), 120);
        handlerResolution = "HANDLER_IS_A_NON_IDENTIFIER_EXPRESSION";
      }
    }

    // ---- kind
    const mutating = acc.calls.filter((c) => c.method !== "GET" && c.method !== UNRESOLVED);
    const reads = acc.calls.filter((c) => c.method === "GET");
    const unknownMethod = acc.calls.filter((c) => c.method === UNRESOLVED);
    let kind;
    let kindReason = null;
    if (mutating.length) kind = "MUTATION";
    else if (reads.length) kind = "READ";
    else if (unknownMethod.length) {
      kind = UNRESOLVED;
      kindReason = "API_CALL_FOUND_BUT_ITS_METHOD_IS_NOT_A_LITERAL";
    } else if ((href && href !== UNRESOLVED) || acc.navigations.length) kind = "NAVIGATIONAL";
    else if (href === UNRESOLVED) {
      kind = "NAVIGATIONAL";
      kindReason = "HREF_IS_A_NON_LITERAL_EXPRESSION";
    } else if (!handlerAttr) {
      kind = "LOCAL_ONLY";
      kindReason = "NO_HANDLER_AND_NO_HREF_ON_THIS_ELEMENT";
    } else if (handlerResolution === "HANDLER_IS_A_LOCAL_STATE_SETTER") {
      kind = "LOCAL_ONLY";
    } else if (handlerResolution === "HANDLER_IS_A_PROP_SUPPLIED_BY_THE_PARENT") {
      kind = UNRESOLVED;
      kindReason = "HANDLER_IS_A_PROP_SUPPLIED_BY_THE_PARENT_AND_THIS_HARNESS_DOES_NOT_TRACK_CALL_SITES";
    } else if (handlerResolution && handlerResolution.includes("NOT_STATICALLY_RESOLVABLE")) {
      kind = UNRESOLVED;
      kindReason = handlerResolution;
    } else if (acc.unresolvedCalls.length && !acc.localState) {
      const props = enclosingParameterNames(open);
      const unresolved = [...new Set(acc.unresolvedCalls)].sort();
      const allProps = unresolved.every((u) => props.has(u));
      kind = UNRESOLVED;
      kindReason = `${allProps ? "HANDLER_CALLS_PROP_CALLBACKS" : "HANDLER_CALLS_UNRESOLVED_FUNCTIONS"}: ${unresolved.slice(0, 5).join(",")}`;
    } else kind = "LOCAL_ONLY";

    // ---- endpoints
    const endpointMatches = acc.calls
      .map((c) => {
        const m = matchEndpoint(c, endpoints, universe);
        return {
          method: c.method,
          path: c.path,
          primitive: c.primitive,
          resolvedIn: c.file,
          line: c.line,
          endpointRouteId: m.routeId,
          ...(m.reason ? { reason: m.reason } : {}),
        };
      })
      .sort((a, b) =>
        `${a.method} ${a.path} ${a.resolvedIn}:${a.line}` < `${b.method} ${b.path} ${b.resolvedIn}:${b.line}` ? -1 : 1,
      );

    controls.push({
      controlId,
      surfaceId: surface.surfaceId,
      route: surface.route,
      file: rec.path,
      fileDepth: depth,
      line,
      element: tag,
      elementKind: /^[A-Z]/.test(tag) ? "COMPONENT" : "INTRINSIC",
      controlType: classifyType(tag, attrs, sf),
      detectedBy: reasons,
      accessibleName: accessibleName ?? UNRESOLVED,
      ...(nameReason ? { accessibleNameReason: nameReason } : { accessibleNameSource: nameSource }),
      dataAttributes,
      disabledExpression,
      visibilityCondition: visibilityCondition(el, sf),
      href,
      handlerProp: handlerAttr,
      handlerName,
      handlerFile,
      handlerResolution,
      confirmationHint: acc.confirm,
      kind,
      ...(kindReason ? { kindReason } : {}),
      navigationTargets: acc.navigations
        .map((n2) => n2.target)
        .filter((v, i, a) => a.indexOf(v) === i)
        .sort(),
      endpointCalls: endpointMatches,
      callGraphTruncated: [...new Set(acc.truncatedAt)].sort(),
      propsSpread: hasSpread,
    });
  }
  return controls;
}

/**
 * A page whose whole job is `redirect("/somewhere")` has no controls BY DESIGN.
 * Returns the literal target, so a zero on that surface reads as intent rather
 * than as a parser gap.
 */
function serverRedirect(pageFile) {
  const rec = loadModule(abs(pageFile));
  if (!rec) return null;
  let target = null;
  walk(rec.sf, (n) => {
    if (target) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "redirect") {
      const a = n.arguments[0];
      target = a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) ? a.text : UNRESOLVED;
    }
  });
  return target;
}

function main() {
  const surfaces = JSON.parse(readFileSync(join(DATA, "surfaces.json"), "utf8")).surfaces.filter((s) => s.inScope);
  const placement = JSON.parse(readFileSync(join(DATA, "placement.json"), "utf8"));
  const byId = new Map(placement.rows.map((r) => [r.surfaceId, r]));

  /**
   * Every endpoint placement attributed to ANY surface. A shared component
   * reached through an import calls endpoints the map never attributed to the
   * surface that mounted it; matching against this universe keeps that visible
   * as an attribution gap instead of silently printing UNMATCHED.
   */
  const universe = [];
  const seenEp = new Set();
  for (const r of placement.rows) {
    for (const e of r.endpoints) {
      const k = `${e.method} ${e.path} ${e.routeId}`;
      if (seenEp.has(k)) continue;
      seenEp.add(k);
      universe.push(e);
    }
  }
  universe.sort((a, b) => (`${a.method} ${a.path} ${a.routeId}` < `${b.method} ${b.path} ${b.routeId}` ? -1 : 1));

  const allControls = [];
  const coverage = [];
  const skippedFiles = new Set();

  for (const s of surfaces.slice().sort((a, b) => (a.surfaceId < b.surfaceId ? -1 : 1))) {
    const p = byId.get(s.surfaceId);
    const owned = p ? p.ownedFiles : [s.file];
    const endpoints = p ? p.endpoints : [];
    const { parsed, notFollowed } = collectSurfaceFiles(owned);

    const surfaceControls = [];
    for (const [relPath, depth] of [...parsed.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (!relPath.endsWith(".tsx") && !relPath.endsWith(".jsx")) {
        skippedFiles.add(`${relPath} :: NOT_A_JSX_FILE_PARSED_ONLY_FOR_HANDLERS`);
        continue;
      }
      const rec = loadModule(abs(relPath));
      if (!rec) {
        skippedFiles.add(`${relPath} :: UNREADABLE`);
        continue;
      }
      surfaceControls.push(...inventoryFile(rec, { surfaceId: s.surfaceId, route: s.route }, endpoints, universe, depth));
    }
    // Where a control physically lives relative to the surface that mounts it.
    // A shared primitive's own internals are counted for every surface that
    // imports it; this field is what lets a reader collapse that back down.
    const ownedSet = new Set(owned);
    const routeDir = s.file.slice(0, s.file.lastIndexOf("/") + 1);
    for (const c of surfaceControls) {
      c.origin = ownedSet.has(c.file)
        ? "OWNED_FILE"
        : c.file.startsWith(routeDir)
          ? "ROUTE_LOCAL_FILE"
          : c.file.startsWith("apps/web/components/")
            ? "SHARED_COMPONENT"
            : "OTHER_APP_FILE";
    }
    surfaceControls.sort((a, b) => (a.controlId < b.controlId ? -1 : 1));
    allControls.push(...surfaceControls);

    const parsedList = [...parsed.keys()].sort();
    coverage.push({
      surfaceId: s.surfaceId,
      route: s.route,
      file: s.file,
      area: s.area,
      controlCount: surfaceControls.length,
      controlsInOwnedFiles: surfaceControls.filter((c) => c.origin === "OWNED_FILE").length,
      controlsInRouteLocalFiles: surfaceControls.filter((c) => c.origin === "ROUTE_LOCAL_FILE").length,
      controlsInSharedComponents: surfaceControls.filter((c) => c.origin === "SHARED_COMPONENT").length,
      ownedFiles: owned.slice().sort(),
      filesParsed: parsedList,
      jsxFilesParsed: parsedList.filter((f) => f.endsWith(".tsx") || f.endsWith(".jsx")),
      importsNotFollowed: notFollowed,
      endpointCount: endpoints.length,
      verdict:
        surfaceControls.length > 0
          ? "CONTROLS_FOUND"
          : parsedList.length === 0
            ? "NO_FILES_PARSED"
            : serverRedirect(s.file)
              ? "SERVER_REDIRECT_ONLY_NO_CONTROLS_EXPECTED"
              : "NO_INTERACTIVE_CONTROL_IN_PARSED_FILES",
      ...(surfaceControls.length === 0 && serverRedirect(s.file)
        ? { redirectsTo: serverRedirect(s.file) }
        : {}),
    });
  }

  // -------- totals
  const tally = (arr, key) => {
    const out = {};
    for (const c of arr) out[key(c)] = (out[key(c)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  };

  const mutations = allControls.filter((c) => c.kind === "MUTATION");
  const reads = allControls.filter((c) => c.kind === "READ");
  const matched = (c) => c.endpointCalls.some((e) => e.endpointRouteId !== UNMATCHED);

  const totals = {
    controls: allControls.length,
    inScopeSurfaces: surfaces.length,
    surfacesWithControls: coverage.filter((c) => c.controlCount > 0).length,
    surfacesWithoutControls: coverage.filter((c) => c.controlCount === 0).length,
    distinctFilesParsed: new Set(coverage.flatMap((c) => c.filesParsed)).size,
    distinctJsxFilesParsed: new Set(coverage.flatMap((c) => c.jsxFilesParsed)).size,
    withAccessibleName: allControls.filter((c) => c.accessibleName !== UNRESOLVED).length,
    withoutAccessibleName: allControls.filter((c) => c.accessibleName === UNRESOLVED).length,
    withDataAttributes: allControls.filter((c) => c.dataAttributes.length > 0).length,
    withDisabledExpression: allControls.filter((c) => c.disabledExpression !== null).length,
    withVisibilityCondition: allControls.filter((c) => c.visibilityCondition !== null).length,
    withConfirmationHint: allControls.filter((c) => c.confirmationHint).length,
    unresolvedKind: allControls.filter((c) => c.kind === UNRESOLVED).length,
    unresolvedAccessibleName: allControls.filter((c) => c.accessibleName === UNRESOLVED).length,
    mutationControls: mutations.length,
    mutationControlsMatchedToEndpoint: mutations.filter(matched).length,
    mutationControlsUnmatched: mutations.filter((c) => !matched(c)).length,
    readControls: reads.length,
    readControlsMatchedToEndpoint: reads.filter(matched).length,
    uniqueControlSites: new Set(allControls.map((c) => `${c.file}:${c.line}:${c.element}`)).size,
    byOrigin: tally(allControls, (c) => c.origin),
    byControlType: tally(allControls, (c) => c.controlType),
    byKind: tally(allControls, (c) => c.kind),
    byElementKind: tally(allControls, (c) => c.elementKind),
    byArea: tally(
      allControls.map((c) => coverage.find((v) => v.surfaceId === c.surfaceId)),
      (c) => c.area,
    ),
    perSurface: Object.fromEntries(
      coverage.slice().sort((a, b) => (a.surfaceId < b.surfaceId ? -1 : 1)).map((c) => [c.surfaceId, c.controlCount]),
    ),
  };

  const controlsDoc = {
    artifact: "ui-truth/controls",
    schemaVersion: 1,
    note:
      "Every interactive control on the 168 in-scope surfaces, parsed statically from the surface's owned files and the app files they import (2 hops). Endpoint facts are reused from ui-truth/placement; nothing here is inferred at runtime.",
    inputs: {
      surfaces: "audit/ui-truth/data/surfaces.json",
      placement: "audit/ui-truth/data/placement.json",
    },
    limits: {
      jsxImportDepth: MAX_JSX_DEPTH,
      handlerCallDepth: MAX_CALL_DEPTH,
      followedOnly: "apps/web/**",
      unresolvedMarker: UNRESOLVED,
    },
    totals,
    importsStoppedAt: [...stopped.values()]
      .map(({ specifier, reason, count }) => ({ specifier, reason, count }))
      .sort((a, b) => (`${a.specifier}|${a.reason}` < `${b.specifier}|${b.reason}` ? -1 : 1)),
    filesSkipped: [...skippedFiles].sort(),
    controls: allControls
      .slice()
      .sort((a, b) => (`${a.surfaceId}|${a.controlId}` < `${b.surfaceId}|${b.controlId}` ? -1 : 1)),
  };

  const coverageDoc = {
    artifact: "ui-truth/controls-coverage",
    schemaVersion: 1,
    note: "Per in-scope surface: how many controls were found and exactly which files were parsed, so a zero is visibly either a genuinely static surface or a parser gap.",
    totals: {
      inScopeSurfaces: coverage.length,
      surfacesWithControls: totals.surfacesWithControls,
      surfacesWithoutControls: totals.surfacesWithoutControls,
      byVerdict: tally(coverage, (c) => c.verdict),
    },
    surfaces: coverage.slice().sort((a, b) => (a.surfaceId < b.surfaceId ? -1 : 1)),
  };

  writeFileSync(join(DATA, "controls.json"), JSON.stringify(controlsDoc, null, 2) + "\n");
  writeFileSync(join(DATA, "controls-coverage.json"), JSON.stringify(coverageDoc, null, 2) + "\n");

  process.stdout.write(
    `controls=${totals.controls} surfaces=${totals.inScopeSurfaces} withControls=${totals.surfacesWithControls} ` +
      `mutations=${totals.mutationControls} matched=${totals.mutationControlsMatchedToEndpoint} ` +
      `unresolved=${totals.unresolvedKind} files=${totals.distinctFilesParsed}\n`,
  );
}

main();
