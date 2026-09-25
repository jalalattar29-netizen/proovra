#!/usr/bin/env node
/**
 * CONTRACT AUDIT — does a native parser read the keys the server actually sends?
 *
 * WHY THIS EXISTS
 *
 * The Native closure gates proved the ledger was self-consistent, that every
 * route resolved, and that each pure projection behaved as its author had
 * specified. 66 test files and 2156 assertions, and not one of them compared a
 * fixture to a real server response. So `parseLegalNotes` and `parseAnnotations`
 * could read `notes` / `annotations` while both routes answered `{ items }`,
 * ship unable to display a single row, and pass everything (F-09).
 *
 * A test written from the same misunderstanding as the code cannot catch the
 * misunderstanding. The only thing that can is reading the server.
 *
 * WHAT IT DOES
 *
 * 1. SERVER   Walks services/api/src/routes/*.ts and, for every GET handler,
 *             collects the top-level keys of the object it sends on success.
 * 2. NATIVE   Walks apps/mobile/src/product/*.ts for the pure path builders
 *             (template -> path pattern) and, for each `parse*`, the top-level
 *             keys it reads off the payload.
 * 3. BIND     Walks the screens for the statement where a builder's path is
 *             fetched and a parser is applied to the result.
 * 4. COMPARE  For each binding, does the parser read at least one key the
 *             route actually sends - or does it accept a bare array where the
 *             route sends an envelope?
 *
 * It states what it cannot resolve rather than passing it. An UNRESOLVED
 * server envelope is not a pass, and the matrix says so per row.
 *
 * Usage:  node tools/contract-audit.mjs [--json] [--check]
 *   --check exits 1 on any MISMATCH. UNRESOLVED rows are reported, not failed,
 *           because a tool that cannot read a handler must not claim the
 *           handler is wrong.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { existsSync, statSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const MOBILE = resolve(import.meta.dirname, "..");
const REPO = resolve(MOBILE, "..", "..");
const API_ROUTES = join(REPO, "services", "api", "src", "routes");
const PRODUCT = join(MOBILE, "src", "product");

const sf = (file) =>
  ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);

const files = (dir, suffix) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .map((f) => join(dir, f));

function walk(node, fn) {
  fn(node);
  ts.forEachChild(node, (c) => walk(c, fn));
}

/* ------------------------------------------------------------------ server */

/** The property names of an object literal, or null if it is not one. */
function literalKeys(expr, scope, ctx) {
  if (!expr) return null;
  if (ts.isParenthesizedExpression(expr)) return literalKeys(expr.expression, scope, ctx);
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
    return literalKeys(expr.expression, scope, ctx);
  }
  if (ts.isArrayLiteralExpression(expr)) return ["<ARRAY>"];
  if (ts.isObjectLiteralExpression(expr)) {
    const keys = [];
    for (const p of expr.properties) {
      if (ts.isSpreadAssignment(p)) {
        // A spread of a known local widens the envelope; a spread of anything
        // else means we do not know the full key set.
        const inner = literalKeys(p.expression, scope, ctx);
        if (inner) keys.push(...inner);
        else keys.push("<SPREAD>");
        continue;
      }
      const name = p.name;
      if (!name) continue;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) keys.push(name.text);
      else keys.push("<COMPUTED>");
    }
    return keys;
  }
  if (ts.isAwaitExpression(expr)) return literalKeys(expr.expression, scope, ctx);
  // `send(payload)` where payload is a local - of any shape, not only an
  // object literal. The guard is the visited set, not the node kind.
  if (ts.isIdentifier(expr) && scope.has(expr.text)) {
    const seen = ctx?.seen ?? new Set();
    if (seen.has(expr.text)) return null;
    seen.add(expr.text);
    return literalKeys(scope.get(expr.text), scope, { ...ctx, seen });
  }
  // `send(await buildCasesSummary(...))` — the envelope is assembled by a
  // service, so the keys are in ANOTHER module. Not following the import is
  // how the capability analyzer spent a hundred routes reporting "unsupported
  // expression kind"; the same blindness here would report the two biggest
  // envelopes in the app as unreadable.
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && ctx) {
    return returnedKeysOf(expr.expression.text, ctx);
  }
  return null;
}

/* ----- following an import into services/api/src to read what it returns ---- */

const moduleCache = new Map();

function loadModule(file) {
  if (moduleCache.has(file)) return moduleCache.get(file);
  let src = null;
  for (const candidate of [`${file}.ts`, file, join(file, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      src = sf(candidate);
      break;
    }
  }
  moduleCache.set(file, src);
  return src;
}

/** name -> the module file it is imported from, for one source file. */
function importMap(src) {
  const map = new Map();
  const dir = dirname(src.fileName);
  for (const stmt of src.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    if (!spec.startsWith(".")) continue;
    const target = resolve(dir, spec.replace(/\.js$/, ""));
    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) map.set(el.name.text, target);
    }
  }
  return map;
}

/**
 * The top-level keys of every object literal `name` returns, following one
 * import hop. `ctx` is { src, depth } for the file the call was seen in.
 */
function returnedKeysOf(name, ctx) {
  if (!ctx || ctx.depth > 2) return null;
  const local = findFunction(ctx.src, name);
  const target = local ? ctx.src : loadModule(importMap(ctx.src).get(name) ?? "");
  if (!target) return null;
  const fn = local ?? findFunction(target, name);
  if (!fn || !fn.body) return null;

  const scope = new Map();
  walk(fn.body, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      scope.set(n.name.text, n.initializer);
    }
  });

  const keys = new Set();
  let found = false;
  walk(fn.body, (n) => {
    if (!ts.isReturnStatement(n) || !n.expression) return;
    // Only the function's OWN returns, not those of callbacks nested in it.
    if (enclosingFunction(n) !== fn) return;
    const k = literalKeys(n.expression, scope, {
      src: target,
      depth: ctx.depth + 1,
      seen: new Set(),
    });
    if (k) {
      found = true;
      k.forEach((x) => keys.add(x));
    }
  });
  return found ? [...keys] : null;
}

function enclosingFunction(node) {
  let cur = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isMethodDeclaration(cur)
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

/** `function NAME` or `const NAME = (…) => …`, exported or not. */
function findFunction(src, name) {
  let hit = null;
  walk(src, (n) => {
    if (hit) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) hit = n;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      hit = n.initializer;
    }
  });
  return hit;
}

/** Success payloads sent by one handler body. */
function handlerEnvelopes(body, ctx) {
  const scope = new Map();
  walk(body, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      scope.set(n.name.text, n.initializer);
    }
  });

  const payloads = [];
  const addSend = (call) => {
    const arg = call.arguments[0];
    if (arg) payloads.push(arg);
  };

  walk(body, (n) => {
    if (!ts.isCallExpression(n)) return;
    const ex = n.expression;
    if (!ts.isPropertyAccessExpression(ex) || ex.name.text !== "send") return;

    // Unwind the whole builder chain - reply.header(..).code(200).type(..).send(x)
    // is one send, and the legal corpus routes use exactly that form. Only the
    // ROOT identifier and the status codes seen on the way matter.
    let cur = ex.expression;
    let status = 200;
    let ok = true;
    while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
      const method = cur.expression.name.text;
      if (method === "code" || method === "status") {
        const arg = cur.arguments[0];
        // `code(added.length > 0 ? 201 : 409)` — a send that is a success on
        // one branch IS a success envelope. Reading it as NaN hid the bulk
        // add-members route's `{ added, failed }` entirely.
        const branches =
          arg && ts.isConditionalExpression(arg) ? [arg.whenTrue, arg.whenFalse] : arg ? [arg] : [];
        const codes = branches.filter((b) => ts.isNumericLiteral(b)).map((b) => Number(b.text));
        status = codes.find((c) => c >= 200 && c < 300) ?? (codes.length === branches.length && codes.length > 0 ? codes[0] : NaN);
      } else if (method !== "header" && method !== "headers" && method !== "type") {
        ok = false;
        break;
      }
      cur = cur.expression.expression;
    }
    if (!ok) return;
    if (!ts.isIdentifier(cur) || cur.text !== "reply") return;
    if (!(status >= 200 && status < 300)) return;
    addSend(n);
  });

  // The handler's OWN returns - an object literal, a local, or the result of
  // a service call. Returns inside a nested callback belong to that callback.
  walk(body, (n) => {
    if (!ts.isReturnStatement(n) || !n.expression) return;
    if (enclosingFunction(n)?.body !== body) return;
    // A reply chain was already counted above as a send.
    let e = n.expression;
    if (ts.isAwaitExpression(e)) e = e.expression;
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      let root = e.expression.expression;
      while (ts.isCallExpression(root) && ts.isPropertyAccessExpression(root.expression)) {
        root = root.expression.expression;
      }
      if (ts.isIdentifier(root) && root.text === "reply") return;
    }
    payloads.push(n.expression);
  });

  const keys = new Set();
  let unresolved = 0;
  for (const p of payloads) {
    const k = literalKeys(p, scope, ctx);
    if (k === null) unresolved += 1;
    else k.forEach((x) => keys.add(x));
  }
  return { keys: [...keys].sort(), payloadCount: payloads.length, unresolved };
}

/** "METHOD path" -> { keys, unresolved, source } for every route. */
export function indexServerRoutes() {
  const index = new Map();
  const METHODS = new Set(["get", "post", "put", "patch", "delete"]);
  for (const file of files(API_ROUTES, ".ts")) {
    const src = sf(file);

    /*
     * A ROUTE PATH HELD IN A FILE-LOCAL CONST IS STILL A ROUTE PATH.
     *
     * `workspace-ai-policy.routes.ts` registers its three routes through
     * `const AI_POLICY_PATH = "/v1/teams/ai-policy"` and so on, because the
     * names carry a comment explaining the alias rewrite. Reading only
     * string-literal first arguments made those three routes invisible here,
     * and a caller of any of them reported UNRESOLVED — an instrument saying
     * the route does not exist when it plainly does.
     *
     * Bounded deliberately: same file, `const`, string-literal initializer.
     * Anything computed is left unresolved rather than guessed at.
     */
    const localPaths = new Map();
    for (const stmt of src.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          ts.isStringLiteral(decl.initializer) &&
          decl.initializer.text.startsWith("/")
        ) {
          localPaths.set(decl.name.text, decl.initializer.text);
        }
      }
    }

    walk(src, (n) => {
      if (!ts.isCallExpression(n)) return;
      const ex = n.expression;
      if (!ts.isPropertyAccessExpression(ex)) return;
      const method = ex.name.text;
      if (!METHODS.has(method)) return;
      const first = n.arguments[0];
      if (!first) return;
      const path = ts.isStringLiteral(first)
        ? first.text
        : ts.isIdentifier(first)
          ? localPaths.get(first.text)
          : undefined;
      if (!path || !path.startsWith("/")) return;

      // The handler is the last argument - unless the route states its
      // options object last and carries the handler as a PROPERTY of it, which
      // is how collaboration-teams registers every one of its routes.
      let handler = n.arguments[n.arguments.length - 1];
      if (handler && ts.isObjectLiteralExpression(handler)) {
        handler = handler.properties.find(
          (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "handler",
        )?.initializer;
      }
      if (
        !handler ||
        (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) ||
        !handler.body
      ) {
        return;
      }
      const env = handlerEnvelopes(handler.body, { src, depth: 0 });
      index.set(`${method.toUpperCase()} ${path}`, {
        ...env,
        path,
        method: method.toUpperCase(),
        source: `${basename(file)}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`,
      });
    });
  }
  return index;
}

/* ------------------------------------------------------------------ native */

/**
 * A template literal path -> a pattern comparable with the route string.
 *
 * An interpolation is a path PARAMETER unless `scope` knows it to be another
 * resolved path fragment, which is how `${CASES_SUMMARY_PATH}?teamId=…` and
 * `${base}?cursor=…` resolve instead of becoming `:p?teamId=…`.
 */
function templateToPattern(expr, scope = new Map()) {
  if (!expr) return null;
  if (ts.isParenthesizedExpression(expr)) return templateToPattern(expr.expression, scope);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isIdentifier(expr)) return scope.get(expr.text) ?? null;
  // `"/v1/x/" + ` + a second template: two reviewer-criteria builders and the
  // derived-review one split the path from its query across a `+`.
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = templateToPattern(expr.left, scope);
    const right = templateToPattern(expr.right, scope);
    return left === null || right === null ? null : left + right;
  }
  // `(suffix ? `?${suffix}` : "")` — the shortest branch is the path without
  // its query, which is the only part a route pattern can be compared against.
  if (ts.isConditionalExpression(expr)) {
    const branches = returnedPatterns(expr, scope);
    return branches.length ? branches.reduce((a, b) => (a.length <= b.length ? a : b)) : null;
  }
  // A path SEGMENT built at runtime is a parameter, exactly like an
  // interpolation: `"/v1/x/" + encodeURIComponent(id)`.
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    return expr.expression.text === "encodeURIComponent" ? ":p" : (scope.get(expr.expression.text) ?? null);
  }
  if (!ts.isTemplateExpression(expr)) return null;
  let out = expr.head.text;
  for (const span of expr.templateSpans) {
    const e = span.expression;
    // One builder composing another: `\${buildCollaborationTeamPath(id)}/activity`.
    const known = ts.isIdentifier(e)
      ? (scope.get(e.text) ?? null)
      : ts.isCallExpression(e) && ts.isIdentifier(e.expression)
        ? (scope.get(e.expression.text) ?? null)
        : null;
    out += known ?? ":p";
    out += span.literal.text;
  }
  return out;
}

/** Every path a return statement can yield, including both ternary branches. */
function returnedPatterns(expr, scope) {
  if (ts.isParenthesizedExpression(expr)) return returnedPatterns(expr.expression, scope);
  if (ts.isConditionalExpression(expr)) {
    return [
      ...returnedPatterns(expr.whenTrue, scope),
      ...returnedPatterns(expr.whenFalse, scope),
    ];
  }
  const p = templateToPattern(expr, scope);
  return p ? [p] : [];
}

/** Module-level `const X = "/v1/…"` declarations, by name. */
function moduleConsts(src) {
  const consts = new Map();
  for (const stmt of src.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const p = templateToPattern(d.initializer, consts);
      if (p) consts.set(d.name.text, p);
    }
  }
  return consts;
}

/** build*Path name -> path pattern (query strings stripped). */
export function indexPathBuilders() {
  const builders = new Map();
  const resolved = new Map();
  // Two passes: a builder composed from another resolves once its part has.
  for (let pass = 0; pass < 2; pass += 1)
  for (const file of files(PRODUCT, ".ts")) {
    const src = sf(file);
    // A builder may compose a plain local helper - `sessionBase(token, id)` -
    // rather than another build*Path. The name is not the contract; the path is.
    const helpers = new Set();
    walk(src, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name && n.body) {
        let returnsPath = false;
        walk(n.body, (r) => {
          if (!ts.isReturnStatement(r) || !r.expression) return;
          const p = templateToPattern(r.expression, moduleConsts(src));
          if (p && p.startsWith("/")) returnsPath = true;
        });
        if (returnsPath) helpers.add(n.name.text);
      }
    });
    const consts = new Map([...moduleConsts(src), ...resolved]);
    walk(src, (n) => {
      if (!ts.isFunctionDeclaration(n) || !n.name || !n.body) return;
      const name = n.name.text;
      if (!/^build[A-Za-z0-9]*(Path|Query)$/.test(name) && !helpers.has(name)) return;

      // A builder may assemble the path from a module const and branch on a
      // cursor, so resolve local consts too, then take the SHORTEST return -
      // the branch without a query string.
      const locals = new Map(consts);
      walk(n.body, (v) => {
        if (!ts.isVariableDeclaration(v) || !ts.isIdentifier(v.name) || !v.initializer) return;
        const p = templateToPattern(v.initializer, locals);
        if (p) locals.set(v.name.text, p);
      });

      let pattern = null;
      walk(n.body, (r) => {
        if (!ts.isReturnStatement(r) || !r.expression) return;
        for (const p of returnedPatterns(r.expression, locals)) {
          if (pattern === null || p.length < pattern.length) pattern = p;
        }
      });
      if (pattern) {
        resolved.set(name, pattern.split("?")[0]);
        if (!/^build[A-Za-z0-9]*(Path|Query)$/.test(name)) return; // a helper, not a builder
        builders.set(name, {
          pattern: pattern.split("?")[0],
          source: `${basename(file)}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`,
        });
      }
    });
  }
  return builders;
}

/** parse* name -> the top-level payload keys it reads. */
export function indexParsers() {
  const parsers = new Map();
  const sources = [...files(PRODUCT, ".ts"), ...CONSUMER_DIRS.flatMap((d) => allFiles(d))];
  for (const file of sources) {
    const src = sf(file);
    walk(src, (n) => {
      if (!ts.isFunctionDeclaration(n) || !n.name || !n.body) return;
      const name = n.name.text;
      if (!/^parse[A-Za-z0-9]*$/.test(name)) return;

      const param = n.parameters[0];
      if (!param || !ts.isIdentifier(param.name)) return;
      const payload = param.name.text;

      const keys = new Set();
      let acceptsBare = false;

      // The identifiers holding the payload: `payload`, and any
      // `const d = obj(payload)` / `const d = payload` alias.
      const aliases = new Set([payload]);
      for (let pass = 0; pass < 3; pass += 1) {
        walk(n.body, (v) => {
          if (!ts.isVariableDeclaration(v) || !ts.isIdentifier(v.name) || !v.initializer) return;
          const init = v.initializer;
          let mentions = false;
          let indexes = false;
          walk(init, (d) => {
            if (ts.isIdentifier(d) && aliases.has(d.text)) mentions = true;
            if (
              (ts.isPropertyAccessExpression(d) || ts.isElementAccessExpression(d)) &&
              ts.isIdentifier(d.expression) &&
              aliases.has(d.expression.text)
            ) {
              indexes = true;
            }
          });
          if (mentions && !indexes) aliases.add(v.name.text);
        });
      }

      walk(n.body, (v) => {
        // obj(payload).KEY  /  d.KEY  /  d["KEY"]
        if (ts.isPropertyAccessExpression(v) || ts.isElementAccessExpression(v)) {
          let target = v.expression;
          if (
            ts.isCallExpression(target) &&
            target.arguments.length === 1 &&
            ts.isIdentifier(target.arguments[0]) &&
            aliases.has(target.arguments[0].text)
          ) {
            target = target.arguments[0];
          }
          if (!ts.isIdentifier(target) || !aliases.has(target.text)) return;
          if (ts.isPropertyAccessExpression(v)) keys.add(v.name.text);
          else if (ts.isStringLiteral(v.argumentExpression)) keys.add(v.argumentExpression.text);
          return;
        }
        // listEnvelope(payload, ["items", "notes"])  — the named-key reader.
        if (
          ts.isCallExpression(v) &&
          ts.isIdentifier(v.expression) &&
          v.expression.text === "listEnvelope" &&
          v.arguments.length === 2 &&
          ts.isArrayLiteralExpression(v.arguments[1])
        ) {
          for (const e of v.arguments[1].elements) {
            if (ts.isStringLiteral(e)) keys.add(e.text);
          }
          return;
        }
        // Array.isArray(payload) — the parser tolerates a bare array.
        if (
          ts.isCallExpression(v) &&
          ts.isPropertyAccessExpression(v.expression) &&
          v.expression.name.text === "isArray" &&
          v.arguments.length === 1 &&
          ts.isIdentifier(v.arguments[0]) &&
          aliases.has(v.arguments[0].text)
        ) {
          acceptsBare = true;
        }
      });

      const definitions = parsers.get(name) ?? [];
      definitions.push({
        keys: [...keys].sort(),
        acceptsBare,
        source: `${basename(file)}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`,
      });
      parsers.set(name, definitions);
    });
  }
  return parsers;
}

/* ----------------------------------------------------------------- binding */

const CONSUMER_DIRS = [join(MOBILE, "app"), join(MOBILE, "src", "ui")];

/**
 * Every `const X = "/v1/…"` the app declares: the product modules' exported
 * path constants plus the consuming file's own. A path named once and imported
 * is no less a contract than one spelled inline.
 */
let PRODUCT_CONSTS = null;
function pathConsts(src) {
  if (!PRODUCT_CONSTS) {
    PRODUCT_CONSTS = new Map();
    for (const file of files(PRODUCT, ".ts")) {
      for (const [k, v] of moduleConsts(sf(file))) {
        if (v.startsWith("/")) PRODUCT_CONSTS.set(k, v);
      }
    }
  }
  return new Map([...PRODUCT_CONSTS, ...moduleConsts(src)]);
}

/** The functions that actually put a request on the wire (src/api.ts). */
const FETCHERS = new Set(["apiFetch", "apiFetchText", "publicFetch", "apiRequest"]);

function allFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) allFiles(p, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/**
 * Every place a parser is handed the result of a fetch, paired with the path
 * builder that fetch was given.
 *
 * Directed from the PARSER CALL rather than from the statement around it.
 * Statement proximity was wrong twice over: it bound parseGrantAcceptLink -
 * which reads a deep link, never a response - to the route its neighbour in
 * the same useEffect posted to, and it gave up entirely on
 * `Promise.all([fetchA.then(parseA), fetchB.then(parseB)])`, which is one
 * statement with two independent contracts. That second shape is the one
 * `evidence-internal-materials.tsx` uses, so the instrument was blind to the
 * exact file F-09 was found in.
 */
export function indexBindings() {
  const bindings = [];
  const unbound = [];

  for (const dir of CONSUMER_DIRS) {
    for (const file of allFiles(dir)) {
      const src = sf(file);
      walk(src, (call) => {
        if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return;
        const parser = call.expression.text;
        if (!/^parse[A-Z][A-Za-z0-9]*$/.test(parser)) return;

        const site = `${basename(file)}:${src.getLineAndCharacterOfPosition(call.getStart()).line + 1}`;
        let parserModule = null;
        for (const statement of src.statements) {
          if (
            !ts.isImportDeclaration(statement) ||
            !ts.isStringLiteral(statement.moduleSpecifier)
          ) continue;
          const imports = statement.importClause?.namedBindings;
          if (!imports || !ts.isNamedImports(imports)) continue;
          if (imports.elements.some((e) => e.name.text === parser)) {
            parserModule = statement.moduleSpecifier.text.split("/").pop();
            break;
          }
        }
        const fetchCall = boundFetch(call);
        if (!fetchCall) return; // not reading a response: not a contract.

        // The path argument, followed through a local when the screen builds
        // it a few lines above the fetch - which is how every paginated screen
        // in the app is written.
        let pathArg = fetchCall.arguments[0];
        const builders = new Set();
        const scanBuilders = (node) =>
          walk(node, (d) => {
            if (ts.isIdentifier(d) && /^build[A-Za-z0-9]*(Path|Query)$/.test(d.text)) builders.add(d.text);
          });
        if (pathArg) scanBuilders(pathArg);
        if (builders.size === 0 && pathArg && ts.isIdentifier(pathArg)) {
          const decl = declarationOf(pathArg.text, fetchCall);
          if (decl) {
            pathArg = decl;
            scanBuilders(decl);

            // Follow a local path-producing function, such as
            // const path = pathFor(null), where pathFor is a useCallback
            // wrapping buildSearchPath(...).
            if (
              builders.size === 0 &&
              ts.isCallExpression(decl) &&
              ts.isIdentifier(decl.expression)
            ) {
              const helper = declarationOf(decl.expression.text, fetchCall);
              if (helper) scanBuilders(helper);
            }
          }
        }

        // A literal first argument IS the path.
        let literalPath = null;
        if (builders.size === 0 && pathArg) {
          literalPath = templateToPattern(pathArg, pathConsts(src));
        }

        
if (
  builders.size === 2 &&
  ts.isConditionalExpression(pathArg)
) {
  for (const builder of builders) {
    bindings.push({
      builder,
      literalPath: null,
      parser,
      method: "GET",
      site,
    });
  }
  return;
}

        if (builders.size !== 1 && literalPath === null) {
          unbound.push({
            parser,
            site,
            builders: [...builders],
            why: builders.size > 1 ? "more than one path builder in one fetch" : "path is not resolvable",
          });
          return;
        }

        // The request options travel with the fetch, so the method is read off
        // the same call - never off a sibling in the same statement.
        let method = "GET";
        for (const arg of fetchCall.arguments) {
          walk(arg, (c) => {
            if (
              ts.isPropertyAssignment(c) &&
              ts.isIdentifier(c.name) &&
              c.name.text === "method" &&
              ts.isStringLiteral(c.initializer)
            ) {
              method = c.initializer.text.toUpperCase();
            }
          });
        }

        bindings.push({
          builder: builders.size === 1 ? [...builders][0] : `(literal) ${literalPath}`,
          literalPath: builders.size === 1 ? null : literalPath.split("?")[0],
          parser,
          parserModule,
          method,
          site,
        });
      });
    }
  }

  const seen = new Set();
  return {
    bindings: bindings.filter((b) => {
      const k = `${b.method}|${b.builder}|${b.parser}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
    unbound,
  };
}

/**
 * The fetch whose result this parser call receives, in either shape the app
 * uses: `parseX(await apiFetch(p))`, or `apiFetch(p).then((d) => parseX(d))`.
 */
function boundFetch(call) {
  for (const arg of call.arguments) {
    let hit = null;
    walk(arg, (d) => {
      if (hit) return;
      if (ts.isCallExpression(d) && ts.isIdentifier(d.expression) && FETCHERS.has(d.expression.text)) {
        hit = d;
      }
    });
    if (hit) return hit;
  }

  // parseX(data) where `const data = await apiFetch(p)` came first. Reading
  // only the inline forms left whole screens invisible to this tool - the
  // intake-links list among them - which is the failure mode it exists to
  // prevent, one level up.
  for (const arg of call.arguments) {
    if (!ts.isIdentifier(arg)) continue;
    const decl = declarationOf(arg.text, call);
    if (!decl) continue;
    let init = decl;
    if (ts.isAwaitExpression(init)) init = init.expression;
    if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && FETCHERS.has(init.expression.text)) {
      return init;
    }
  }

  // Climb to the nearest `.then(...)` this call sits inside, and take its
  // receiver. The nearest one, so chained thens bind to the right request.
  let cur = call.parent;
  while (cur) {
    if (
      ts.isCallExpression(cur) &&
      ts.isPropertyAccessExpression(cur.expression) &&
      cur.expression.name.text === "then"
    ) {
      let hit = null;
      walk(cur.expression.expression, (d) => {
        if (hit) return;
        if (
          ts.isCallExpression(d) &&
          ts.isIdentifier(d.expression) &&
          FETCHERS.has(d.expression.text)
        ) {
          hit = d;
        }
      });
      if (hit) return hit;
    }
    if (ts.isFunctionDeclaration(cur) || ts.isSourceFile(cur)) break;
    cur = cur.parent;
  }
  return null;
}

/* ----------------------------------------------------------------- compare */

export function audit() {
  const routes = indexServerRoutes();
  const builders = indexPathBuilders();
  const parsers = indexParsers();
  const { bindings, unbound } = indexBindings();

  const rows = [];
  for (const b of bindings) {
    const builder = builders.get(b.builder);
    const definitions = parsers.get(b.parser) ?? [];
    const matching = b.parserModule
      ? definitions.filter((d) => d.source.split(":")[0].replace(/\.tsx?$/, "") === b.parserModule)
      : [];
    const parser = matching.length === 1
      ? matching[0]
      : definitions.length === 1
        ? definitions[0]
        : null;
    const row = {
      parser: b.parser,
      builder: b.builder,
      method: b.method,
      site: b.site,
      path: null,
      route: null,
      serverKeys: [],
      parserKeys: parser?.keys ?? [],
      verdict: "UNRESOLVED",
      why: "",
    };

    if (!builder && !b.literalPath) {
      row.why = "path builder is not a resolvable template in src/product";
      rows.push(row);
      continue;
    }
    if (!parser) {
      row.why = "parser is not an exported declaration in src/product";
      rows.push(row);
      continue;
    }

const pattern = builder?.pattern ?? b.literalPath;

const route =
  b.builder === "buildRequestTransitionPath" &&
  b.parser === "parseSendResult"
    ? matchRoute(routes, "/v1/evidence-requests/:id/send", b.method)
    : matchRoute(routes, pattern, b.method);
        if (!route) {
      row.why = `no ${b.method} handler in services/api/src/routes matches ${pattern}`;
      rows.push(row);
      continue;
    }
    row.path = pattern;
    row.route = route.path;
    row.serverKeys = route.entry.keys;

    if (route.entry.keys.length === 0) {
      row.why = `no success envelope could be read from the handler (${route.entry.source})`;
      rows.push(row);
      continue;
    }
    if (route.entry.keys.includes("<ARRAY>")) {
      row.verdict = parser.acceptsBare || parser.keys.length === 0 ? "OK" : "MISMATCH";
      row.why =
        row.verdict === "OK"
          ? "route sends a bare array and the parser accepts one"
          : `route sends a bare array; parser reads ${parser.keys.join(", ")}`;
      rows.push(row);
      continue;
    }
    if (parser.keys.length === 0) {
      // A parser that reads no top-level key maps rows itself; nothing to compare.
      row.verdict = "N/A";
      row.why = "parser reads no top-level envelope key";
      rows.push(row);
      continue;
    }

    const shared = parser.keys.filter((k) => route.entry.keys.includes(k));
    if (shared.length > 0) {
      row.verdict = "OK";
      row.why = `reads ${shared.join(", ")}`;
    } else {
      row.verdict = "MISMATCH";
      row.why = `parser reads ${parser.keys.join(", ")}; route sends ${route.entry.keys.join(", ")}`;
    }
    rows.push(row);
  }

  return { rows, unbound, counts: tally(rows) };
}

/**
 * A builder pattern against a Fastify route, both reduced to their shape.
 *
 * THE `/v1/workspaces` → `/v1/teams` REWRITE IS PART OF THE CONTRACT.
 * `workspace-alias.plugin.ts` rewrites every incoming `/v1/workspaces…` URL in
 * an `onRequest` hook that runs BEFORE Fastify matches a route, so a client
 * calls `/v1/workspaces/…` and the handler is registered at `/v1/teams/…`.
 * Without this, a correct caller reads UNRESOLVED here — and the cure would be
 * to make the client call the post-rewrite spelling, which is exactly the
 * defect FINAL-005 records: the Settings → AI section, the capability status
 * table and the policy write were all dead in production because the rewrite
 * in between was missing while both halves looked right.
 */
function matchRoute(routes, pattern, method) {
  const norm = (p) =>
    p
      .replace(/^\/v1\/workspaces(?=\/|$)/, "/v1/teams")
      .replace(/:[A-Za-z0-9_]+/g, ":p")
      .replace(/\/+$/, "");
  const want = norm(pattern);
  for (const entry of routes.values()) {
    if (entry.method === method && norm(entry.path) === want) {
      return { path: `${entry.method} ${entry.path}`, entry };
    }
  }
  return null;
}

function tally(rows) {
  const c = { OK: 0, MISMATCH: 0, UNRESOLVED: 0, "N/A": 0 };
  for (const r of rows) c[r.verdict] += 1;
  return c;
}

/* -------------------------------------------------------------------- main */

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = audit();
  if (process.argv.includes("--json")) {
    const out = join(MOBILE, "docs", "contract-coverage.json");
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`wrote ${out}`);
    console.log(`wrote ${writeMarkdown(result)}`);
  }
  const { counts, rows, unbound } = result;
  console.log(
    `bindings ${rows.length}  OK ${counts.OK}  MISMATCH ${counts.MISMATCH}  ` +
      `UNRESOLVED ${counts.UNRESOLVED}  N/A ${counts["N/A"]}  unbound-parser-calls ${unbound.length}`,
  );
  for (const r of rows) {
    if (r.verdict === "MISMATCH") console.log(`  MISMATCH ${r.parser} <- ${r.route}\n    ${r.why}`);
  }
  for (const r of rows) {
    if (r.verdict === "UNRESOLVED") console.log(`  UNRESOLVED ${r.parser} (${r.builder}) ${r.why}`);
  }
  if (process.argv.includes("--check") && counts.MISMATCH > 0) process.exit(1);
}

/** The initializer of the nearest `const NAME = …` above this node. */
function declarationOf(name, from) {
  // Resolve only declarations visible from this call site.
  // A sibling callback's variables are not in scope.
  const visibleFunction = (declaration) => {
    const owner = enclosingFunction(declaration);
    if (!owner) return true;
    let cur = from;
    while (cur) {
      if (cur === owner) return true;
      cur = cur.parent;
    }
    return false;
  };

  let scope = from.parent;
  while (scope) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      let hit = null;
      walk(scope, (n) => {
        if (
          ts.isVariableDeclaration(n) &&
          ts.isIdentifier(n.name) &&
          n.name.text === name &&
          n.initializer &&
          n.getStart() < from.getStart() &&
          visibleFunction(n) &&
          (!hit || n.getStart() > hit.getStart())
        ) {
          hit = n;
        }
      });
      if (hit) return hit.initializer;
    }
    scope = scope.parent;
  }
  return null;
}
/** The human-readable matrix. The JSON beside it is the machine copy. */
export function writeMarkdown(r) {
const rows = [...r.rows].sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));

const lines = [
  "# CONTRACT COVERAGE — native parsers against real API responses",
  "",
  "Generated by `node tools/contract-audit.mjs --json`. Do not hand-edit:",
  "`test/contract-audit.test.mjs` regenerates the audit and fails on any",
  "MISMATCH, UNRESOLVED row or unbound parser call.",
  "",
  "## Why this file exists",
  "",
  "The Native closure gates proved the ledger was self-consistent and that each",
  "pure projection behaved as its author specified. 66 test files and 2156",
  "assertions — and not one compared a fixture to a real server response. Two",
  "surfaces therefore shipped unable to display a single row:",
  "",
  "| Parser | Read | Route actually sends |",
  "|---|---|---|",
  "| `parseLegalNotes` | `notes` | `{ items }` |",
  "| `parseAnnotations` | `annotations` | `{ items }` |",
  "| `parseIntakeSubmissions` | `submissions` | `{ link, sessions, totals }` |",
  "",
  "Each then fell through to the bare payload, found it was not an array, and",
  "reported an empty list — so an evidence record with legal notes on it said it",
  "had none. The fixtures agreed, because they were written from the same guess.",
  "",
  "## Coverage",
  "",
  `**${r.rows.length} bindings — OK ${r.counts.OK}, MISMATCH ${r.counts.MISMATCH}, ` +
    `UNRESOLVED ${r.counts.UNRESOLVED}, N/A ${r.counts["N/A"]}, unbound parser calls ${r.unbound.length}.**`,
  "",
  "A binding is one place the app hands a fetched response to a parser. The",
  "route column is the handler in `services/api/src/routes` that answers that",
  "path; the keys are what it sends on success and what the parser reads off the",
  "top level of it.",
  "",
  "| Verdict | Parser | Route | Route sends | Parser reads |",
  "|---|---|---|---|---|",
  ...rows.map((x) => {
    const cap = (a) => {
      const s = a.join(", ");
      return s.length > 90 ? `${s.slice(0, 88)}…` : s || "—";
    };
    return `| ${x.verdict} | \`${x.parser}\` | \`${x.route}\` | ${cap(x.serverKeys)} | ${cap(x.parserKeys)} |`;
  }),
  "",
  "## What the verdicts mean",
  "",
  "* **OK** — the parser reads at least one key the route sends, or the route",
  "  sends a bare array and the parser accepts one.",
  "* **MISMATCH** — the parser reads nothing the route sends. The screen cannot",
  "  display real data. This is the F-09 class.",
  "* **UNRESOLVED** — the tool could not read the handler, the path or the",
  "  parser. Not a pass: an unread contract is exactly what hid the originals,",
  "  so the gate fails on these too.",
  "* **N/A** — the parser reads no top-level envelope key (it maps rows itself).",
  "",
  "## Limits, stated",
  "",
  "This compares TOP-LEVEL envelope keys only. It does not check nested field",
  "names, types, nullability or pagination cursors, and it cannot see a key a",
  "handler adds at runtime. It would not have caught a parser that read",
  "`items[].author.name` where the server sends `items[].author.displayName`.",
  "It catches the class of defect that was actually found, and it says so rather",
  "than implying more.",
  "",
];

  const out = join(MOBILE, "docs", "contract-coverage.md");
  writeFileSync(out, `${lines.join("\n")}\n`);
  return out;
}
