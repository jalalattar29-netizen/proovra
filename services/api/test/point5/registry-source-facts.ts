/**
 * ET-Q-07 (2026-09-30) — what the SOURCE says, for the registry gates.
 *
 * The canonical work registry is a hand-maintained description of the runtime.
 * Every earlier check on it measured either the filesystem ("the named file
 * exists") or a declaration ("the named module says it recovers this"), and
 * both were satisfied by entries that were false:
 *
 *   * a reconciler field naming a module with no code for that authority;
 *   * five jobs whose "producer" was a helper nothing called;
 *   * claim states (`QUEUED`, `RUNNING`, `SENDING`) no column can hold;
 *   * a lease field that is not a column of the model it was declared on.
 *
 * This module answers those questions from the SYNTAX TREE and the Prisma
 * schema instead. Nothing here matches text across a file: a comment is not a
 * node, so prose that names a model, a state or a helper can neither satisfy
 * nor fail a gate — which matters, because the notes that record why a claim
 * was false necessarily name the thing that was false.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");

const norm = (abs: string) => relative(REPO, abs).replace(/\\/g, "/");

// ===========================================================================
// Files
// ===========================================================================

export function walkTs(relDir: string): string[] {
  const out: string[] = [];
  const stack = [resolve(REPO, relDir)];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === ".next") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(norm(full));
    }
  }
  return out;
}

/** `services/api/src`, `services/worker/src` and every `packages/<x>/src`. */
export function runtimeSourceRoots(): string[] {
  const roots = ["services/api/src", "services/worker/src"];
  const pk = resolve(REPO, "packages");
  for (const name of readdirSync(pk)) {
    if (existsSync(join(pk, name, "src"))) roots.push(`packages/${name}/src`);
  }
  return roots;
}

const SOURCE_CACHE = new Map<string, ts.SourceFile>();
function parse(rel: string): ts.SourceFile {
  let sf = SOURCE_CACHE.get(rel);
  if (!sf) {
    const abs = resolve(REPO, rel);
    sf = ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true);
    SOURCE_CACHE.set(rel, sf);
  }
  return sf;
}

// ===========================================================================
// Literals, identifiers and property names — never comments
// ===========================================================================

export type SourceFacts = {
  /** Every string / template chunk, as written. */
  strings: string[];
  identifiers: Set<string>;
  /** Names on the right of a `.` — `prisma.evidence` contributes `evidence`. */
  propertyNames: Set<string>;
};

const FACTS_CACHE = new Map<string, SourceFacts>();

export function sourceFacts(rel: string): SourceFacts {
  const cached = FACTS_CACHE.get(rel);
  if (cached) return cached;
  const facts: SourceFacts = { strings: [], identifiers: new Set(), propertyNames: new Set() };
  if (existsSync(resolve(REPO, rel))) {
    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) facts.strings.push(n.text);
      else if (ts.isTemplateExpression(n)) {
        facts.strings.push(n.head.text);
        for (const span of n.templateSpans) facts.strings.push(span.literal.text);
      } else if (ts.isIdentifier(n)) facts.identifiers.add(n.text);
      if (ts.isPropertyAccessExpression(n)) facts.propertyNames.add(n.name.text);
      ts.forEachChild(n, visit);
    };
    visit(parse(rel));
  }
  FACTS_CACHE.set(rel, facts);
  return facts;
}

// ===========================================================================
// The Prisma schema
// ===========================================================================

const SCHEMA = readFileSync(resolve(REPO, "services/api/prisma/schema.prisma"), "utf8");

export function prismaModelBlock(model: string): string | null {
  const m = SCHEMA.match(new RegExp(`^model ${model} \\{[\\s\\S]*?^\\}`, "m"));
  return m ? m[0] : null;
}

/** The table a model is stored in: its `@@map`, or the model name. */
export function prismaTableOf(model: string): string {
  return prismaModelBlock(model)?.match(/@@map\("([^"]+)"\)/)?.[1] ?? model;
}

export function prismaModelHasField(model: string, field: string): boolean {
  const block = prismaModelBlock(model);
  return block !== null && new RegExp(`^\\s+${field}\\s`, "m").test(block);
}

/** Members of every Prisma enum that types a field of `model`. */
export function prismaEnumValuesOf(model: string): Set<string> {
  const out = new Set<string>();
  const block = prismaModelBlock(model);
  if (!block) return out;
  const enums = new Map<string, string[]>();
  for (const m of SCHEMA.matchAll(/^enum (\w+) \{([\s\S]*?)^\}/gm)) {
    enums.set(
      m[1]!,
      [...m[2]!.matchAll(/^\s+([A-Z][A-Z0-9_]*)\b/gm)].map((x) => x[1]!),
    );
  }
  for (const f of block.matchAll(/^\s+\w+\s+(\w+)[?\s[]/gm)) {
    for (const v of enums.get(f[1]!) ?? []) out.add(v);
  }
  return out;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Does this module's CODE reference the Prisma model?
 *
 * Three forms count, because those are the three ways a module reaches a
 * table: the model type by name, the Prisma client accessor
 * (`prisma.evidencePartDerivedAsset`), or the mapped table inside a SQL string
 * directly after FROM / JOIN / UPDATE / INTO. A bare occurrence of the table
 * name in a log message does not count.
 */
export function referencesModel(rel: string, model: string): boolean {
  const facts = sourceFacts(rel);
  if (facts.identifiers.has(model)) return true;
  if (facts.propertyNames.has(lowerFirst(model))) return true;
  const table = prismaTableOf(model);
  const sql = new RegExp(`\\b(FROM|JOIN|UPDATE|INTO)\\s+"?${table}"?(?![A-Za-z0-9_])`, "i");
  return facts.strings.some((s) => sql.test(s));
}

// ===========================================================================
// Imports, resolved
// ===========================================================================

const PACKAGE_EXPORTS = new Map<string, Map<string, string>>();

/** `export function|const NAME` -> defining file, for one package's src tree. */
function packageExports(relDir: string): Map<string, string> {
  let map = PACKAGE_EXPORTS.get(relDir);
  if (map) return map;
  map = new Map();
  for (const file of walkTs(relDir)) {
    for (const stmt of parse(file).statements) {
      const exported =
        ts.canHaveModifiers(stmt) &&
        (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        if (!map.has(stmt.name.text)) map.set(stmt.name.text, file);
      } else if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && !map.has(d.name.text)) map.set(d.name.text, file);
        }
      }
    }
  }
  PACKAGE_EXPORTS.set(relDir, map);
  return map;
}

function resolveImportedName(fromRel: string, specifier: string, name: string): string | null {
  if (specifier.startsWith(".")) {
    const abs = resolve(dirname(resolve(REPO, fromRel)), specifier.replace(/\.js$/, ".ts"));
    return existsSync(abs) ? norm(abs) : null;
  }
  if (specifier === "@proovra/shared-runtime" || specifier.startsWith("@proovra/shared-runtime/")) {
    return packageExports("packages/shared-runtime/src").get(name) ?? null;
  }
  if (specifier === "@proovra/shared") {
    return packageExports("packages/shared/src").get(name) ?? null;
  }
  return null;
}

export type ImportUse = { name: string; file: string; called: boolean };

/**
 * Every name this module imports and USES, with the file that defines it.
 *
 * Follows the three import shapes the worker and api actually write:
 *   import { a } from "x"            static, named
 *   const { a } = await import("x")  dynamic, destructured
 *   const ns = await import("x")     dynamic, namespace — then `ns.a`
 *
 * `called` is true when the name is the callee of a call expression. An import
 * that is merely passed along as a value is a reference, not an invocation.
 */
export function importUses(rel: string): ImportUse[] {
  if (!existsSync(resolve(REPO, rel))) return [];
  const sf = parse(rel);
  const named = new Map<string, string>();
  const namespaces = new Map<string, string>();
  const used = new Map<string, { spec: string; called: boolean }>();

  const dynamicSpecifier = (init: ts.Expression | undefined): string | null => {
    let e = init;
    if (e && ts.isAwaitExpression(e)) e = e.expression;
    if (
      e &&
      ts.isCallExpression(e) &&
      e.expression.kind === ts.SyntaxKind.ImportKeyword &&
      e.arguments[0] &&
      ts.isStringLiteral(e.arguments[0])
    ) {
      return e.arguments[0].text;
    }
    return null;
  };

  const collect = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const bindings = n.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          named.set(el.name.text, n.moduleSpecifier.text);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        namespaces.set(bindings.name.text, n.moduleSpecifier.text);
      }
    }
    if (ts.isVariableDeclaration(n)) {
      const spec = dynamicSpecifier(n.initializer);
      if (spec) {
        if (ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) {
            if (ts.isIdentifier(el.name)) named.set(el.name.text, spec);
          }
        } else if (ts.isIdentifier(n.name)) {
          namespaces.set(n.name.text, spec);
        }
      }
    }
    // `({ a, b } = await import("x"))` — assignment to predeclared bindings.
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isObjectLiteralExpression(n.left)
    ) {
      const spec = dynamicSpecifier(n.right);
      if (spec) {
        for (const p of n.left.properties) {
          if (ts.isShorthandPropertyAssignment(p)) named.set(p.name.text, spec);
        }
      }
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);

  const mark = (name: string, spec: string, called: boolean): void => {
    const prev = used.get(name);
    used.set(name, { spec, called: called || prev?.called === true });
  };
  const use = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee) && named.has(callee.text)) {
        mark(callee.text, named.get(callee.text)!, true);
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        namespaces.has(callee.expression.text)
      ) {
        mark(callee.name.text, namespaces.get(callee.expression.text)!, true);
      }
    } else if (ts.isIdentifier(n) && named.has(n.text)) {
      const parent = n.parent;
      const isBinding =
        ts.isImportSpecifier(parent) || ts.isBindingElement(parent) ||
        ts.isShorthandPropertyAssignment(parent);
      if (!isBinding) mark(n.text, named.get(n.text)!, false);
    } else if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      namespaces.has(n.expression.text)
    ) {
      mark(n.name.text, namespaces.get(n.expression.text)!, false);
    }
    ts.forEachChild(n, use);
  };
  use(sf);

  const out: ImportUse[] = [];
  for (const [name, { spec, called }] of used) {
    const file = resolveImportedName(rel, spec, name);
    if (file) out.push({ name, file, called });
  }
  return out;
}

// ===========================================================================
// 1. A reconciler must reach its authority
// ===========================================================================

export type AuthorityReach =
  | { ok: true; how: "direct" }
  | { ok: true; how: "delegated"; via: string; file: string }
  | { ok: false };

/**
 * Does the named reconciler module reach the authority model?
 *
 *   DIRECT     its own code references the model; or
 *   DELEGATED  it CALLS an imported function whose defining module does.
 *
 * Exactly one hop, and only through a call. The worker bootstrap and
 * `lifecycle-recovery.ts` are honest owners that schedule a scan implemented
 * next door, so direct-only would reject true entries. But "imports it" or
 * "imports something that imports it" would accept anything named after the
 * bootstrap, which imports every processor in the worker — so a symbol that is
 * only passed along (a processor handed to a `Worker`) does not count, and the
 * delegate's own delegates are not followed.
 */
export function reconcilerReachesAuthority(reconcilerRel: string, model: string): AuthorityReach {
  if (referencesModel(reconcilerRel, model)) return { ok: true, how: "direct" };
  for (const u of importUses(reconcilerRel)) {
    if (u.called && referencesModel(u.file, model)) {
      return { ok: true, how: "delegated", via: u.name, file: u.file };
    }
  }
  return { ok: false };
}

// ===========================================================================
// 2. A job must have a producer CALL SITE
// ===========================================================================

/** The three functions through which every BullMQ job in this repo is added. */
export const ENQUEUE_PRIMITIVES = ["enqueueWork", "enqueueCanonicalWork", "enqueueCanonicalJob"];

export type ProducerHelper = { name: string; file: string; jobKeys: string[] };
export type ProducerCallSite = { jobKey: string; file: string; line: number; callee: string };

export type ProducerTopology = {
  helpers: ProducerHelper[];
  /** Call sites, keyed by JOB_NAMES key. */
  callSites: Map<string, ProducerCallSite[]>;
};

/** `JOB_NAMES.X` keys under a node. */
function jobKeysUnder(node: ts.Node, moduleConsts: Map<string, string[]>): string[] {
  const keys = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "JOB_NAMES"
    ) {
      keys.add(n.name.text);
    } else if (ts.isIdentifier(n) && moduleConsts.has(n.text)) {
      for (const k of moduleConsts.get(n.text)!) keys.add(k);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return [...keys];
}

/** Nearest enclosing NAMED function: a declaration, or a const bound to one. */
function enclosingNamedFunction(node: ts.Node): { name: string; node: ts.Node } | null {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return { name: cur.name.text, node: cur };
    if (
      (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
      ts.isVariableDeclaration(cur.parent) &&
      ts.isIdentifier(cur.parent.name)
    ) {
      return { name: cur.parent.name.text, node: cur };
    }
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) {
      return { name: cur.name.text, node: cur };
    }
  }
  return null;
}

/**
 * Who produces each job — measured as CALL SITES, not mentions.
 *
 * WHY THE OLD CHECK PASSED FIVE DEAD QUEUES
 * ---------------------------------------------------------------------------
 * The topology gate's producer set was "every `JOB_NAMES.X` that appears in
 * the worker transport or the api client". `queue.ts` mentions a job name
 * three times without producing anything: once to alias it, once in
 * `queueOptions(...)` to configure the Queue object, and once inside the
 * enqueue HELPER's own body. So a queue with a helper nobody called counted as
 * produced, and five of them did.
 *
 * WHAT COUNTS HERE
 * ---------------------------------------------------------------------------
 *   1. An ENQUEUE HELPER is a named function whose body calls one of the three
 *      enqueue primitives with arguments that name a job (`JOB_NAMES.X`
 *      directly, or a module constant initialised from it, e.g. `ENTRY`).
 *   2. A PRODUCER CALL SITE for that job is a call expression whose callee is
 *      that helper's name — or which is handed the helper as an argument, the
 *      way the redaction reconciler is handed its producer — anywhere in the
 *      runtime source, OUTSIDE the helper's own declaration.
 *   3. A primitive called with a job name outside any named function is itself
 *      a call site.
 *
 * A helper with no call site produces nothing, whatever it mentions.
 */
export function discoverProducerTopology(roots: string[] = runtimeSourceRoots()): ProducerTopology {
  const files = roots.flatMap(walkTs);
  const helpers: ProducerHelper[] = [];
  const callSites = new Map<string, ProducerCallSite[]>();
  const helperRanges: Array<{ name: string; file: string; start: number; end: number }> = [];

  const addSite = (site: ProducerCallSite): void => {
    const list = callSites.get(site.jobKey) ?? [];
    list.push(site);
    callSites.set(site.jobKey, list);
  };

  // Pass 1 — find the helpers.
  for (const file of files) {
    const text = readFileSync(resolve(REPO, file), "utf8");
    if (!ENQUEUE_PRIMITIVES.some((p) => text.includes(p))) continue;
    const sf = parse(file);

    const moduleConsts = new Map<string, string[]>();
    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const keys = jobKeysUnder(d.initializer, new Map());
        // A constant bound to ONE job is a name for that job (`ENTRY`,
        // `REGISTRY_ENTRY`). One that spans several is a table, not a name.
        if (keys.length === 1) moduleConsts.set(d.name.text, keys);
      }
    }

    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        ENQUEUE_PRIMITIVES.includes(n.expression.text)
      ) {
        const keys = n.arguments.flatMap((a) => jobKeysUnder(a, moduleConsts));
        if (keys.length > 0) {
          const owner = enclosingNamedFunction(n);
          if (owner && !ENQUEUE_PRIMITIVES.includes(owner.name)) {
            helpers.push({ name: owner.name, file, jobKeys: [...new Set(keys)] });
            helperRanges.push({
              name: owner.name,
              file,
              start: owner.node.getStart(sf),
              end: owner.node.getEnd(),
            });
          } else if (!owner) {
            for (const jobKey of new Set(keys)) {
              addSite({
                jobKey,
                file,
                line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
                callee: n.expression.text,
              });
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // Pass 2 — find calls to them.
  const byName = new Map<string, ProducerHelper[]>();
  for (const h of helpers) byName.set(h.name, [...(byName.get(h.name) ?? []), h]);
  const names = [...byName.keys()];

  for (const file of files) {
    const text = readFileSync(resolve(REPO, file), "utf8");
    if (!names.some((n) => text.includes(n))) continue;
    const sf = parse(file);
    const record = (callee: string, at: ts.Node): void => {
      const pos = at.getStart(sf);
      const insideOwnDeclaration = helperRanges.some(
        (r) => r.name === callee && r.file === file && pos >= r.start && pos < r.end,
      );
      if (insideOwnDeclaration) return;
      for (const h of byName.get(callee)!) {
        for (const jobKey of h.jobKeys) {
          addSite({
            jobKey,
            file,
            line: sf.getLineAndCharacterOfPosition(pos).line + 1,
            callee,
          });
        }
      }
    };
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const callee = ts.isIdentifier(n.expression)
          ? n.expression.text
          : ts.isPropertyAccessExpression(n.expression)
            ? n.expression.name.text
            : null;
        if (callee && byName.has(callee)) record(callee, n);
        // The helper HANDED to something that will call it — the redaction
        // reconciler receives its producer as `{ enqueue: <helper> }`. That is
        // a production path, so an argument that is (or carries) the helper
        // counts. A bare mention elsewhere — an import specifier, a re-export,
        // a type position — does not.
        for (const arg of n.arguments) {
          if (ts.isIdentifier(arg) && byName.has(arg.text)) record(arg.text, arg);
          if (ts.isObjectLiteralExpression(arg)) {
            for (const p of arg.properties) {
              if (
                ts.isPropertyAssignment(p) &&
                ts.isIdentifier(p.initializer) &&
                byName.has(p.initializer.text)
              ) {
                record(p.initializer.text, p.initializer);
              } else if (ts.isShorthandPropertyAssignment(p) && byName.has(p.name.text)) {
                record(p.name.text, p.name);
              }
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  return { helpers, callSites };
}

// ===========================================================================
// 3. A declared claim must name states and a lease the model can hold
// ===========================================================================

/** State-shaped tokens in a claim's `from` / `to` prose: `PENDING`, `RETRY_SCHEDULED`. */
export function claimStateTokens(text: string): string[] {
  return text.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [];
}

/**
 * Is `state` a value the runtime actually uses for this work?
 *
 * True when it is a member of a Prisma enum typing a field of the authority
 * model, or appears as a string literal — alone, or single-quoted inside a SQL
 * string — in one of the modules the entry names or in a module those import a
 * used name from. Status columns here are mostly VARCHAR with a CHECK
 * constraint, so the enum alone cannot answer; the code that writes the column
 * can.
 */
export function stateIsReal(state: string, model: string, modules: string[]): boolean {
  if (prismaEnumValuesOf(model).has(state)) return true;
  const reach = new Set<string>();
  for (const m of modules) {
    if (!existsSync(resolve(REPO, m))) continue;
    reach.add(m);
    for (const u of importUses(m)) reach.add(u.file);
  }
  const quoted = new RegExp(`'${state}'`);
  for (const m of reach) {
    if (sourceFacts(m).strings.some((s) => s === state || quoted.test(s))) return true;
  }
  return false;
}

// ===========================================================================
// 4. Is the retry timeout read by anything?
// ===========================================================================

/** Runtime source locations that read `<something>.retry.timeoutMs`. */
export function retryTimeoutReaders(roots: string[] = runtimeSourceRoots()): string[] {
  const out: string[] = [];
  for (const file of roots.flatMap(walkTs)) {
    // The registry self-check validates the declared value is positive; that
    // is a check ON the declaration, not an enforcement OF it.
    if (file === "packages/shared/src/queue-integrity/integrity.ts") continue;
    const text = readFileSync(resolve(REPO, file), "utf8");
    if (!text.includes("timeoutMs")) continue;
    const sf = parse(file);
    const visit = (n: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(n) &&
        n.name.text === "timeoutMs" &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "retry"
      ) {
        out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}
