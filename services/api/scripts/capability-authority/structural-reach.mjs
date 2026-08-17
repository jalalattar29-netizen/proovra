/**
 * PHASE 13 (NEW-047) — STRUCTURAL AUTHORITY AND REACHABILITY PRIMITIVES.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Two gates in this repository decided AUTHORITY and REACHABILITY questions by
 * matching a regular expression across a FIXED CHARACTER WINDOW:
 *
 *   verify-module-reachability.mjs
 *     /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*["']([^"']+)["']/g
 *
 *   phase-37-98-command-center-projection-consumption.test.ts
 *     /buildProjectionSummary[\s\S]{0,3000}prisma\.evidence\.count\(…teamId/
 *
 * Both encode the same false premise: that TEXTUAL PROXIMITY stands in for a
 * relationship. It does not, and the failure was not theoretical. A six-line
 * explanatory comment inserted inside a re-export brace list pushed the
 * statement past 400 characters; the graph edge to `rbac.service.ts` stopped
 * being followed; and a 940-line RBAC lifecycle authority was reported as an
 * unreachable production module. Nothing about the runtime had changed. The
 * same class of edit — a docblock added between a function and the query it
 * describes — silently breaks the 3000-character window in the other gate.
 *
 * A window is not merely fragile in practice. It is wrong at the CAUSE: it
 * answers "how many characters apart is this text?" when the question asked is
 * "does this declaration reach that call?". This module answers the question
 * that was actually asked, from the real syntax tree, and it is deliberately
 * built ON TOP of the existing compiler foundation in `call-graph.mjs` rather
 * than beside it — a second resolver is a second authority, and two authorities
 * eventually disagree.
 *
 * WHAT IT GUARANTEES
 * ---------------------------------------------------------------------------
 *   * Comments and string literals are NEVER evidence. A specifier inside a
 *     comment produces no node; a specifier inside a string literal is an
 *     expression, never a module specifier. Both are structurally invisible
 *     here, without a single exclusion rule being written.
 *   * A DECLARATION, an INVOCATION and a MENTION are three different findings.
 *     `resolveAuthority` answers "where is this implemented"; `reachesFrom`
 *     answers "is it actually called from here"; neither is satisfied by a
 *     module merely containing the name.
 *   * Imports, aliases (`import { a as b }`), renamed re-exports
 *     (`export { a as b } from`), bare re-exports (`export { a }`), barrels
 *     (`export * from`) and wrappers are followed to the IMPLEMENTATION, using
 *     `call-graph.mjs`'s canonical `lookupExport` chain.
 *   * An unresolvable dynamic case is REPORTED AND COUNTED, never guessed in
 *     either direction. A gate that cannot tell "no" from "I could not look"
 *     is not measuring anything.
 *   * Distance is never consulted. There is no window, no slice, and no
 *     `indexOf` in this module.
 */

import {
  resolveModuleExport,
  resolveValueDeclaration,
  traverse,
  ts,
} from "./call-graph.mjs";

export { ts };

// ===========================================================================
// Parsing
// ===========================================================================

/**
 * A `.mjs` operator script and a `.tsx` component are different grammars, and
 * handing the wrong `ScriptKind` to the parser produces a tree that silently
 * omits nodes rather than an error. The extension decides.
 */
const SCRIPT_KIND_BY_EXT = Object.freeze({
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
});

/** Parse one module to a full-fidelity tree (parent pointers ON). */
export function parseModule(fileName, text) {
  const dot = fileName.lastIndexOf(".");
  const ext = dot === -1 ? "" : fileName.slice(dot).toLowerCase();
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    SCRIPT_KIND_BY_EXT[ext] ?? ts.ScriptKind.TS,
  );
}

// ===========================================================================
// Module-level edges — the input to the reachability graph
// ===========================================================================

/**
 * Names this file binds EXACTLY ONCE, with a `const`, to a string literal.
 *
 * Two live modules route an OPTIONAL dependency through a named constant so the
 * TypeScript compiler will not try to load type declarations for a package that
 * may not be installed:
 *
 *     const stsModuleName = "@aws-sdk/client-sts";
 *     const mod = await import(\/* @vite-ignore *\/ stsModuleName);
 *
 * The value is stated by the tree. Refusing to read it would publish a blind
 * spot that is not one, and a gate that cries "unfollowable" at edges it can
 * plainly follow teaches its readers to skim the list.
 *
 * "EXACTLY ONCE" is the whole safety argument, and it is why this is a fold and
 * not a guess. Any name that is declared more than once anywhere in the file,
 * or that is also a parameter, an import binding, a function or a class, is
 * omitted — because then the identifier at the import site might denote a
 * DIFFERENT binding in a nested scope, and picking one would be exactly the
 * "close enough" reasoning this module exists to delete. A `let` is omitted for
 * the same reason: it can be reassigned between the declaration and the use.
 * Anything omitted here falls through to `unresolved` and is reported.
 */
function unambiguousStringConstants(sf) {
  /** name → { count, value } — `value === null` means "bound, but not foldable". */
  const seen = new Map();
  const bind = (name, value) => {
    const prior = seen.get(name);
    if (prior) {
      prior.count += 1;
      prior.value = null;
      return;
    }
    seen.set(name, { count: 1, value });
  };

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const isConst = (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0;
      const literal =
        isConst && node.initializer && ts.isStringLiteralLike(node.initializer)
          ? node.initializer.text
          : null;
      bind(node.name.text, literal);
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      bind(node.name.text, null);
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      bind(node.name.text, null);
    } else if (ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) {
      if (node.name && ts.isIdentifier(node.name)) bind(node.name.text, null);
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      bind(node.name.text, null);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const out = new Map();
  for (const [name, { count, value }] of seen) {
    if (count === 1 && value !== null) out.set(name, value);
  }
  return out;
}

/**
 * Every module specifier this file names, as SYNTAX.
 *
 * The forms recognised are exactly the forms the ECMAScript and TypeScript
 * grammars provide for naming another module, so the list is closed rather than
 * a pattern someone has to remember to extend:
 *
 *   `import x from "s"` / `import { a } from "s"` / `import * as n from "s"`
 *   `import "s"`                              (side effect)
 *   `export { a } from "s"` / `export * from "s"` / `export * as n from "s"`
 *   `import x = require("s")`                 (TypeScript import-equals)
 *   `import("s")`                             (dynamic, LITERAL specifier)
 *   `require("s")`                            (CommonJS / createRequire)
 *
 * A specifier that is not a literal — `import(pathVar)`, `import(base + name)`,
 * `` import(`${dir}/x.js`) `` — is returned in `unresolved` with its kind, line
 * and source expression. It is NEVER guessed and NEVER dropped: a computed
 * import that vanishes from the report is the difference between "this module
 * has no importer" and "I could not tell", and those are opposite facts.
 *
 * Type-only edges are recorded like any other, and TAGGED `typeOnly`. They are
 * erased at runtime, so a consumer may legitimately want to exclude them — but
 * that is the consumer's decision to state, not a fact this extractor should
 * destroy. (The window regex could not see the distinction at all.)
 */
export function moduleSpecifiersOf(fileName, text) {
  const sf = parseModule(fileName, text);
  /** @type {Array<{ spec: string, kind: string, line: number, typeOnly: boolean, via: string }>} */
  const edges = [];
  /** @type {Array<{ kind: string, line: number, expression: string }>} */
  const unresolved = [];

  const lineOf = (node) =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const constants = unambiguousStringConstants(sf);

  /**
   * A specifier is usable only when the syntax tree already knows its value.
   * `ts.isStringLiteralLike` covers `"s"`, `'s'` and a template with no
   * substitutions; anything else (a template WITH substitutions, a binary
   * concatenation, a call) is genuinely unknown at analysis time.
   */
  const literalValue = (node) =>
    node && ts.isStringLiteralLike(node) ? node.text : null;

  const record = (kind, statement, specifierNode, typeOnly = false) => {
    const literal = literalValue(specifierNode);
    if (literal !== null) {
      edges.push({ spec: literal, kind, line: lineOf(statement), typeOnly, via: "LITERAL" });
      return;
    }
    // A name bound EXACTLY ONCE in this file by a `const` holding a string
    // literal is not a guess — it is a value the tree already states, spelled
    // over two lines. See `unambiguousStringConstants` for why "exactly once".
    if (specifierNode && ts.isIdentifier(specifierNode)) {
      const folded = constants.get(specifierNode.text);
      if (folded !== undefined) {
        edges.push({ spec: folded, kind, line: lineOf(statement), typeOnly, via: "LOCAL_CONST" });
        return;
      }
    }
    unresolved.push({
      kind: `${kind}_COMPUTED`,
      line: lineOf(statement),
      expression: specifierNode
        ? specifierNode.getText(sf).replace(/\s+/g, " ").slice(0, 160)
        : "<no specifier argument>",
    });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      record(
        node.importClause ? "IMPORT" : "SIDE_EFFECT_IMPORT",
        node,
        node.moduleSpecifier,
        Boolean(node.importClause?.isTypeOnly),
      );
    } else if (ts.isExportDeclaration(node)) {
      // `export { … }` with no specifier names no module and is not an edge.
      if (node.moduleSpecifier) {
        record(
          node.exportClause ? "RE_EXPORT" : "EXPORT_STAR",
          node,
          node.moduleSpecifier,
          Boolean(node.isTypeOnly),
        );
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record("IMPORT_EQUALS", node, node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        record("DYNAMIC_IMPORT", node, node.arguments[0]);
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length > 0
      ) {
        record("REQUIRE", node, node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { edges, unresolved };
}

// ===========================================================================
// Declaration-level authority resolution
// ===========================================================================

/**
 * Where is `name`, as used inside `file`, actually IMPLEMENTED?
 *
 * The answer carries `via`, because the three ways a name can arrive are three
 * different facts and a caller that cannot tell them apart cannot report
 * honestly:
 *
 *   DECLARATION — this file declares it. A local declaration always wins, which
 *                 is why an unrelated local function that happens to share an
 *                 authority's name resolves to ITSELF and never to the
 *                 authority. Name resolution is per-file; there is no global
 *                 name match anywhere in this path.
 *   IMPORT      — the file's own import table binds it, alias and all; the
 *                 ORIGINAL exported name is followed, not the local one.
 *   RE_EXPORT   — the file forwards it (`export { a } from`, `export *`), and
 *                 the chain is followed transitively to the declaring module.
 *
 * Returns `{ ok: false, reason }` rather than a guess. `IMPORTED_BUT_NOT_FOUND`
 * (the binding exists but the target module does not export it) is deliberately
 * distinct from `NO_DECLARATION` (nothing binds the name at all): the first is
 * an analysis gap, the second is an answer.
 */
export function resolveAuthority(cg, file, name) {
  const entry = cg.graph.get(file);
  if (!entry) return { ok: false, reason: "FILE_NOT_INDEXED", file, name };

  if (entry.decls.has(name)) {
    return { ok: true, file, name, node: entry.decls.get(name), via: "DECLARATION" };
  }

  const imported = entry.imports.get(name);
  if (imported) {
    const found = resolveModuleExport(
      cg,
      imported.file,
      imported.exported === "default" ? name : imported.exported,
    );
    if (found) return { ok: true, ...found, via: "IMPORT" };
    return { ok: false, reason: "IMPORTED_BUT_NOT_FOUND", file, name };
  }

  const namespaceOwner = entry.namespaces.get(name);
  if (namespaceOwner) {
    return { ok: false, reason: "NAMESPACE_BINDING_IS_NOT_A_DECLARATION", file, name };
  }

  const forwarded = resolveModuleExport(cg, file, name);
  if (forwarded) return { ok: true, ...forwarded, via: "RE_EXPORT" };

  return { ok: false, reason: "NO_DECLARATION", file, name };
}

/**
 * Resolve an identifier used as a VALUE (a handler passed by reference, a
 * descriptor-table row) through the same rules. A thin pass-through so callers
 * of this module never reach past it into the graph internals.
 */
export function resolveReference(node, file, cg) {
  return resolveValueDeclaration(node, file, cg);
}

// ===========================================================================
// Reachability
// ===========================================================================

/**
 * Does the declaration at `start` REACH a node satisfying `match`?
 *
 * The walk is the resolved call graph's — every call is resolved to a
 * declaration through the importing file's own import table, so a wrapper, an
 * alias and a barrel are each one ordinary hop, and a function that is declared
 * but never called is never entered. Distance in the source text is not an
 * input and cannot be: nothing here reads an offset.
 *
 * `unresolved` is returned alongside the evidence, unaltered, so a caller can
 * refuse to report a zero that is really an unknown. A negative result with a
 * non-empty `unresolved` is NOT proof of absence, and the caller must say so.
 */
export function reachesFrom(cg, start, opts) {
  if (!start || start.ok !== true || !start.node) {
    return {
      reached: false,
      evidence: [],
      unresolved: [],
      functionsVisited: 0,
      startResolved: false,
      startReason: start?.reason ?? "NO_START_DECLARATION",
    };
  }
  const { match, maxDepth = 8, maxFunctions = 400 } = opts;
  const evidence = [];
  const { unresolved, functionsVisited } = traverse(start.node, start.file, cg, {
    maxDepth,
    maxFunctions,
    onNode: (node, file) => {
      const hit = match(node, file);
      if (hit) evidence.push({ ...hit, file });
    },
  });
  return {
    reached: evidence.length > 0,
    evidence,
    unresolved,
    functionsVisited,
    startResolved: true,
    startReason: null,
  };
}

// ===========================================================================
// Query predicates — read from the tree, never from the call's text
// ===========================================================================

/**
 * The property names of a Prisma call's `where` clause.
 *
 * Scoping is decided by the PREDICATE and by nothing else. Reading the keys
 * structurally means `select: { teamId: true }` — a projection, a column the
 * caller merely asked to be given back — can never be mistaken for a filter,
 * and a `teamId` appearing in a comment or a string inside the same call is not
 * even visible.
 *
 * Every shape that cannot be read exactly returns `{ ok: false, reason }`:
 *   ARGUMENT_NOT_AN_OBJECT_LITERAL — `count(args)` where `args` is a variable
 *   NO_WHERE_CLAUSE               — an unfiltered call (a real finding)
 *   WHERE_NOT_STATICALLY_READABLE — `where: buildWhere()` or a variable
 *   WHERE_CONTAINS_SPREAD         — `where: { ...base, teamId }`; the keys
 *                                   present cannot be enumerated from here
 * A caller must decide what each means. None of them may be silently treated as
 * "scoped".
 */
export function whereKeysOf(callNode) {
  if (!ts.isCallExpression(callNode)) {
    return { ok: false, reason: "NOT_A_CALL_EXPRESSION" };
  }
  const arg = callNode.arguments?.[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) {
    return { ok: false, reason: "ARGUMENT_NOT_AN_OBJECT_LITERAL" };
  }
  let where = null;
  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key =
      ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (key === "where") where = prop.initializer;
  }
  if (where === null) return { ok: false, reason: "NO_WHERE_CLAUSE" };
  if (!ts.isObjectLiteralExpression(where)) {
    return { ok: false, reason: "WHERE_NOT_STATICALLY_READABLE" };
  }
  const keys = [];
  for (const prop of where.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      keys.push(prop.name.text);
    } else if (
      ts.isPropertyAssignment(prop) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
    ) {
      keys.push(prop.name.text);
    } else {
      return { ok: false, reason: "WHERE_CONTAINS_SPREAD" };
    }
  }
  return { ok: true, keys };
}

// ===========================================================================
// Indexing an arbitrary module set
// ===========================================================================

/**
 * Resolve a relative specifier against a known module set.
 *
 * The same TypeScript-ESM convention `call-graph.mjs` resolves by: the import
 * is written `.js`, the implementation is `.ts`.
 */
function resolveWithin(spec, fromFile, fileSet) {
  if (!spec.startsWith(".")) return null;
  const base = `${fromFile.split("/").slice(0, -1).join("/")}/${spec}`;
  const stem = base.replace(/\.(js|mjs)$/, "");
  for (const candidate of [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, base]) {
    const norm = candidate
      .split("/")
      .reduce((acc, seg) => {
        if (seg === "." || seg === "") return acc;
        if (seg === "..") {
          acc.pop();
          return acc;
        }
        acc.push(seg);
        return acc;
      }, [])
      .join("/");
    if (fileSet.has(norm)) return norm;
  }
  return null;
}

/**
 * Index a GIVEN set of modules into the shape `buildCallGraph()` produces from
 * disk, so the canonical resolvers above can be exercised against sources that
 * do not exist in the tree.
 *
 * WHY THIS IS NOT A SECOND CALL GRAPH
 * ---------------------------------------------------------------------------
 * It makes no resolution decisions. It reads declarations, the import table and
 * re-export edges out of the syntax tree and hands them to the SAME
 * `lookupExport` / `resolveCall` / `traverse` implementations that serve the
 * live tree; every question of "which declaration does this name mean" is
 * answered by `call-graph.mjs` in both cases. It exists because
 * `buildCallGraph()` reads a fixed set of roots from disk, and an adversarial
 * battery cannot write its fixtures into the production source tree: a suite
 * that mutates the tree it measures manufactures failures in every gate running
 * beside it, which this repository has already learned once.
 *
 * `phase-13-structural-reachability-adversarial.test.ts` pins this indexer
 * against `buildCallGraph()` on real repository modules, so the two cannot
 * drift apart silently.
 *
 * Descriptor-table bindings (`localFnBindings` / `localFnAliases`) are left
 * empty rather than approximated: an empty map is a fact, and `resolveCall`
 * reads both through optional chaining.
 */
export function indexModules(sources) {
  const fileSet = new Set(sources.map((s) => s.file));
  const graph = new Map();

  for (const { file, text } of sources) {
    const sf = parseModule(file, text);
    const decls = new Map();
    const imports = new Map();
    const namespaces = new Map();
    const reExports = [];
    const exportAliases = new Map();
    const exportRenames = new Map();

    const record = (name, node) => {
      if (!decls.has(name)) decls.set(name, node);
    };
    const visit = (node) => {
      if (ts.isFunctionDeclaration(node) && node.name) record(node.name.text, node);
      else if (ts.isClassDeclaration(node) && node.name) record(node.name.text, node);
      else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer) ||
          ts.isNewExpression(node.initializer) ||
          ts.isCallExpression(node.initializer) ||
          ts.isIdentifier(node.initializer))
      ) {
        record(node.name.text, node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
        const target = resolveWithin(stmt.moduleSpecifier.text, file, fileSet);
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
      } else if (
        ts.isExportDeclaration(stmt) &&
        stmt.moduleSpecifier &&
        ts.isStringLiteralLike(stmt.moduleSpecifier)
      ) {
        const target = resolveWithin(stmt.moduleSpecifier.text, file, fileSet);
        if (!target) continue;
        reExports.push(target);
        if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            if (el.propertyName) {
              exportRenames.set(el.name.text, { file: target, exported: el.propertyName.text });
            }
          }
        }
      } else if (
        ts.isExportDeclaration(stmt) &&
        !stmt.moduleSpecifier &&
        stmt.exportClause &&
        ts.isNamedExports(stmt.exportClause)
      ) {
        for (const el of stmt.exportClause.elements) {
          exportAliases.set(el.name.text, (el.propertyName ?? el.name).text);
        }
      }
    }

    graph.set(file, {
      sf,
      decls,
      imports,
      namespaces,
      reExports,
      exportAliases,
      exportRenames,
      localFnBindings: new Map(),
      localFnAliases: new Map(),
    });
  }

  return { graph, fileSet };
}
