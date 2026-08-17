#!/usr/bin/env node
/**
 * PHASE 12 — CAPABILITY AUTHORITY: THE AST ANALYZER.
 *
 * FINAL-001. `docs/architecture/current-runtime-capability-map.json` carried a
 * hand-maintained `classification` column with no generator, and it disagreed
 * with the tree on 176 of 1083 routes. The first replacement was a text
 * scanner, and it needed five separate repairs — nested template literals,
 * apostrophes in prose, interpolated parameters, query suffixes, literal-vs-
 * parameter segments — each of which had silently mis-stated the answer until
 * it was found. A parser that needs a repair per idiom is not converging on
 * the truth; it is being fitted to the last example.
 *
 * So the text scanner is retired. This module parses the real TypeScript with
 * the compiler API that the repository already installs, and reasons over
 * syntax instead of characters.
 *
 * THE ONE RULE THAT MATTERS
 * ---------------------------------------------------------------------------
 * A path string is a CONSUMER only when it is passed to something that
 * performs a request. That single requirement is what makes
 * `router.push("/collaboration-teams/…")` and `href="/settings"` stop being
 * false consumers — not a list of exclusions to maintain, but a consequence of
 * asking the right question. The old scanner counted every string that looked
 * like a path; this one counts arguments to `fetch`, `apiFetch`, `new URL`,
 * and any wrapper that forwards into one.
 *
 * WHAT IT REFUSES TO GUESS
 * ---------------------------------------------------------------------------
 * A path it cannot statically resolve is emitted as DYNAMIC_UNRESOLVED with a
 * source location. It is never silently dropped and never counted as a
 * consumer, because both of those turn an unknown into a false certainty.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/** @type {import("typescript")} */
const ts = require("typescript");

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "../../../..");

const rel = (abs) => path.relative(REPO, abs).split(path.sep).join("/");

/**
 * Marker for a path segment built from an expression whose value is not known
 * statically. It is a NAMED token, not whitespace: an earlier revision used a
 * quoted space, an encoding accident turned it into a NUL byte, and because
 * every use was mangled identically the bug had no symptom at all.
 */
export const INTERP = "<interp>";

export const DYNAMIC_UNRESOLVED = "DYNAMIC_UNRESOLVED";

// ===========================================================================
// Source trees, pinned as DATA so the blind spots are visible rather than
// implicit. `product` decides whether a HUMAN can reach a capability; a
// non-product tree can justify a route's existence but never make it a
// product surface.
// ===========================================================================

export const TREES = Object.freeze([
  { class: "WEB", product: true, roots: ["apps/web/app", "apps/web/components", "apps/web/lib", "apps/web/hooks"] },
  { class: "MOBILE", product: true, roots: ["apps/mobile/app", "apps/mobile/src", "apps/mobile/components", "apps/mobile/lib"] },
  { class: "WORKER", product: false, roots: ["services/worker/src"] },
  { class: "API_INTERNAL", product: false, roots: ["services/api/src"] },
  { class: "SHARED", product: false, roots: ["packages"] },
  { class: "CLI", product: false, roots: ["services/api/scripts", "services/worker/scripts", "scripts"] },
  { class: "INFRA", product: false, roots: [".github/workflows", "infra", "deploy"] },
]);

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIR = new Set(["node_modules", ".next", "dist", "build", "coverage", ".turbo", ".git"]);

/**
 * Tests, fixtures and audit artifacts are EVIDENCE, never consumers (§0 rule
 * 7). A proof suite calling a route is exactly what makes an orphan look
 * connected, so these are excluded from the tree walk entirely and reported
 * separately when they are a route's only caller.
 */
export const isTestPath = (p) =>
  /(^|\/)(test|tests|__tests__|e2e|fixtures?|__fixtures__|__mocks__)\//.test(p) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);

function walk(root, out = []) {
  const absRoot = path.join(REPO, root);
  if (!existsSync(absRoot)) return out;
  const stack = [absRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_DIR.has(entry)) continue;
      const full = path.join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (SOURCE_EXT.has(path.extname(entry))) out.push(full);
    }
  }
  return out;
}

export function parse(file, text) {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    /\.tsx?$/.test(file) ? (file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS) : ts.ScriptKind.JS,
  );
}

// ===========================================================================
// PATH EXPRESSION RESOLUTION
//
// Turns an arbitrary expression node into a normalized path, or says it
// cannot. Handles the forms that actually appear in this repository:
// literals, template literals (including NESTED ones), `+` concatenation,
// identifiers bound to string constants, imported path constants, and
// `new URL(path, base)`.
// ===========================================================================

/**
 * @returns {{resolved: true, value: string} | {resolved: false, reason: string}}
 */
export function resolvePathExpr(node, ctx) {
  if (node === undefined) return { resolved: false, reason: "absent argument" };

  if (ts.isStringLiteralLike(node)) return { resolved: true, value: node.text };

  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const inner = resolvePathExpr(span.expression, ctx);
      // A nested template used purely as a query suffix — `${qs ? `?${qs}` : ""}`
      // — resolves to something starting with `?`, which is not part of the
      // route identity and is dropped downstream. An unresolvable expression
      // becomes a wildcard SEGMENT, which is the same shape as `:param`.
      out += inner.resolved ? inner.value : INTERP;
      out += span.literal.text;
    }
    return { resolved: true, value: out };
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = resolvePathExpr(node.left, ctx);
    const r = resolvePathExpr(node.right, ctx);
    if (!l.resolved && !r.resolved) return { resolved: false, reason: "unresolvable concatenation" };
    return { resolved: true, value: (l.resolved ? l.value : INTERP) + (r.resolved ? r.value : INTERP) };
  }

  if (ts.isIdentifier(node)) {
    const bound = ctx.lookupConst(node.text);
    if (bound !== undefined) return { resolved: true, value: bound };
    // A path is very often assembled into a local before the request:
    //     const url = `/v1/reviewer-workspace?teamId=${teamId}`;
    //     apiFetch(url, …)
    // Reading only string-LITERAL bindings loses every one of those, and the
    // loss shows up as an unresolvable request rather than as a missing route.
    const bindingNode = ctx.lookupNode?.(node.text);
    if (bindingNode !== undefined && bindingNode !== null) {
      return resolvePathExpr(bindingNode, { ...ctx, lookupNode: undefined });
    }
    return { resolved: false, reason: `identifier '${node.text}' is not a static string constant` };
  }

  // `new URL("/v1/x", base)` — the first argument carries the path.
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL") {
    return resolvePathExpr(node.arguments?.[0], ctx);
  }

  if (ts.isParenthesizedExpression(node)) return resolvePathExpr(node.expression, ctx);

  // `cond ? a : b` — both branches are possible call targets, so a resolvable
  // branch is reported rather than discarded. Returning the first resolvable
  // branch under-reports at worst; guessing would over-report.
  if (ts.isConditionalExpression(node)) {
    const a = resolvePathExpr(node.whenTrue, ctx);
    if (a.resolved) return a;
    return resolvePathExpr(node.whenFalse, ctx);
  }

  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    // Encoding helpers wrap a value, not a path: the result is one segment.
    if (name === "encodeURIComponent" || name === "encodeURI" || name === "String")
      return { resolved: true, value: INTERP };

    // A local helper that RETURNS a path — `buildUrl()`, `submitUrl()`, and the
    // `scoped("/v1/dashboard/records-by-type")` shape that appends a workspace
    // query. Two readings, in order: what the helper itself returns, and
    // failing that, a path handed TO it and passed through. Both are resolved
    // by the caller-supplied `resolveCall`, which is the only part that needs
    // file scope.
    if (name !== null && ctx.resolveCall) {
      const viaCall = ctx.resolveCall(name, node);
      if (viaCall !== undefined && viaCall !== null) return { resolved: true, value: viaCall };
    }
  }

  return { resolved: false, reason: `unsupported expression kind ${ts.SyntaxKind[node.kind]}` };
}

export function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** `obj.method` -> "obj", for distinguishing `app.get` from `router.get`. */
export function calleeObject(call) {
  const e = call.expression;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) return e.expression.text;
  return null;
}

// ===========================================================================
// CONSTANT BINDINGS — local and imported.
//
// A consumer may name its path: `const EXPORT_PATH = "/v1/admin/audit-log/export"`.
// Without this, every such call is invisible.
// ===========================================================================

function collectConsts(sf) {
  const consts = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isStringLiteralLike(node.initializer)) consts.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return consts;
}

/**
 * Every `const x = <expr>` binding, as an AST NODE.
 *
 * Only bindings whose initializer could carry a path are kept — a template, a
 * concatenation, a conditional, another identifier or a call — so the map does
 * not grow a node for every unrelated variable in the tree.
 */
function collectBindingNodes(sf) {
  const nodes = new Map();
  const interesting = (n) =>
    ts.isTemplateExpression(n) ||
    ts.isBinaryExpression(n) ||
    ts.isConditionalExpression(n) ||
    ts.isIdentifier(n) ||
    ts.isCallExpression(n) ||
    ts.isNewExpression(n) ||
    ts.isNoSubstitutionTemplateLiteral(n);
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      interesting(node.initializer) &&
      !nodes.has(node.name.text)
    ) {
      nodes.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return nodes;
}

/**
 * Local functions that RETURN a path, keyed by name.
 *
 * Two readings are stored. `returns` is what the function produces on its own
 * (`buildUrl()` composing `/v1/x?cursor=…`). `passthroughArg` records that the
 * function's return is derived from one of its own parameters, which is the
 * `scoped(p)` shape — there the path is whatever the CALLER supplied, so it is
 * resolved from the call's arguments instead.
 */
/**
 * Unwraps the React hook forms so `const buildUrl = useCallback((c) => …, deps)`
 * is seen as the function it obviously is. Every path helper on a client page in
 * this repository is written that way, so not unwrapping it means the resolver
 * fails on exactly the files that matter most.
 */
function asFunctionNode(init) {
  if (!init) return null;
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
  if (ts.isCallExpression(init)) {
    const callee = calleeName(init);
    if (callee === "useCallback" || callee === "useMemo") {
      const first = init.arguments?.[0];
      if (first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first))) return first;
    }
  }
  return null;
}

function collectPathFns(sf) {
  const fns = new Map();
  const visit = (node) => {
    let name = null;
    let fn = null;
    if (ts.isFunctionDeclaration(node) && node.name) {
      name = node.name.text;
      fn = node;
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const unwrapped = asFunctionNode(node.initializer);
      if (unwrapped !== null) {
        name = node.name.text;
        fn = unwrapped;
      }
    }
    if (name !== null && fn !== null && !fns.has(name)) {
      const params = new Set((fn.parameters ?? []).filter((p) => ts.isIdentifier(p.name)).map((p) => p.name.text));
      const returns = [];
      if (fn.body && !ts.isBlock(fn.body)) returns.push(fn.body);
      else if (fn.body) {
        const scan = (n) => {
          if (ts.isReturnStatement(n) && n.expression) returns.push(n.expression);
          if (!ts.isFunctionDeclaration(n) && !ts.isArrowFunction(n) && !ts.isFunctionExpression(n)) {
            ts.forEachChild(n, scan);
          }
        };
        ts.forEachChild(fn.body, scan);
      }
      if (returns.length > 0) fns.set(name, { returns, params });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return fns;
}

/** Imported bindings: local name -> { module, exported }. */
function collectImports(sf) {
  const imports = new Map();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    if (!ts.isStringLiteralLike(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const named = st.importClause.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) {
        imports.set(el.name.text, { module: spec, exported: (el.propertyName ?? el.name).text });
      }
    }
  }
  return imports;
}

/** Resolve a relative import specifier to a file we have parsed. */
function resolveModule(fromFile, spec, parsedByPath) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(path.join(REPO, fromFile)), spec.replace(/\.js$/, ""));
  for (const ext of [".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.tsx", "/index.js"]) {
    const candidate = rel(base + ext);
    if (parsedByPath.has(candidate)) return candidate;
  }
  return null;
}

// ===========================================================================
// REQUEST CALL DETECTION
//
// The seed set is the functions that genuinely perform a request. Wrappers
// are then DISCOVERED: any function that forwards one of its parameters into
// a known request call is itself a request function, and the fixpoint below
// keeps widening until nothing new is found — which is what makes
// wrapper-calling-wrapper work without naming each layer.
// ===========================================================================

/**
 * `apiBaseUrl` and `apiUrl` are deliberately NOT here. They return an ORIGIN;
 * they perform nothing. Seeding them made every `apiBaseUrl()` look like a
 * request with no path — an unresolvable call that is not a call at all. The
 * `fetch` those origins feed is seeded, which is where the path actually is.
 */
const SEED_REQUEST_FNS = new Set(["fetch", "apiFetch", "apiRequest", "request", "authedFetch"]);

/**
 * `includeTests` exists for ONE caller: the test-caller diagnostic.
 *
 * The default is `false` and must stay that way. Excluding tests is not an
 * oversight in the consumer authority, it is the authority's central claim —
 * a proof suite calling a route is exactly what makes an orphan look connected,
 * so counting it would let a dead surface pass as wired. Nothing that produces
 * a CLASSIFICATION may pass `true`.
 *
 * The diagnostic does pass `true`, because "this route's only callers are
 * tests" is a genuinely different fact from "this route has no callers at all",
 * and it is not derivable from records that never parsed a test file. It is
 * published as a diagnostic and never as a consumer.
 */
export function analyzeSources({ includeTests = false } = {}) {
  /** @type {Map<string,{file:string,class:string,product:boolean,sf:any,consts:Map<string,string>,imports:Map<string,any>}>} */
  const parsedByPath = new Map();

  // Suites live OUTSIDE every product root — `services/api/test`, not
  // `services/api/src/test` — so un-skipping test FILES is not enough to see
  // them; the diagnostic has to be given the roots as well. They are never
  // added in the default mode, and `product: false` guarantees that even if
  // one were somehow reached it could not become a product consumer.
  const trees = includeTests
    ? [
        ...TREES,
        {
          class: "TEST",
          product: false,
          roots: [
            "services/api/test",
            "services/worker/test",
            "apps/web/__tests__",
            "apps/mobile/test",
            "e2e",
          ],
        },
      ]
    : TREES;

  for (const tree of trees) {
    for (const root of tree.roots) {
      for (const abs of walk(root)) {
        const file = rel(abs);
        if (parsedByPath.has(file)) continue;
        if (!includeTests && isTestPath(file)) continue;
        let text;
        try {
          text = readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        const sf = parse(file, text);
        parsedByPath.set(file, {
          file,
          class: tree.class,
          product: tree.product,
          sf,
          consts: collectConsts(sf),
          bindings: collectBindingNodes(sf),
          pathFns: collectPathFns(sf),
          imports: collectImports(sf),
        });
      }
    }
  }

  // --- Fixpoint over request-performing functions -------------------------
  // Key: "file#functionName". Seeded with the globally-known request APIs and
  // widened until stable.
  const requestFns = new Set();
  const localName = (file, name) => `${file}#${name}`;

  const ctxFor = (entry, guard = new Set()) => {
    const ctx = {
      lookupConst: (name) => {
        const own = entry.consts.get(name);
        if (own !== undefined) return own;
        const imp = entry.imports.get(name);
        if (!imp) return undefined;
        const target = resolveModule(entry.file, imp.module, parsedByPath);
        if (!target) return undefined;
        return parsedByPath.get(target).consts.get(imp.exported);
      },
      lookupNode: (name) => {
        if (guard.has(`v:${name}`)) return undefined;
        const own = entry.bindings.get(name);
        if (own === undefined) return undefined;
        guard.add(`v:${name}`);
        return own;
      },
      resolveCall: (name, call) => {
        if (guard.has(`f:${name}`)) return undefined;
        const fn = entry.pathFns.get(name);
        if (fn === undefined) return undefined;
        guard.add(`f:${name}`);
        const inner = ctxFor(entry, guard);
        for (const ret of fn.returns) {
          const r = resolvePathExpr(ret, inner);
          if (r.resolved && r.value.startsWith("/")) return r.value;
        }
        // Pass-through shape: the helper decorates a path its CALLER supplied.
        for (const arg of call.arguments ?? []) {
          const r = resolvePathExpr(arg, inner);
          if (r.resolved && r.value.startsWith("/")) return r.value;
        }
        return undefined;
      },
    };
    return ctx;
  };

  /**
   * The `file#name` key of the request function a call targets, or a seed name,
   * or null. Exposed because WHICH function is reached decides whether the
   * caller has to supply a path at all.
   */
  const requestFnKeyFor = (call, entry) => {
    const name = calleeName(call);
    if (name === null) return null;
    if (SEED_REQUEST_FNS.has(name)) return `<seed>#${name}`;
    if (requestFns.has(localName(entry.file, name))) return localName(entry.file, name);
    const imp = entry.imports.get(name);
    if (imp) {
      const target = resolveModule(entry.file, imp.module, parsedByPath);
      if (target && requestFns.has(localName(target, imp.exported))) return localName(target, imp.exported);
    }
    return null;
  };

  const isRequestCall = (call, entry) => requestFnKeyFor(call, entry) !== null;

  for (let round = 0; round < 6; round += 1) {
    let grew = false;
    for (const entry of parsedByPath.values()) {
      const visit = (node) => {
        const fnName = declaredFunctionName(node);
        if (fnName !== null) {
          // `node.parameters` exists on a FunctionDeclaration but not on the
          // VariableDeclaration wrapping an arrow. Reading it off the wrong node
          // yields an empty parameter set, and an empty set silently disqualifies
          // every arrow-bodied wrapper from ever being discovered.
          const fnNode = functionNodeOf(node);
          const params = new Set(
            (fnNode?.parameters ?? []).filter((p) => ts.isIdentifier(p.name)).map((p) => p.name.text),
          );
          if (params.size > 0 && forwardsParamIntoRequest(node, params, entry, isRequestCall)) {
            const key = localName(entry.file, fnName);
            if (!requestFns.has(key)) {
              requestFns.add(key);
              grew = true;
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(entry.sf);
    }
    if (!grew) break;
  }

  // --- Path-BUILDING versus path-FORWARDING wrappers ----------------------
  //
  // Two kinds of request wrapper exist and they place opposite demands on the
  // caller. `apiFetch(path, init)` FORWARDS: it knows nothing until a caller
  // names the path, so its call sites are where routes are discovered. But
  // `fetchComments(workflowId)` BUILDS: the path
  // `/v1/portal/work/${workflowId}/comments` is written inside it, already
  // recorded at that inner call site, and the outer `fetchComments(workflowId)`
  // carries no path at all.
  //
  // Without this distinction every call to a path-building wrapper is reported
  // as an unresolvable request — 128 of them here — which is not an unknown
  // about the system but an artefact of asking the wrong function for a path.
  //
  // Building is TRANSITIVE. `runDecide(verdict)` forwards a parameter into
  // `bulkDecide({verdict, …})`, so the forwarding test marks it a wrapper — but
  // what it forwards is a request BODY, and `bulkDecide` writes the path itself.
  // The path is therefore already fully determined before `runDecide` is called,
  // and asking `runDecide`'s call sites for one produces an unresolved request
  // for a route that was never in doubt. So a wrapper whose every request call
  // targets a path-building function is itself path-building, and the set is
  // grown to a fixpoint rather than computed in one pass.
  const pathBuildingFns = new Set();
  for (let round = 0; round < 8; round += 1) {
    let grew = false;
    for (const entry of parsedByPath.values()) {
      const visit = (node) => {
        const fnName = declaredFunctionName(node);
        const key = fnName === null ? null : localName(entry.file, fnName);
        if (key !== null && requestFns.has(key) && !pathBuildingFns.has(key)) {
          const fnNode = functionNodeOf(node);
          const body = fnNode?.body;
          if (body) {
            const ownParams = new Set(
              (fnNode.parameters ?? []).filter((p) => ts.isIdentifier(p.name)).map((p) => p.name.text),
            );
            let builds = false;
            let forwards = false;
            let requestCalls = 0;
            let allTargetsBuild = true;
            const scan = (n) => {
              if (ts.isCallExpression(n) && isRequestCall(n, entry)) {
                requestCalls += 1;
                const arg = n.arguments?.[0];
                // A fresh context per resolution: the cycle guard inside
                // `ctxFor` is single-use by design, and sharing one across call
                // sites would make the SECOND resolution in a file silently fail.
                const r = resolvePathExpr(arg, ctxFor(entry));
                if (r.resolved && r.value.startsWith("/")) builds = true;
                else {
                  // The path argument is (or contains) one of THIS function's
                  // own parameters and did not resolve to a path shape — the
                  // caller supplies the whole path.
                  if (arg && ownParams.size > 0 && mentionsIdentifier(arg, ownParams)) forwards = true;
                  const target = requestFnKeyFor(n, entry);
                  if (target === null || !pathBuildingFns.has(target)) allTargetsBuild = false;
                }
              }
              ts.forEachChild(n, scan);
            };
            scan(body);
            // FORWARDING WINS. A wrapper can do both: `handleAuth(path)` on the
            // register page forwards its `path` parameter into `apiFetch(path)`
            // AND makes one literal `apiFetch("/v1/evidence/claim")` call for the
            // guest-claim step. Reading the literal as proof that the wrapper
            // builds its own paths suppressed every call site — so
            // `POST /v1/auth/email/register`, the sign-up route the register page
            // plainly calls, was reported as having no product consumer at all.
            if (!forwards && (builds || (requestCalls > 0 && allTargetsBuild))) {
              pathBuildingFns.add(key);
              grew = true;
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(entry.sf);
    }
    if (!grew) break;
  }

  return { parsedByPath, requestFns, ctxFor, isRequestCall, requestFnKeyFor, pathBuildingFns };
}

/** The callable node behind a declaration, whichever form it was written in. */
function functionNodeOf(node) {
  if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
  if (ts.isVariableDeclaration(node)) return asFunctionNode(node.initializer);
  return null;
}

function declaredFunctionName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && asFunctionNode(node.initializer)) {
    return node.name.text;
  }
  return null;
}

/** True when some parameter of `fn` flows into the first argument of a request call. */
function forwardsParamIntoRequest(fn, params, entry, isRequestCall) {
  const body = functionNodeOf(fn)?.body;
  if (!body) return false;
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isCallExpression(node) && isRequestCall(node, entry)) {
      if (paramReachesPathPosition(node.arguments?.[0], params)) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/**
 * Does a parameter reach the PATH position of a request call?
 *
 * `mentionsIdentifier(arg0, params)` was too loose. `runDecide(verdict)` calls
 * `bulkDecide({ verdict, workflowIds, teamId })` — the parameter appears in
 * argument zero, but as a BODY field of an options object, and `bulkDecide`
 * writes its own path. Counting that as path-forwarding made `runDecide` a
 * request wrapper whose callers were then expected to supply a path they never
 * had, and each such call site surfaced as an unresolvable request.
 *
 * The path position is: the argument itself, a string built from it, or the
 * `path`/`url` property of an options object. Nothing else.
 */
function paramReachesPathPosition(arg, params) {
  if (!arg) return false;
  if (ts.isObjectLiteralExpression(arg)) {
    for (const p of arg.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const key = ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) ? p.name.text : null;
      if ((key === "path" || key === "url") && mentionsIdentifier(p.initializer, params)) return true;
    }
    return false;
  }
  return mentionsIdentifier(arg, params);
}

function mentionsIdentifier(node, names) {
  let hit = false;
  const visit = (n) => {
    if (hit) return;
    if (ts.isIdentifier(n) && names.has(n.text)) hit = true;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

// ===========================================================================
// PATH NORMALIZATION
// ===========================================================================

/**
 * `/v1/workspaces/...` is rewritten to `/v1/teams/...` by
 * `routes/workspace-alias.plugin.ts` in an `onRequest` hook, BEFORE Fastify
 * matches a route. A caller of `/v1/workspaces/:id` is therefore a genuine
 * caller of the registered `/v1/teams/:id` handler, and any analysis that
 * compares raw strings misses every one of them.
 */
const ALIASES = Object.freeze([{ from: "/v1/workspaces", to: "/v1/teams" }]);

export function normalizePath(raw) {
  let p = String(raw);
  p = p.split("?")[0].split("#")[0];
  for (const a of ALIASES) {
    if (p === a.from || p.startsWith(`${a.from}/`)) {
      p = a.to + p.slice(a.from.length);
      break;
    }
  }
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/**
 * Candidate readings of a consumer path.
 *
 * A FINAL segment mixing literal text with a trailing interpolation is
 * genuinely ambiguous — in `/v1/admin/audit-log/export${qs ? "?" + qs : ""}`
 * the interpolation is a QUERY SUFFIX, and read strictly the segment
 * `export<interp>` never matches the literal `export`. So the literal-only
 * reading is offered too. Narrow on purpose: a final segment that is PURELY an
 * interpolation is a path PARAMETER, and shortening it would credit
 * `/v1/cases/${id}` as a call to `GET /v1/cases`.
 */
/**
 * The string literals an expression can take, when its DECLARED TYPE says so.
 *
 * `async function postAction(itemKey: string, action: "read" | "unread" |
 * "dismiss" | "snooze")` builds `/v1/me/inbox/items/${itemKey}/${action}`. The
 * value of `action` is unknown at any single call, but the SET is written down
 * in the signature, so the four routes it reaches are not a matter of judgement.
 * Reading the annotation turns four false orphans into four proven consumers
 * without guessing anything: an expression with no literal-union annotation
 * returns null and stays an honest interpolation.
 */
export function literalUnionOf(node) {
  if (!node || !ts.isIdentifier(node)) return null;
  const name = node.text;
  let scope = node.parent;
  while (scope) {
    const params =
      ts.isFunctionDeclaration(scope) || ts.isArrowFunction(scope) || ts.isFunctionExpression(scope) || ts.isMethodDeclaration(scope)
        ? (scope.parameters ?? [])
        : [];
    for (const p of params) {
      if (!ts.isIdentifier(p.name) || p.name.text !== name) continue;
      const values = unionLiterals(p.type, node.getSourceFile());
      if (values !== null) return values;
    }
    scope = scope.parent;
  }
  return forOfTupleLiterals(node);
}

/**
 * Values an identifier takes when it is destructured out of a literal table.
 *
 *     for (const [leg, run] of [["suspend", …], ["resume", …]] as const) {
 *       app.post(`/v1/admin/orgs/:id/${leg}`, …)
 *     }
 *
 * That registers TWO routes. Resolving `leg` to an interpolation instead
 * produced one route named `/v1/admin/orgs/:id/<interp>` — not an admitted
 * unknown, which would at least be visible, but a confident entry for a path
 * that does not exist, while the two real ones were absent from the inventory
 * entirely. The table is right there in the loop header, so this reads it.
 */
function forOfTupleLiterals(node) {
  const name = node.text;
  let cur = node.parent;
  while (cur) {
    if (ts.isForOfStatement(cur) && ts.isVariableDeclarationList(cur.initializer)) {
      for (const decl of cur.initializer.declarations) {
        let index = -1;
        if (ts.isArrayBindingPattern(decl.name)) {
          decl.name.elements.forEach((el, i) => {
            if (!ts.isOmittedExpression(el) && ts.isIdentifier(el.name) && el.name.text === name) index = i;
          });
        } else if (ts.isIdentifier(decl.name) && decl.name.text === name) {
          index = null; // the whole element IS the value
        }
        if (index === -1) continue;

        let table = cur.expression;
        while (ts.isAsExpression(table) || ts.isParenthesizedExpression(table)) table = table.expression;
        if (!ts.isArrayLiteralExpression(table)) continue;

        const out = [];
        for (let element of table.elements) {
          while (ts.isAsExpression(element) || ts.isParenthesizedExpression(element)) element = element.expression;
          if (index === null) {
            if (!ts.isStringLiteralLike(element)) return null;
            out.push(element.text);
            continue;
          }
          if (!ts.isArrayLiteralExpression(element)) return null;
          let slot = element.elements[index];
          if (!slot) return null;
          while (slot && (ts.isAsExpression(slot) || ts.isParenthesizedExpression(slot))) slot = slot.expression;
          if (!ts.isStringLiteralLike(slot)) return null;
          out.push(slot.text);
        }
        if (out.length > 0) return out;
      }
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * Concrete readings of a template whose interpolations are statically
 * enumerable. Returns [] when nothing in it is.
 */
export function expandTemplate(node, resolve, cap = 24) {
  if (!node || !ts.isTemplateExpression(node)) return [];
  const spans = [];
  let expandable = false;
  for (const span of node.templateSpans) {
    const union = literalUnionOf(span.expression);
    if (union !== null) {
      expandable = true;
      spans.push(union);
    } else {
      const r = resolve(span.expression);
      spans.push([r.resolved ? r.value : INTERP]);
    }
  }
  if (!expandable) return [];
  let total = 1;
  for (const s of spans) total *= s.length;
  if (total > cap) return [];
  let out = [node.head.text];
  node.templateSpans.forEach((span, i) => {
    const next = [];
    for (const prefix of out) for (const v of spans[i]) next.push(prefix + v + span.literal.text);
    out = next;
  });
  return out;
}

function unionLiterals(typeNode, sf, depth = 2) {
  if (!typeNode || depth < 0) return null;
  if (ts.isLiteralTypeNode(typeNode) && ts.isStringLiteralLike(typeNode.literal)) {
    return [typeNode.literal.text];
  }
  if (ts.isUnionTypeNode(typeNode)) {
    const out = [];
    for (const t of typeNode.types) {
      const inner = unionLiterals(t, sf, depth - 1);
      if (inner === null) return null;
      out.push(...inner);
    }
    return out.length > 0 ? out : null;
  }
  // A NAMED union — `type WorkflowActionKey = "start" | "assign" | …` — is the
  // usual way this repository writes an action set. Reading only inline unions
  // covers the small cases and misses the deliberate ones.
  if (ts.isTypeReferenceNode(typeNode) && sf && ts.isIdentifier(typeNode.typeName)) {
    const name = typeNode.typeName.text;
    for (const st of sf.statements) {
      if (ts.isTypeAliasDeclaration(st) && st.name.text === name) {
        return unionLiterals(st.type, sf, depth - 1);
      }
    }
  }
  return null;
}

export function candidatePaths(normalized) {
  const out = new Set([normalized]);
  const segs = normalized.split("/");
  const last = segs[segs.length - 1];
  if (last.includes(INTERP) && last !== INTERP) {
    const literalOnly = last.slice(0, last.indexOf(INTERP));
    if (literalOnly.length > 0) out.add([...segs.slice(0, -1), literalOnly].join("/"));
  }
  return [...out];
}

/** A route pattern matches a consumer path when they agree segment by segment. */
export function matches(routePattern, consumerPath) {
  const r = routePattern.split("/");
  const c = consumerPath.split("/");
  if (r[r.length - 1] === "*") {
    if (c.length < r.length - 1) return false;
    return r.slice(0, -1).every((seg, i) => segMatch(seg, c[i]));
  }
  if (r.length !== c.length) return false;
  return r.every((seg, i) => segMatch(seg, c[i]));
}

/**
 * Deliberately CONSERVATIVE in one direction.
 *
 * A `:param` route segment accepts anything — that is what it means. A LITERAL
 * route segment is NOT satisfied by an interpolated consumer segment, even
 * though `${id}` could in principle evaluate to that literal: allowing it
 * credits a call to the update-by-id route as a caller of
 * `GET /v1/integrations/webhooks/endpoints`, manufacturing the exact false
 * "this endpoint is wired" claim this analyzer exists to prevent.
 *
 * The two possible errors are not symmetric. Over-matching HIDES an orphan;
 * under-matching only forces a human to write a disposition.
 */
export function segMatch(routeSeg, consumerSeg) {
  if (consumerSeg === undefined) return false;
  if (routeSeg.startsWith(":")) return true;
  if (consumerSeg.includes(INTERP)) return false;
  return routeSeg === consumerSeg;
}
