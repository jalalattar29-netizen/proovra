/**
 * PHASE 13 — IMPORT-RESOLVED CALL GRAPH.
 *
 * WHY A NAME INDEX IS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * The existing route analyzer follows guards by NAME, two calls deep, and says
 * so: going deeper "would eventually touch a session somewhere and classify
 * every route as AUTHENTICATED, which is the opposite failure". That bound is
 * the right answer for a shallow, name-keyed walk — but it also means the walk
 * cannot reach a tenant authority that sits four services down, or a Prisma
 * write behind two wrappers.
 *
 * Simply raising the depth makes it worse, measurably. A depth-6 name-keyed
 * walk over this repository attributed `evidenceSearchDocument` reads to
 * `POST /v1/auth/google`: `calleeName` on a property access yields the METHOD
 * name, so `audit.record(...)` matched every function called `record` anywhere
 * in three trees, and the walk teleported into unrelated subsystems. Facts
 * derived that way are not measurements, and a classifier built on them would
 * launder noise into a security verdict.
 *
 * WHAT THIS MODULE DOES INSTEAD
 * ---------------------------------------------------------------------------
 * It resolves each call to a DECLARATION, using the file's own import table:
 *
 *   - a bare identifier resolves to a local declaration, or to the module named
 *     by the import that binds it;
 *   - `ns.fn()` resolves through a namespace import;
 *   - `obj.method()` resolves ONLY when `obj` is a known module binding — never
 *     by matching the method name globally;
 *   - anything unresolved is RECORDED as unresolved, never guessed.
 *
 * The last point is the important one. An honest analyzer's output includes the
 * calls it could not follow, so a gate can refuse to report a zero that is
 * really an unknown.
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

function discoverWorkspacePackages() {
  const out = [];
  const dir = path.join(REPO, "packages");
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const pkgJson = path.join(dir, name, "package.json");
    const src = path.join(dir, name, "src");
    if (!existsSync(pkgJson) || !existsSync(src)) continue;
    try {
      const { name: pkgName } = JSON.parse(readFileSync(pkgJson, "utf8"));
      if (typeof pkgName === "string") out.push({ prefix: pkgName, root: `packages/${name}/src` });
    } catch {
      // A package with an unreadable manifest is skipped, and its imports then
      // surface as IMPORTED_BUT_NOT_FOUND rather than being silently followed.
    }
  }
  // Longest prefix first, so `@proovra/shared-runtime` is not swallowed by
  // `@proovra/shared`.
  return out.sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * Workspace package specifiers → the source root implementing them, DISCOVERED
 * by reading each package manifest under `packages/` rather than listed.
 *
 * The hand-written list held only `@proovra/shared` and
 * `@proovra/shared-runtime`, so every call into `@proovra/shared-billing`
 * (`getPlanCapabilities`, the plan catalog) resolved to nothing and was
 * recorded as an unfollowable gap — 39 of them, all of which the graph could
 * have followed perfectly well.
 */
const WORKSPACE_PACKAGES = Object.freeze(discoverWorkspacePackages());

/**
 * Source trees whose functions may be followed.
 *
 * `services/worker/src` joined the set for PHASE 13 §B: a job processor is an
 * ENTRYPOINT to state change exactly as a route handler is, and a graph that
 * cannot see the worker cannot answer "what reaches this writer" — every
 * queue-driven mutation would have read as unreachable.
 *
 * The workspace package roots are appended from the discovery above, because a
 * specifier that RESOLVES to a file the graph never indexed is unresolved all
 * the same — the resolution and the index have to agree.
 */
const ROOTS = [
  "services/api/src",
  "services/worker/src",
  ...WORKSPACE_PACKAGES.map((p) => p.root),
];

function walk(root, out = []) {
  const absRoot = path.join(REPO, root);
  if (!existsSync(absRoot)) return out;
  const stack = [absRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === "build") continue;
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
    }
  }
  return out;
}

/**
 * Resolve an import specifier from `fromFile` to a repository-relative source
 * file, or null when it leaves the followable trees (a real dependency).
 */
function resolveSpecifier(spec, fromFile, fileSet) {
  const candidates = [];
  if (spec.startsWith(".")) {
    const base = path.posix.join(path.posix.dirname(fromFile), spec);
    // TypeScript ESM imports are written `.js` but implemented `.ts`.
    const stem = base.replace(/\.(js|mjs)$/, "");
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`, base);
  } else {
    for (const pkg of WORKSPACE_PACKAGES) {
      if (spec === pkg.prefix || spec.startsWith(`${pkg.prefix}/`)) {
        const sub = spec === pkg.prefix ? "index" : spec.slice(pkg.prefix.length + 1);
        const stem = `${pkg.root}/${sub}`.replace(/\.(js|mjs)$/, "");
        candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`);
        break;
      }
    }
  }
  for (const c of candidates) {
    const norm = path.posix.normalize(c);
    if (fileSet.has(norm)) return norm;
  }
  return null;
}

/**
 * Build the graph: per-file source, exported/local declarations, import
 * bindings, and re-export edges.
 */
export function buildCallGraph() {
  const files = [];
  for (const root of ROOTS) for (const abs of walk(root)) files.push(rel(abs));
  const fileSet = new Set(files);

  /** file → { sf, decls: Map<name, node>, imports: Map<local,{file,exported}>, namespaces: Map<local,file>, reExports: Array<file> } */
  const graph = new Map();

  for (const file of files) {
    let sf;
    try {
      sf = ts.createSourceFile(file, readFileSync(path.join(REPO, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    } catch {
      continue;
    }
    const decls = new Map();
    const imports = new Map();
    const namespaces = new Map();
    const reExports = [];
    const exportAliases = new Map();
    const exportRenames = new Map();
    /**
     * LOCAL FUNCTION-VALUED BINDINGS — the descriptor-table idiom.
     *
     * `admin-provisioning.routes.ts` registers its organization suspend and
     * resume legs from a table:
     *
     *     for (const [leg, run] of [["suspend", (…) => suspendOrganization(…)],
     *                              ["resume",  (…) => resumeOrganization(…)]])
     *       app.post(`/v1/admin/orgs/:id/${leg}`, …, handler calls run(…))
     *
     * `run` is neither a declaration nor an import, so a call to it resolved to
     * nothing and twelve organization-lifecycle writers — every SSO connection,
     * SCIM token and API credential revoked by an org suspend — were reachable
     * only at MODULE scope, with no route to attribute them to and therefore no
     * authorization to check them against.
     *
     * Every function-valued element of a statically-present array or object
     * bound to a name is recorded here, and ALL candidates are kept: a table
     * row is one of several things the name may be, and picking one would
     * attribute a writer to the wrong route.
     */
    const localFnBindings = new Map();
    /**
     * The same idiom, with the row naming an IMPORTED function instead of
     * inlining one:
     *
     *     for (const [leg, fn] of [["suspend", suspendOrganizationWorkspace],
     *                              ["resume",  resumeOrganizationWorkspace]] as const)
     *       app.post(`/v1/orgs/:id/workspaces/:teamId/${leg}`, …, () => fn(…))
     *
     * `localFnBindings` above only accepts an inline arrow or function
     * expression, so this row bound nothing, `fn(…)` resolved to nothing, and
     * the four organization-workspace suspend/resume writers — memberships
     * suspended, switcher pointers cleared, webhook delivery paused — read as
     * DEAD_UNREACHABLE while sitting one ORG_ADMIN request away.
     *
     * The referenced declaration lives in ANOTHER file, so it cannot be stored
     * as a local declaration the way an inline function is. The identifier is
     * kept instead and resolved at call time, through the same import table as
     * any other name.
     */
    const localFnAliases = new Map();

    const record = (name, node) => {
      if (!decls.has(name)) decls.set(name, node);
    };

    const isFnLike = (n) =>
      n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
    const bindLocalFn = (name, fn) => {
      if (!localFnBindings.has(name)) localFnBindings.set(name, []);
      localFnBindings.get(name).push(fn);
    };
    const bindAlias = (name, id) => {
      if (!localFnAliases.has(name)) localFnAliases.set(name, []);
      localFnAliases.get(name).push(id);
    };
    /** Bind a destructuring pattern against every row of an array literal. */
    const bindPatternOverRows = (pattern, rows) => {
      for (const row of rows) {
        if (ts.isArrayLiteralExpression(row) && ts.isArrayBindingPattern(pattern)) {
          pattern.elements.forEach((el, i) => {
            if (ts.isOmittedExpression(el) || !ts.isIdentifier(el.name)) return;
            const v = row.elements[i];
            if (isFnLike(v)) bindLocalFn(el.name.text, v);
            else if (v && ts.isIdentifier(v)) bindAlias(el.name.text, v);
          });
        } else if (ts.isObjectLiteralExpression(row) && ts.isObjectBindingPattern(pattern)) {
          for (const el of pattern.elements) {
            if (!ts.isIdentifier(el.name)) continue;
            const key = (el.propertyName && ts.isIdentifier(el.propertyName)
              ? el.propertyName.text
              : el.name.text);
            for (const prop of row.properties) {
              if (!ts.isPropertyAssignment(prop)) continue;
              const pk = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
              if (pk !== key) continue;
              if (isFnLike(prop.initializer)) bindLocalFn(el.name.text, prop.initializer);
              else if (ts.isIdentifier(prop.initializer)) bindAlias(el.name.text, prop.initializer);
            }
          }
        }
      }
    };

    const visit = (node) => {
      // `for (const [a, fn] of [ … ])` / `for (const { handler } of [ … ])`
      if (
        ts.isForOfStatement(node) &&
        ts.isVariableDeclarationList(node.initializer) &&
        node.initializer.declarations.length === 1
      ) {
        const decl = node.initializer.declarations[0];
        let rowsExpr = node.expression;
        // `… of TABLE as const` — the assertion wraps the literal.
        if (ts.isAsExpression(rowsExpr)) rowsExpr = rowsExpr.expression;
        // `… of TABLE`, where TABLE is a const in this file holding the literal.
        if (ts.isIdentifier(rowsExpr)) {
          const named = rowsExpr.text;
          let found = null;
          const findTable = (n) => {
            if (
              found === null &&
              ts.isVariableDeclaration(n) &&
              ts.isIdentifier(n.name) &&
              n.name.text === named &&
              n.initializer
            ) {
              let init = n.initializer;
              if (ts.isAsExpression(init)) init = init.expression;
              if (ts.isArrayLiteralExpression(init)) found = init;
            }
            if (found === null) ts.forEachChild(n, findTable);
          };
          findTable(sf);
          if (found) rowsExpr = found;
        }
        if (ts.isArrayLiteralExpression(rowsExpr) && !ts.isIdentifier(decl.name)) {
          bindPatternOverRows(decl.name, rowsExpr.elements);
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name) record(node.name.text, node);
      else if (ts.isClassDeclaration(node) && node.name) record(node.name.text, node);
      else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer) ||
          ts.isNewExpression(node.initializer) || ts.isCallExpression(node.initializer) ||
          // `export const maskEmail = maskPublicEmail` binds one name to
          // another. Skipping it lost the whole formatter module behind a
          // rename that costs one lookup to follow.
          ts.isIdentifier(node.initializer))
      ) {
        record(node.name.text, node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
        const target = resolveSpecifier(stmt.moduleSpecifier.text, file, fileSet);
        if (!target) continue;
        const clause = stmt.importClause;
        if (!clause) continue;
        if (clause.name) imports.set(clause.name.text, { file: target, exported: "default" });
        const nb = clause.namedBindings;
        if (nb) {
          if (ts.isNamespaceImport(nb)) namespaces.set(nb.name.text, target);
          else if (ts.isNamedImports(nb)) {
            for (const el of nb.elements) {
              imports.set(el.name.text, {
                file: target,
                exported: (el.propertyName ?? el.name).text,
              });
            }
          }
        }
      } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
        const target = resolveSpecifier(stmt.moduleSpecifier.text, file, fileSet);
        if (target) {
          reExports.push(target);
          // `export { initSecretsAuthority as initSecretsManager } from "…"` —
          // the EXPORTED name does not exist in the target module, only the
          // original does. Pushing the file alone made the lookup search for
          // the new name and fail, so a renamed re-export read as a missing
          // export rather than as the one hop it is.
          if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
            for (const el of stmt.exportClause.elements) {
              if (el.propertyName) {
                exportRenames.set(el.name.text, { file: target, exported: el.propertyName.text });
              }
            }
          }
        }
      } else if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        // `export { getEmailWebBaseUrl }` — a BARE named re-export of a binding
        // this file imported. There is no module specifier to follow, so the
        // previous revision found neither a local declaration nor a re-export
        // edge and reported the export as missing: 26 calls into the
        // notification and packaging services were recorded as unfollowable
        // when the graph could have reached them in one hop.
        for (const el of stmt.exportClause.elements) {
          const local = (el.propertyName ?? el.name).text;
          exportAliases.set(el.name.text, local);
        }
      }
    }

    // Every descriptor-table binding becomes a followable declaration. The
    // first keeps the plain name; the rest are suffixed, so a table with two
    // rows contributes two distinct reachability edges instead of one.
    for (const [name, fns] of localFnBindings) {
      if (!decls.has(name)) decls.set(name, fns[0]);
      for (let i = 1; i < fns.length; i += 1) decls.set(`${name}@alt${i - 1}`, fns[i]);
    }

    graph.set(file, { sf, decls, imports, namespaces, reExports, exportAliases, exportRenames, localFnBindings, localFnAliases });
  }

  return { graph, fileSet };
}

/**
 * Resolve a specifier against an ALREADY-BUILT graph, so the dynamic-import
 * branch of `resolveCall` can reuse the same resolution the build used.
 */
function resolveSpecifierFor(spec, fromFile, cg) {
  const fileSet = cg.fileSet;
  return resolveSpecifier(spec, fromFile, fileSet);
}

/** Find `name` exported by `target`, following `export *` transitively. */
function lookupExport(cg, target, name, seen = new Set()) {
  if (!target || seen.has(target)) return null;
  seen.add(target);
  const t = cg.graph.get(target);
  if (!t) return null;
  if (t.decls.has(name)) return { file: target, name, node: t.decls.get(name) };
  // A bare `export { x }` re-exports a binding this module imported; follow it
  // to the module that actually declares it.
  const renamed = t.exportRenames?.get(name);
  if (renamed) {
    const found = lookupExport(cg, renamed.file, renamed.exported, seen);
    if (found) return found;
  }
  const aliasLocal = t.exportAliases?.get(name);
  if (aliasLocal !== undefined) {
    if (t.decls.has(aliasLocal)) return { file: target, name: aliasLocal, node: t.decls.get(aliasLocal) };
    const imp = t.imports.get(aliasLocal);
    if (imp) {
      const found = lookupExport(cg, imp.file, imp.exported === "default" ? aliasLocal : imp.exported, seen);
      if (found) return found;
    }
  }
  for (const re of t.reExports) {
    const found = lookupExport(cg, re, name, seen);
    if (found) return found;
  }
  return null;
}

/**
 * Resolve one NAMED EXPORT of a module to the declaration that implements it,
 * following `export *`, `export { x } from`, and bare `export { x }`.
 *
 * PHASE 13 §4. The dynamic-import edge assumed a destructured name was
 * DECLARED in the module it was imported from. It usually is not: the worker
 * writes `await import("@proovra/shared-runtime/graph")`, which resolves to a
 * BARREL that re-exports `reconcileTeamGraph` from
 * `graph/graph-builder.service.ts`. The edge therefore pointed at a
 * declaration key that does not exist and contributed nothing — and the
 * fourteen raw-SQL writers inside the canonical graph reconciler, the one the
 * `graph-reconcile` queue exists to run, were reported DEAD_UNREACHABLE.
 */
export function resolveModuleExport(cg, file, name) {
  return lookupExport(cg, file, name);
}

/**
 * Resolve an identifier used as a VALUE rather than called — a route handler
 * passed by reference (`app.get(path, { handler: listCases })`), or a hoisted
 * options object's handler binding.
 *
 * Same resolution rules as `resolveCall`: the file's own declarations first,
 * then its import table, then `export *` re-exports. Never a global name match.
 * Returns null rather than guessing, so an unresolvable reference stays visible
 * as an analysis gap instead of becoming a silent pass.
 */
export function resolveValueDeclaration(node, file, cg) {
  if (!node || !ts.isIdentifier(node)) return null;
  const entry = cg.graph.get(file);
  if (!entry) return null;
  const name = node.text;
  if (entry.decls.has(name)) return { file, name, node: entry.decls.get(name) };
  const imp = entry.imports.get(name);
  if (!imp) return null;
  return lookupExport(cg, imp.file, imp.exported === "default" ? name : imp.exported);
}

/**
 * Resolve a call expression to `{ file, name, node }`, or a reason it could not
 * be resolved. Never falls back to a global name match.
 */
export function resolveCall(call, file, cg, depthGuard = new Set()) {
  const entry = cg.graph.get(file);
  if (!entry) return { ok: false, reason: "FILE_NOT_INDEXED" };
  const e = call.expression;

  const lookup = (target, name, seen = new Set()) => lookupExport(cg, target, name, seen);

  if (ts.isIdentifier(e)) {
    const name = e.text;
    // A descriptor-table binding is checked FIRST, because it is the only case
    // where one name legitimately denotes SEVERAL functions. Falling through to
    // the plain declaration lookup returned row 0 with no alternates, and the
    // remaining rows' writers stayed unattributed.
    const bound = entry.localFnBindings?.get(name);
    if (bound && bound.length > 0) {
      return { ok: true, file, name, node: bound[0], alternates: bound.slice(1) };
    }
    // A descriptor-table row that NAMES a function rather than inlining one.
    // Every row is resolved and all of them are returned: the binding denotes
    // each in turn, and following only the first would attribute one leg's
    // writers to both routes and leave the other leg unattributed.
    const aliases = entry.localFnAliases?.get(name);
    if (aliases && aliases.length > 0) {
      const targets = [];
      for (const id of aliases) {
        if (depthGuard.has(`${file}#${id.text}`)) continue;
        depthGuard.add(`${file}#${id.text}`);
        const r = resolveValueDeclaration(id, file, cg);
        if (r) targets.push(r);
      }
      if (targets.length > 0) {
        return { ok: true, ...targets[0], targets };
      }
    }
    if (entry.decls.has(name)) return { ok: true, file, name, node: entry.decls.get(name) };
    const imp = entry.imports.get(name);
    if (imp) {
      const found = lookup(imp.file, imp.exported === "default" ? name : imp.exported);
      if (found) return { ok: true, ...found };
      return { ok: false, reason: "IMPORTED_BUT_NOT_FOUND", name };
    }
    // A local binding introduced by a descriptor table.
    const local = entry.localFnBindings?.get(name);
    if (local && local.length > 0) {
      return { ok: true, file, name, node: local[0], alternates: local.slice(1) };
    }
    return { ok: false, reason: "UNRESOLVED_IDENTIFIER", name };
  }

  // `const { assignWorkflow } = await import("../observability/workflow.service.js")`
  //
  // A dynamic import with a LITERAL specifier is as followable as a static one,
  // and this tree uses it deliberately to break import cycles. Treating it as a
  // non-static callee left every writer behind such an import looking
  // unreachable — 21 of them in the bulk-actions and workflow services alone.
  // The binding is read from the enclosing destructuring, so only the members
  // actually taken are followed.
  if (e.kind === ts.SyntaxKind.ImportKeyword) {
    const spec = call.arguments?.[0];
    if (spec && ts.isStringLiteralLike(spec)) {
      const target = resolveSpecifierFor(spec.text, file, cg);
      // The MODULE is resolved; WHICH of its exports the caller took is read
      // from the destructuring at the call site, by the caller of this
      // function. Returning the module without a declaration keeps that
      // decision where the binding is visible.
      if (target) return { ok: true, file: target, name: "*module*", node: null, module: true };
    }
    return { ok: false, reason: "DYNAMIC_IMPORT_UNRESOLVED" };
  }

  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
    const objName = e.expression.text;
    const member = e.name.text;
    // Namespace import: `ns.fn()`.
    const nsFile = entry.namespaces.get(objName);
    if (nsFile) {
      const found = lookup(nsFile, member);
      if (found) return { ok: true, ...found };
      return { ok: false, reason: "NAMESPACE_MEMBER_NOT_FOUND", name: `${objName}.${member}` };
    }
    // A module binding used as an object (`import x from`; `x.fn()`).
    const imp = entry.imports.get(objName);
    if (imp) {
      const found = lookup(imp.file, member);
      if (found) return { ok: true, ...found };
    }
    // Deliberately NOT resolved by global method name — that is the defect this
    // module exists to avoid.
    return { ok: false, reason: "METHOD_ON_VALUE", name: `${objName}.${member}` };
  }

  return { ok: false, reason: "NON_STATIC_CALLEE" };
}

/**
 * Walk a node through the resolved call graph, invoking `onNode(node, file)`
 * for every AST node in every reached function body.
 *
 * Returns the set of unresolved call descriptions so a caller can report
 * coverage honestly instead of implying completeness.
 */
export function traverse(startNode, startFile, cg, opts) {
  const { onNode, maxDepth = 8, maxFunctions = 400 } = opts;
  const visited = new Set();
  const unresolved = [];
  let functionsVisited = 0;

  const run = (node, file, depth) => {
    if (depth < 0 || functionsVisited > maxFunctions) return;
    const visit = (n) => {
      onNode(n, file);
      if (ts.isCallExpression(n)) {
        const r = resolveCall(n, file, cg);
        // A dynamic import resolves to a MODULE with no declaration node; the
        // tenancy walk has no destructuring context to pick a member from, so
        // it does not follow it. The mutation pass, which does have that
        // context, follows it there.
        if (r.ok && r.node) {
          const key = `${r.file}#${r.name}`;
          if (!visited.has(key)) {
            visited.add(key);
            functionsVisited++;
            run(r.node, r.file, depth - 1);
          }
        } else if (r.ok) {
          // resolved-but-not-followed: not a gap.
        } else if (r.reason !== "NON_STATIC_CALLEE" && r.name) {
          // Only record calls that LOOK like project code; a call to a
          // node/library builtin is not an analysis gap.
          unresolved.push({ file, name: r.name, reason: r.reason });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  };

  run(startNode, startFile, maxDepth);
  return { unresolved, functionsVisited };
}

export { ts };
