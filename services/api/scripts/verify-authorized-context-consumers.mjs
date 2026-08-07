#!/usr/bin/env node
/**
 * PHASE 12 CORRECTIVE PASS 3 §2.1 — THE CONTEXT-CONSUMER GATE.
 *
 * Why this exists
 * ---------------------------------------------------------------------------
 * `AuthorizedWorkspaceContext` is unforgeable at runtime: it is minted into a
 * module-private `WeakSet` and a plain object, cast, spread, JSON round-trip,
 * `Object.create` impostor or `Proxy` is refused. That is proven
 * (`phase-12-authorized-context-runtime-brand.integration.test.ts`, 15/15).
 *
 * But an unforgeable value is only as good as the discipline of the code that
 * READS it, and the previous pass wired verification into "the highest-risk
 * consumers" — a phrase that names no set and therefore proves nothing. This
 * gate names the set, mechanically, from the AST.
 *
 * THE ACTUAL RISK BOUNDARY
 * ---------------------------------------------------------------------------
 * Not every field read needs an assertion, and pretending otherwise produces a
 * gate people route around. The distinction that matters is whether the value
 * being read is one this function MINTED, or one it was HANDED.
 *
 *   MINTED HERE   the context came from `authorizeWorkspaceOrFail` /
 *                 `authorizeCurrentWorkspaceOrFail` /
 *                 `evaluateAuthorizedWorkspace` / `evaluateCurrentWorkspace`
 *                 in this same function, and the deny path returned. The mint
 *                 IS the gate; there is no window in which an unproven value
 *                 exists, and re-asserting would re-run the policy engine for a
 *                 value it produced microseconds earlier.
 *
 *   HANDED IN     the context arrived as a PARAMETER, a property of a
 *                 parameter, or a module-level/captured binding. Nothing in
 *                 this function established its provenance. This is exactly
 *                 where a `.js` caller, a deserialised cache entry, a wrapper,
 *                 or a background job replaying stored state can substitute an
 *                 impostor — and where an assertion is mandatory.
 *
 * CLASSIFICATION OF READS (the mandate's A–F)
 * ---------------------------------------------------------------------------
 *   A display / secondary projection      -> provenance at minimum
 *   B tenant selection                    -> binding (actor + workspace)
 *   C authorization / capability decision -> binding
 *   D durable write                       -> live revalidation
 *   E external side effect                -> live revalidation
 *   F background / replayed operation     -> live revalidation
 *
 * A HANDED-IN context read at class A must pass `assertMintedContext`; at B/C
 * `assertMintedAuthorizedWorkspaceContext`; at D/E/F
 * `requireLiveAuthorizedWorkspaceContext`.
 *
 * `--selftest` proves the detector detects, on adversarial fixtures, before it
 * is allowed to report a zero.
 *
 * Bounded output: file, line, consumer, class, reason. No row data.
 */

import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(HERE, "..");
const SRC_ROOT = path.join(API_ROOT, "src");

/** The module that owns the type. Its own reads are the authority itself. */
const AUTHORITY_MODULE = "src/middleware/authorize.ts";

/** Calls that MINT a context in the calling frame. */
const MINTERS = new Set([
  "authorizeWorkspaceOrFail",
  "authorizeCurrentWorkspaceOrFail",
  "evaluateAuthorizedWorkspace",
  "evaluateCurrentWorkspace",
]);

/** Assertions, weakest to strongest. */
const ASSERT_PROVENANCE = "assertMintedContext";
const ASSERT_BINDING = "assertMintedAuthorizedWorkspaceContext";
const ASSERT_LIVE = "requireLiveAuthorizedWorkspaceContext";

const STRENGTH = {
  [ASSERT_PROVENANCE]: 1,
  [ASSERT_BINDING]: 2,
  [ASSERT_LIVE]: 3,
};

/** Required strength per read class. */
const REQUIRED_STRENGTH = { A: 1, B: 2, C: 2, D: 3, E: 3, F: 3 };

/** Fields that only a genuine context carries. Reading one is a consumption. */
const CONTEXT_FIELDS = new Set([
  "workspaceId",
  "workspaceKind",
  "workspaceRole",
  "membershipStatus",
  "organizationId",
  "organizationLifecycle",
  "capabilities",
]);

/**
 * How a read is classified, by what the value flows into. Ordered strongest
 * first — a read that is both a tenant selection and a durable write is a
 * durable write.
 */
const CLASS_RULES = [
  { cls: "E", test: /sendInvitationEmail|deliverEmail|deliverInvitationEmail|dispatchWebhook|fetch\(/ },
  { cls: "D", test: /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/ },
  { cls: "C", test: /contextHasCapability|workspaceRole|capabilities/ },
  { cls: "B", test: /teamId|workspaceId|where\s*:/ },
  { cls: "A", test: /.*/ },
];

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function parseWithParents(file) {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

function enclosingFunction(node) {
  let cur = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur)
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return node.getSourceFile();
}

function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** Names bound to a context MINTED inside `scope`. */
function mintedNames(scope) {
  const out = new Set();
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name && MINTERS.has(name)) {
        // `const ctx = await authorizeWorkspaceOrFail(...)`
        let cur = n.parent;
        if (cur && ts.isAwaitExpression(cur)) cur = cur.parent;
        if (cur && ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
          out.add(cur.name.text);
        }
        // `const outcome = await evaluateAuthorizedWorkspace(...)` then
        // `outcome.context` — the outcome binding carries the mint too.
        if (cur && ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
          out.add(`${cur.name.text}.context`);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);

  // ALIAS PROPAGATION. The idiomatic shape is
  //     const outcome = await evaluateAuthorizedWorkspace(...);
  //     if (!outcome.allowed) return null;
  //     const authorized = outcome.context;
  // so the name the handler actually reads is one hop from the mint. Without
  // this, every such handler looked like it was consuming a handed-in context
  // and the gate reported its own idiom as a violation.
  let changed = true;
  while (changed) {
    changed = false;
    const alias = (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        !out.has(n.name.text)
      ) {
        const init = n.initializer.getText(n.getSourceFile());
        if (out.has(init)) {
          out.add(n.name.text);
          changed = true;
        }
      }
      ts.forEachChild(n, alias);
    };
    alias(scope);
  }
  return out;
}

/** Names on which an assertion of at least `strength` was performed in `scope`. */
function assertedNames(scope) {
  const out = new Map();
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      const strength = STRENGTH[name];
      if (strength) {
        const arg = n.arguments[0];
        const key = arg ? arg.getText(arg.getSourceFile()) : null;
        if (key) out.set(key, Math.max(out.get(key) ?? 0, strength));
        // `const proven = assertMinted...(candidate, …)` — the RESULT is
        // asserted at that strength too.
        let cur = n.parent;
        if (cur && ts.isAwaitExpression(cur)) cur = cur.parent;
        if (cur && ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
          out.set(cur.name.text, Math.max(out.get(cur.name.text) ?? 0, strength));
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return out;
}

/**
 * Names whose DECLARED TYPE is the authorization context, in `scope` or in any
 * enclosing scope.
 *
 * Typing, not naming, is the discriminator. The first draft treated any
 * parameter with a `.workspaceId` field as a context and reported 219
 * violations, almost all of them on objects that merely happen to carry a
 * workspace id — an audit-params bag, a route options object, a projection row.
 * A gate whose output is mostly noise is a gate that gets suppressed wholesale,
 * which is how a real consumer ends up unguarded.
 *
 * Only a value the code itself declares to BE an `AuthorizedWorkspaceContext`
 * is judged here. Anything else is not this gate's business, and if a genuine
 * context is passed as `unknown` or `any` to dodge the annotation, the read
 * cannot compile against the branded type in the first place.
 */
function contextTypedNames(node) {
  const out = new Set();
  const isContextType = (t) =>
    !!t && /AuthorizedWorkspaceContext/.test(t.getText(t.getSourceFile()));

  const collectFrom = (scope) => {
    for (const p of scope.parameters ?? []) {
      if (isContextType(p.type) && ts.isIdentifier(p.name)) out.add(p.name.text);
      // `{ authorized }: { authorized: AuthorizedWorkspaceContext }`
      if (p.type && isContextType(p.type) && ts.isObjectBindingPattern(p.name)) {
        for (const el of p.name.elements) {
          if (ts.isIdentifier(el.name)) out.add(el.name.text);
        }
      }
    }
    const visit = (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        isContextType(n.type)
      ) {
        out.add(n.name.text);
      }
      // `type X = { authorized: AuthorizedWorkspaceContext }` — reads take the
      // form `ctx.authorized.workspaceId`, so record the PROPERTY path tail.
      if (ts.isPropertySignature(n) && ts.isIdentifier(n.name) && isContextType(n.type)) {
        out.add(n.name.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(scope);
  };

  let cur = node;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isSourceFile(cur)
    ) {
      collectFrom(cur);
    }
    cur = cur.parent;
  }
  return out;
}

/** Classify a read by the statement it sits in. */
function classifyRead(node) {
  let stmt = node;
  while (stmt.parent && !ts.isStatement(stmt)) stmt = stmt.parent;
  const text = stmt.getText(stmt.getSourceFile());
  for (const r of CLASS_RULES) if (r.test.test(text)) return r.cls;
  return "A";
}

function relativeToApi(file) {
  return path.relative(API_ROOT, file).split(path.sep).join("/");
}

/**
 * Find every consumption of a context field, and decide whether it is
 * adequately guarded.
 */
function analyse(sourceFile, relPath) {
  const violations = [];
  let reads = 0;
  let mintedHere = 0;
  let asserted = 0;

  const visit = (node) => {
    // `assertMinted…(x, …).workspaceRole` — a read off the RESULT of an
    // assertion. Counted as asserted rather than skipped: if these were merely
    // invisible to the detector, `assertedConsumers` would read 0 while real
    // assertions were in place, and a future refactor that dropped one would
    // move the count from 0 to 0.
    if (
      ts.isPropertyAccessExpression(node) &&
      CONTEXT_FIELDS.has(node.name.text) &&
      ts.isCallExpression(node.expression) &&
      STRENGTH[calleeName(node.expression) ?? ""]
    ) {
      reads += 1;
      asserted += 1;
      ts.forEachChild(node, visit);
      return;
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      CONTEXT_FIELDS.has(node.name.text) &&
      // `x.workspaceId` where `x` is a plain identifier or a property access.
      (ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression))
    ) {
      const base = node.expression.getText(sourceFile);
      const scope = enclosingFunction(node);
      const minted = mintedNames(scope);
      const typed = contextTypedNames(node);

      // Judge ONLY values the code declares to BE a context: minted here, or
      // annotated as `AuthorizedWorkspaceContext` somewhere in scope. See
      // `contextTypedNames` for why naming heuristics were removed.
      const tail = base.split(".").pop();
      const isContext = minted.has(base) || typed.has(base) || typed.has(tail);
      if (!isContext) {
        ts.forEachChild(node, visit);
        return;
      }

      reads += 1;
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const cls = classifyRead(node);

      if (minted.has(base)) {
        // Minted in this very frame; the mint is the gate.
        mintedHere += 1;
        ts.forEachChild(node, visit);
        return;
      }

      const asserts = assertedNames(scope);
      const have = asserts.get(base) ?? asserts.get(base.split(".")[0]) ?? 0;
      const need = REQUIRED_STRENGTH[cls];
      if (have >= need) {
        asserted += 1;
      } else {
        violations.push({
          file: relPath,
          line: line + 1,
          consumer: base,
          readClass: cls,
          have,
          need,
          reason:
            `A context that was HANDED IN is read at class ${cls}, which requires ` +
            `${need === 3 ? ASSERT_LIVE : need === 2 ? ASSERT_BINDING : ASSERT_PROVENANCE}. ` +
            `Nothing in this function establishes the value's provenance.`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { reads, mintedHere, asserted, violations };
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

const FIXTURES = [
  {
    name: "handed-in-context-durable-write-unguarded",
    mustFlag: true,
    code: `
      declare const prisma: any;
      type AuthorizedWorkspaceContext = { workspaceId: string; workspaceRole: string };
      export async function f(ctx: AuthorizedWorkspaceContext) {
        return prisma.evidence.create({ data: { teamId: ctx.workspaceId } });
      }
    `,
  },
  {
    name: "handed-in-context-tenant-select-unguarded",
    mustFlag: true,
    code: `
      declare const prisma: any;
      type AuthorizedWorkspaceContext = { workspaceId: string; workspaceRole: string };
      export async function f(ctx: AuthorizedWorkspaceContext) {
        return prisma.evidence.findMany({ where: { teamId: ctx.workspaceId } });
      }
    `,
  },
  {
    name: "handed-in-context-capability-unguarded",
    mustFlag: true,
    code: `
      export function f(ctx: AuthorizedWorkspaceContext) {
        return ctx.workspaceRole === "OWNER";
      }
    `,
  },
  {
    name: "handed-in-context-external-side-effect-unguarded",
    mustFlag: true,
    code: `
      declare function sendInvitationEmail(i: any): Promise<void>;
      export async function f(ctx: AuthorizedWorkspaceContext) {
        await sendInvitationEmail({ teamId: ctx.workspaceId });
      }
    `,
  },
  {
    name: "handed-in-context-guarded-too-weakly-for-a-write",
    mustFlag: true,
    code: `
      declare const prisma: any;
      type AuthorizedWorkspaceContext = { workspaceId: string; workspaceRole: string };
      declare function assertMintedContext(c: unknown): any;
      export async function f(ctx: AuthorizedWorkspaceContext) {
        assertMintedContext(ctx);
        return prisma.evidence.create({ data: { teamId: ctx.workspaceId } });
      }
    `,
  },
  {
    name: "minted-in-frame-is-not-flagged",
    mustFlag: false,
    code: `
      declare const prisma: any;
      type AuthorizedWorkspaceContext = { workspaceId: string; workspaceRole: string };
      declare function authorizeWorkspaceOrFail(a: any, b: any, c: any): Promise<any>;
      export async function f(req: any, reply: any) {
        const ctx = await authorizeWorkspaceOrFail(req, reply, { workspaceId: "x", permission: "evidence.read" });
        if (!ctx) return;
        return prisma.evidence.create({ data: { teamId: ctx.workspaceId } });
      }
    `,
  },
  {
    name: "handed-in-context-live-revalidated-write",
    mustFlag: false,
    code: `
      declare const prisma: any;
      type AuthorizedWorkspaceContext = { workspaceId: string; workspaceRole: string };
      declare function requireLiveAuthorizedWorkspaceContext(c: unknown, e: any): Promise<any>;
      export async function f(ctx: AuthorizedWorkspaceContext, workspaceId: string) {
        const proven = await requireLiveAuthorizedWorkspaceContext(ctx, { workspaceId });
        return prisma.evidence.create({ data: { teamId: proven.workspaceId } });
      }
    `,
  },
  {
    name: "handed-in-context-binding-asserted-tenant-select",
    mustFlag: false,
    code: `
      declare const prisma: any;
      type AuthorizedWorkspaceContext = { workspaceId: string; workspaceRole: string };
      declare function assertMintedAuthorizedWorkspaceContext(c: unknown, e: any): any;
      export async function f(ctx: AuthorizedWorkspaceContext, workspaceId: string) {
        assertMintedAuthorizedWorkspaceContext(ctx, { workspaceId });
        return prisma.evidence.findMany({ where: { teamId: ctx.workspaceId } });
      }
    `,
  },
];

function runSelfTest() {
  const dir = mkdtempSync(path.join(tmpdir(), "p12-ctx-fixtures-"));
  const failures = [];
  try {
    for (const f of FIXTURES) {
      const file = path.join(dir, `${f.name}.ts`);
      writeFileSync(file, f.code, "utf8");
      const { violations } = analyse(parseWithParents(file), f.name);
      const flagged = violations.length > 0;
      if (f.mustFlag && !flagged) {
        failures.push(`${f.name}: an UNGUARDED handed-in consumption was NOT detected.`);
      }
      if (!f.mustFlag && flagged) {
        failures.push(
          `${f.name}: a CORRECTLY GUARDED consumption was flagged (${violations
            .map((v) => `${v.readClass}:${v.consumer}`)
            .join(", ")}). A gate that refuses the prescribed pattern forces the wrong one.`,
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const selfTestFailures = runSelfTest();

  const configPath = path.join(API_ROOT, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, (p) => readFileSync(p, "utf8"));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, API_ROOT);

  const summary = {
    modulesScanned: 0,
    contextFieldReads: 0,
    mintedInFrame: 0,
    assertedConsumers: 0,
    selfTestFixtures: FIXTURES.length,
    selfTestFailures: selfTestFailures.length,
    unvalidatedAuthorizedContextConsumers: 0,
  };
  const violations = [];

  for (const fileName of parsed.fileNames) {
    const file = path.normalize(fileName);
    if (file.endsWith(".d.ts")) continue;
    if (!file.startsWith(SRC_ROOT + path.sep)) continue;
    if (!existsSync(file)) continue;
    const rel = relativeToApi(file);
    if (rel === AUTHORITY_MODULE) continue; // the authority itself
    summary.modulesScanned += 1;
    const r = analyse(parseWithParents(file), rel);
    summary.contextFieldReads += r.reads;
    summary.mintedInFrame += r.mintedHere;
    summary.assertedConsumers += r.asserted;
    violations.push(...r.violations);
  }

  summary.unvalidatedAuthorizedContextConsumers = violations.length;

  process.stdout.write(
    `${JSON.stringify(
      {
        check: "authorized-context-consumers",
        generatedBy: "services/api/scripts/verify-authorized-context-consumers.mjs",
        summary,
        violations: violations.sort((a, b) =>
          a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
        ),
        selfTestFailures,
      },
      null,
      2,
    )}\n`,
  );

  if (selfTestFailures.length > 0) {
    process.stderr.write(
      `\nCONTEXT-CONSUMER GATE SELF-TEST FAILED — ${selfTestFailures.length} fixture(s).\n`,
    );
    process.exit(1);
  }
  if (violations.length > 0) {
    process.stderr.write(
      `\nCONTEXT-CONSUMER GATE FAILED — ${violations.length} unvalidated consumer(s).\n` +
        "A context that was handed in must be asserted at the strength its read class requires:\n" +
        "  A -> assertMintedContext · B/C -> assertMintedAuthorizedWorkspaceContext · D/E/F -> requireLiveAuthorizedWorkspaceContext\n",
    );
    process.exit(1);
  }
}

main();
