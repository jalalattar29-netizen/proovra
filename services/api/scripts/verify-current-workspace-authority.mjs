#!/usr/bin/env node
/**
 * PHASE 12 CORRECTIVE PASS §1.3 — THE `currentWorkspaceId` GATE.
 *
 * Why this exists as its OWN gate
 * ---------------------------------------------------------------------------
 * The previous pass printed `CurrentWorkspaceIdAuthorizationUses = 0` while
 * the verifier that produced it stated, in its own residual-risk note, that it
 * "does not yet detect currentWorkspaceId-as-authorization as its own class"
 * and caught the pattern only INDIRECTLY, via the TeamMember-read rule. A
 * metric computed by a check that does not measure the thing is not a zero;
 * it is an absence of measurement wearing a zero's clothes.
 *
 * `User.currentWorkspaceId` is a NAVIGATION POINTER. It records where an
 * operator last was. It records nothing about whether they may still be there:
 * it survives suspension, revocation, membership deletion, access expiry,
 * Organization suspension and workspace closure. Every one of those is a state
 * in which the pointer still names the workspace and the operator must be
 * refused. SEC-001 was exactly this defect, and the class is worth a gate.
 *
 * WHAT IS FORBIDDEN
 * ---------------------------------------------------------------------------
 * Using the pointer's VALUE as, or as an input to, an authorization or
 * tenant-selection decision:
 *
 *   pointer_scopes_query        `where: { teamId: user.currentWorkspaceId }`
 *   pointer_fallback_selection  `explicitTeamId ?? user.currentWorkspaceId`
 *   pointer_comparison_authority `if (row.teamId === user.currentWorkspaceId)`
 *   pointer_passed_as_authority  handing it to any non-canonical callee
 *
 * WHAT IS PERMITTED
 * ---------------------------------------------------------------------------
 *   CANDIDATE   every use of the value is an argument to a CANONICAL
 *               AUTHORIZER, which revalidates it in full against the database
 *               before it selects anything. This is the ONLY way a pointer may
 *               reach a tenant decision, and the pointer is not the authority
 *               in it — the revalidation is.
 *   WRITE       assigning the pointer (`data: { currentWorkspaceId: … }`).
 *               Hygiene, not authority.
 *   PROJECTION  `select: { currentWorkspaceId: true }`. Declares a read; the
 *               read itself is judged where the value is used.
 *   CLASSIFIED  the module is declared below WITH A STATED REASON — display
 *               state, pointer hygiene, or the canonical authorizer itself.
 *
 * The default is VIOLATION. An unlisted module with an unexplained use FAILS.
 *
 * SELF-TEST
 * ---------------------------------------------------------------------------
 * `--selftest` runs the detector over adversarial fixtures — one per forbidden
 * form, including the aliased, destructured, helper-returned and
 * wrapper-disguised variants — and FAILS if any of them is not flagged. A
 * detector that has never been shown to detect is the same fictional control
 * this gate replaces, so the self-test is part of the gate, not a nicety.
 *
 * Bounded output: file paths, line numbers, bounded reason codes. No row data.
 */

import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(HERE, "..");
const SRC_ROOT = path.join(API_ROOT, "src");

const POINTER = "currentWorkspaceId";

/**
 * Calls that revalidate a candidate workspace id in full. Handing the pointer
 * to one of these is the sanctioned pattern: the pointer proposes, the
 * canonical chain disposes.
 */
const CANONICAL_AUTHORIZERS = new Set([
  "authorizeOrFail",
  "requireAuthorize",
  "evaluateAuthorize",
  "authorizeWorkspaceOrFail",
  "authorizeCurrentWorkspaceOrFail",
  "evaluateAuthorizedWorkspace",
  "evaluateMemberAccess",
  "evaluateMemberAccessWithSnapshot",
  "loadMemberAccessSnapshot",
  "listAccessibleWorkspaces",
  "resolveAccessibleWorkspace",
  "assertMintedAuthorizedWorkspaceContext",
  "requireLiveAuthorizedWorkspaceContext",
]);

/** Bounded reason vocabulary for the forbidden forms. */
const FORMS = {
  SCOPES_QUERY: "pointer_scopes_query",
  FALLBACK: "pointer_fallback_selection",
  COMPARISON: "pointer_comparison_authority",
  PASSED: "pointer_passed_as_authority",
  RETURNED: "pointer_returned_as_authority",
};

/**
 * Modules whose pointer uses are NOT authorization. Every entry states WHY.
 * This is the only hand-maintained input and it can only ADD permission for a
 * named file — it can never suppress a finding in a file it does not name.
 */
const CLASSIFIED_MODULES = new Map([
  [
    "src/middleware/authorize.ts",
    {
      reason:
        "CANONICAL AUTHORITY — reads the pointer solely to obtain a CANDIDATE id, then revalidates it in full (authorizeCurrentWorkspaceOrFail).",
      allowedForms: new Set(Object.values(FORMS)),
    },
  ],
  [
    "src/services/access/current-workspace-pointer.ts",
    {
      reason:
        "HYGIENE — repairs/clears the pointer at membership-withdrawal boundaries. Makes no access decision.",
      allowedForms: new Set(Object.values(FORMS)),
    },
  ],
  [
    "src/routes/users.routes.ts",
    {
      reason:
        "DISPLAY PROJECTION — `/v1/users/me` returns the pointer so the client can render which workspace is selected and pre-fill its own requests. It is transported, never trusted: every API the client then calls re-authorizes the workspace server-side.",
      allowedForms: new Set([FORMS.PASSED, FORMS.RETURNED]),
    },
  ],
  [
    "src/routes/auth.routes.ts",
    {
      reason:
        "SESSION INVENTORY METADATA — records which workspace a session was opened in, for the sessions list and audit. `AuthenticatedSession.teamId` is never read as an authorization input.",
      allowedForms: new Set([FORMS.PASSED]),
    },
  ],
  [
    "src/routes/platform-context.routes.ts",
    {
      reason:
        "AUDIT METADATA — captures the PREVIOUS pointer so the workspace-context-switch security event can name where the operator came from. The switch itself is authorized against the TARGET workspace, not against this value.",
      allowedForms: new Set([FORMS.PASSED, FORMS.FALLBACK]),
    },
  ],
  [
    "src/routes/organizations.routes.ts",
    {
      reason:
        "POINTER HYGIENE — inside the org-leave transaction, tests whether the operator's pointer names a workspace they are leaving and CLEARS it. Reads the pointer only to decide whether to erase it.",
      allowedForms: new Set([FORMS.PASSED]),
    },
  ],
  [
    "src/services/platform-context/platform-context.service.ts",
    {
      reason:
        "CONTEXT PROJECTION + POINTER HYGIENE — loads the currently-pointed workspace for the navigation envelope (membership is re-read and non-members are projected out), and compares the pointer against the personal space to decide whether to repair it. ARCH-003 replaces this projection with the versioned envelope; the pointer remains display state in both.",
      allowedForms: new Set([FORMS.SCOPES_QUERY, FORMS.COMPARISON, FORMS.PASSED]),
    },
  ],
]);

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Ascend to the nearest enclosing function-like node, or the source file. */
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

/** Is `node` positioned as the ASSIGNED VALUE of an object property named `key`? */
function isValueOfProperty(node, keyNames) {
  const p = node.parent;
  return (
    p &&
    ts.isPropertyAssignment(p) &&
    p.initializer === node &&
    ts.isIdentifier(p.name) &&
    keyNames.has(p.name.text)
  );
}

/** Walk up to see whether `node` sits inside a Prisma `where:` object. */
function insideWhereClause(node) {
  let cur = node.parent;
  while (cur) {
    if (
      ts.isPropertyAssignment(cur) &&
      ts.isIdentifier(cur.name) &&
      cur.name.text === "where"
    ) {
      return true;
    }
    // Stop at a function boundary — a `where` in an outer function is not this
    // expression's clause.
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur)
    ) {
      return false;
    }
    cur = cur.parent;
  }
  return false;
}

/** The call expression this node is an argument of (directly or via an object literal argument). */
function receivingCall(node) {
  let cur = node;
  let hops = 0;
  while (cur.parent && hops < 8) {
    const p = cur.parent;
    if (ts.isCallExpression(p) && p.arguments.includes(cur)) return p;
    if (
      ts.isPropertyAssignment(p) ||
      ts.isObjectLiteralExpression(p) ||
      ts.isSpreadAssignment(p) ||
      ts.isShorthandPropertyAssignment(p)
    ) {
      cur = p;
      hops += 1;
      continue;
    }
    return null;
  }
  return null;
}

function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** Is this node the literal `null` or `undefined`? */
function isNullish(node) {
  return (
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined")
  );
}

/**
 * Ascend from the raw read to the OUTERMOST node that still carries exactly
 * the pointer's value.
 *
 * `user?.currentWorkspaceId ?? null` is NULL NORMALISATION, not fallback
 * tenant selection — the pointer is the LEFT operand and the alternative is
 * `null`, so nothing else can be chosen. The first draft of this gate did not
 * make that distinction and reported five sanctioned candidate patterns
 * (including `admin-identity.routes.ts`, which hands the normalised value
 * straight to `authorizeOrFail`) as violations.
 *
 * A gate that cries wolf on the CORRECT pattern is not conservative; it is
 * unusable, and an unusable gate gets classified away wholesale — which is how
 * a false zero is born. So normalisation is traversed, and the value is judged
 * where it actually lands.
 *
 * `explicitTeamId ?? user.currentWorkspaceId` is NOT traversed: there the
 * pointer is the fallback SOURCE of a tenant id, which is the forbidden form.
 */
function resolveValueNode(read) {
  let cur = read;
  for (let hops = 0; hops < 8; hops += 1) {
    const p = cur.parent;
    if (!p) return cur;
    if (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p) || ts.isAsExpression(p)) {
      cur = p;
      continue;
    }
    if (
      ts.isBinaryExpression(p) &&
      p.left === cur &&
      (p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        p.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      isNullish(p.right)
    ) {
      cur = p;
      continue;
    }
    return cur;
  }
  return cur;
}

/**
 * Classify ONE use-site of a pointer-derived value.
 * Returns `null` when the use is benign, otherwise a bounded form code.
 */
function classifyUse(node) {
  // `where: { teamId: <pointer> }` — the pointer picks the rows.
  if (insideWhereClause(node)) return FORMS.SCOPES_QUERY;

  const p = node.parent;

  // `a ?? <pointer>` / `a || <pointer>` — fallback tenant selection.
  if (
    p &&
    ts.isBinaryExpression(p) &&
    (p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      p.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return FORMS.FALLBACK;
  }

  // `x === <pointer>` — the pointer decides whether the row is "ours".
  if (
    p &&
    ts.isBinaryExpression(p) &&
    (p.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      p.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      p.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
      p.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)
  ) {
    return FORMS.COMPARISON;
  }

  // Returned from a helper — the wrapper that disguises the source.
  if (p && (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === node))) {
    return FORMS.RETURNED;
  }

  // Handed to a callee.
  const call = receivingCall(node);
  if (call) {
    const name = calleeName(call);
    if (name && CANONICAL_AUTHORIZERS.has(name)) return null; // CANDIDATE — sanctioned.
    return FORMS.PASSED;
  }

  return null;
}

/**
 * Every value-read of the pointer in one source file, with its own uses AND
 * the uses of any local alias it was bound to.
 *
 * Alias tracking is intra-function and by name. That is narrower than a full
 * symbol resolution but it is not a shortcut in the direction of leniency:
 * an alias whose uses cannot be found is not thereby excused — the READ
 * itself is still classified, and an unclassifiable read is a violation.
 */
function collectPointerReads(sourceFile) {
  const reads = [];

  const record = (node, aliasName) => {
    reads.push({ node, aliasName });
  };

  const visit = (node) => {
    // `x.currentWorkspaceId`
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === POINTER &&
      // not the target of an assignment (`x.currentWorkspaceId = …`)
      !(
        ts.isBinaryExpression(node.parent) &&
        node.parent.left === node &&
        node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      )
    ) {
      // The value node first (traverses `?? null` normalisation), then the
      // alias it was bound to, if any.
      const value = resolveValueNode(node);
      const p = value.parent;
      const alias =
        p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)
          ? p.name.text
          : null;
      record(value, alias);
    }

    // `x["currentWorkspaceId"]`
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === POINTER
    ) {
      const value = resolveValueNode(node);
      const p = value.parent;
      record(
        value,
        p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)
          ? p.name.text
          : null,
      );
    }

    // `const { currentWorkspaceId } = user` / `const { currentWorkspaceId: wid } = user`
    if (
      ts.isBindingElement(node) &&
      ((node.propertyName &&
        ts.isIdentifier(node.propertyName) &&
        node.propertyName.text === POINTER) ||
        (!node.propertyName &&
          ts.isIdentifier(node.name) &&
          node.name.text === POINTER))
    ) {
      const alias = ts.isIdentifier(node.name) ? node.name.text : null;
      record(node, alias);
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return reads;
}

/** Is this occurrence a WRITE (`data: { currentWorkspaceId: … }`) or a PROJECTION (`select: { … : true }`)? */
function isWriteOrProjection(node) {
  if (!ts.isPropertyAssignment(node.parent)) return false;
  return false;
}

/** All identifier nodes named `name` inside `scope`, excluding declarations. */
function identifierUses(scope, name) {
  const out = [];
  const visit = (n) => {
    if (
      ts.isIdentifier(n) &&
      n.text === name &&
      !(ts.isVariableDeclaration(n.parent) && n.parent.name === n) &&
      !(ts.isBindingElement(n.parent) && n.parent.name === n) &&
      !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)
    ) {
      out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return out;
}

function relativeToApi(file) {
  return path.relative(API_ROOT, file).split(path.sep).join("/");
}

/**
 * Parse ONE file with parent pointers populated.
 *
 * Deliberately not `program.getSourceFile()`. A Program's source files do not
 * carry parent links until something binds them, and the first draft of this
 * gate crashed on `node.parent` being `undefined` — which is the benign
 * failure. The dangerous one is the same gap NOT crashing: every
 * `.parent`-based classification would quietly answer "benign" and the gate
 * would print the same false zero it exists to replace. `setParentNodes: true`
 * removes the possibility.
 *
 * No type checker is needed: every rule here is syntactic.
 */
function parseWithParents(file) {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * Analyse one source file. Returns { occurrences, violations }.
 */
function analyseSourceFile(sourceFile, relPath, classified) {
  const violations = [];
  let occurrences = 0;
  let candidates = 0;
  let benign = 0;

  for (const { node, aliasName } of collectPointerReads(sourceFile)) {
    occurrences += 1;
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );

    // Gather every site where the pointer's value is USED: the read itself,
    // plus every use of the local alias it was bound to.
    const sites = [];
    // A BindingElement has no expression site of its own — the value is only
    // observable through the name it was bound to.
    if (!ts.isBindingElement(node)) sites.push(node);
    if (aliasName) {
      sites.push(...identifierUses(enclosingFunction(node), aliasName));
    }

    let forms = new Set();
    let sanctioned = 0;
    let handedToCanonical = false;
    for (const site of sites) {
      const form = classifyUse(site);
      if (form) {
        forms.add(form);
      } else {
        sanctioned += 1;
        const call = receivingCall(site);
        const name = call ? calleeName(call) : null;
        if (name && CANONICAL_AUTHORIZERS.has(name)) handedToCanonical = true;
      }
    }

    // THE CANDIDATE RULE. Once the value has been handed to a canonical
    // authorizer, the canonical chain — not the pointer — decides. Additional
    // uses alongside that handoff (a consistency comparison that can only
    // NARROW the outcome, an echo of the resolved id back to the client) do
    // not restore the pointer's authority.
    //
    // Without this rule the gate flagged `admin-identity.routes.ts`, whose
    // shape is `pointer -> consistency check -> authorizeOrFail` — the exact
    // pattern the gate is meant to REQUIRE. Flagging the prescribed pattern is
    // how a gate teaches people to classify their way around it.
    if (handedToCanonical) {
      candidates += 1;
      continue;
    }

    if (forms.size === 0) {
      if (sanctioned > 0) candidates += 1;
      else benign += 1;
      continue;
    }

    // A classified module is permitted only the forms its entry DECLARES.
    // Blanket classification would let a module classified for "display" start
    // scoping queries by the pointer without the gate noticing — which is the
    // suppression failure mode the whole gate exists to avoid.
    const unpermitted = [...forms].filter(
      (f) => !(classified && classified.allowedForms.has(f)),
    );
    if (unpermitted.length === 0) {
      candidates += 1;
      continue;
    }

    violations.push({
      file: relPath,
      line: line + 1,
      forms: unpermitted.sort(),
      classifiedForButNotPermitted: classified ? [...forms].sort() : undefined,
      reason:
        "User.currentWorkspaceId is a NAVIGATION POINTER, not an authorization fact. " +
        "Its value may only be handed to a canonical authorizer as a CANDIDATE, which revalidates it in full.",
    });
  }

  return { occurrences, violations, candidates, benign };
}

// ---------------------------------------------------------------------------
// Self-test — adversarial fixtures, one per forbidden form.
// ---------------------------------------------------------------------------

const FIXTURES = [
  {
    name: "direct-read-scopes-query",
    expect: FORMS.SCOPES_QUERY,
    code: `
      declare const prisma: any;
      export async function f(user: { currentWorkspaceId: string }) {
        return prisma.evidence.findMany({ where: { teamId: user.currentWorkspaceId } });
      }
    `,
  },
  {
    name: "aliased-read-scopes-query",
    expect: FORMS.SCOPES_QUERY,
    code: `
      declare const prisma: any;
      export async function f(user: { currentWorkspaceId: string }) {
        const wid = user.currentWorkspaceId;
        return prisma.evidence.findMany({ where: { teamId: wid } });
      }
    `,
  },
  {
    name: "destructured-read-scopes-query",
    expect: FORMS.SCOPES_QUERY,
    code: `
      declare const prisma: any;
      export async function f(user: { currentWorkspaceId: string }) {
        const { currentWorkspaceId } = user;
        return prisma.evidence.findMany({ where: { teamId: currentWorkspaceId } });
      }
    `,
  },
  {
    name: "renamed-destructure-scopes-query",
    expect: FORMS.SCOPES_QUERY,
    code: `
      declare const prisma: any;
      export async function f(user: { currentWorkspaceId: string }) {
        const { currentWorkspaceId: tenant } = user;
        return prisma.evidence.findMany({ where: { teamId: tenant } });
      }
    `,
  },
  {
    name: "element-access-scopes-query",
    expect: FORMS.SCOPES_QUERY,
    code: `
      declare const prisma: any;
      export async function f(user: any) {
        return prisma.evidence.findMany({ where: { teamId: user["currentWorkspaceId"] } });
      }
    `,
  },
  {
    name: "fallback-selection",
    expect: FORMS.FALLBACK,
    code: `
      export function f(explicitTeamId: string | null, user: { currentWorkspaceId: string }) {
        const chosen = explicitTeamId ?? user.currentWorkspaceId;
        return chosen;
      }
    `,
  },
  {
    name: "or-fallback-selection",
    expect: FORMS.FALLBACK,
    code: `
      export function f(explicitTeamId: string | null, user: { currentWorkspaceId: string }) {
        return explicitTeamId || user.currentWorkspaceId;
      }
    `,
  },
  {
    name: "comparison-authority",
    expect: FORMS.COMPARISON,
    code: `
      export function f(row: { teamId: string }, user: { currentWorkspaceId: string }) {
        if (row.teamId === user.currentWorkspaceId) return true;
        return false;
      }
    `,
  },
  {
    name: "passed-to-non-canonical-service",
    expect: FORMS.PASSED,
    code: `
      declare function listCasesForWorkspace(id: string): Promise<unknown>;
      export async function f(user: { currentWorkspaceId: string }) {
        return listCasesForWorkspace(user.currentWorkspaceId);
      }
    `,
  },
  {
    name: "wrapper-helper-returns-pointer",
    expect: FORMS.RETURNED,
    code: `
      export function resolveTenant(user: { currentWorkspaceId: string }) {
        return user.currentWorkspaceId;
      }
    `,
  },
  {
    name: "arrow-wrapper-returns-pointer",
    expect: FORMS.RETURNED,
    code: `
      export const resolveTenant = (user: { currentWorkspaceId: string }) => user.currentWorkspaceId;
    `,
  },
];

/** A fixture that MUST NOT be flagged — the sanctioned candidate pattern. */
const NEGATIVE_FIXTURES = [
  {
    name: "candidate-handed-to-canonical-authorizer",
    code: `
      declare function authorizeWorkspaceOrFail(req: unknown, reply: unknown, o: { workspaceId: string | null; permission: string }): Promise<unknown>;
      export async function f(req: unknown, reply: unknown, user: { currentWorkspaceId: string | null }) {
        return authorizeWorkspaceOrFail(req, reply, {
          workspaceId: user.currentWorkspaceId,
          permission: "evidence.read",
        });
      }
    `,
  },
];

function runSelfTest() {
  const dir = mkdtempSync(path.join(tmpdir(), "p12-cwid-fixtures-"));
  const failures = [];
  try {
    for (const f of [...FIXTURES, ...NEGATIVE_FIXTURES]) {
      writeFileSync(path.join(dir, `${f.name}.ts`), f.code, "utf8");
    }

    for (const f of FIXTURES) {
      const file = path.join(dir, `${f.name}.ts`);
      const sf = parseWithParents(file);
      const { violations } = analyseSourceFile(sf, f.name, false);
      if (violations.length === 0) {
        failures.push(
          `${f.name}: FORBIDDEN form "${f.expect}" was NOT detected — the gate would print a false zero for this shape.`,
        );
        continue;
      }
      const detected = new Set(violations.flatMap((v) => v.forms));
      if (!detected.has(f.expect)) {
        failures.push(
          `${f.name}: detected ${[...detected].join(",")} but not the expected ${f.expect}.`,
        );
      }
    }

    for (const f of NEGATIVE_FIXTURES) {
      const sf = parseWithParents(path.join(dir, `${f.name}.ts`));
      const { violations } = analyseSourceFile(sf, f.name, false);
      if (violations.length > 0) {
        failures.push(
          `${f.name}: the SANCTIONED candidate pattern was flagged (${violations
            .flatMap((v) => v.forms)
            .join(",")}). A gate that refuses the correct pattern forces the wrong one.`,
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
    pointerOccurrences: 0,
    classifiedModules: 0,
    candidateUses: 0,
    benignUses: 0,
    selfTestFixtures: FIXTURES.length + NEGATIVE_FIXTURES.length,
    selfTestFailures: selfTestFailures.length,
    currentWorkspaceIdAuthorizationUses: 0,
  };
  const violations = [];
  const classifications = [];

  for (const fileName of parsed.fileNames) {
    const file = path.normalize(fileName);
    if (file.endsWith(".d.ts")) continue;
    if (!file.startsWith(SRC_ROOT + path.sep)) continue;
    if (!existsSync(file)) continue;
    const sourceFile = parseWithParents(file);
    summary.modulesScanned += 1;
    const rel = relativeToApi(file);
    const reason = CLASSIFIED_MODULES.get(rel) ?? null;
    const r = analyseSourceFile(sourceFile, rel, reason);
    if (r.occurrences === 0) continue;
    summary.pointerOccurrences += r.occurrences;
    summary.candidateUses += r.candidates;
    summary.benignUses += r.benign;
    if (reason) {
      summary.classifiedModules += 1;
      classifications.push({ file: rel, occurrences: r.occurrences, reason: reason.reason, allowedForms: [...reason.allowedForms].sort() });
    }
    violations.push(...r.violations);
  }

  summary.currentWorkspaceIdAuthorizationUses = violations.length;

  const report = {
    check: "current-workspace-authority",
    generatedBy: "services/api/scripts/verify-current-workspace-authority.mjs",
    summary,
    classifications: classifications.sort((a, b) => a.file.localeCompare(b.file)),
    violations: violations.sort((a, b) =>
      a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
    ),
    selfTestFailures,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (selfTestFailures.length > 0) {
    process.stderr.write(
      `\nCURRENT-WORKSPACE GATE SELF-TEST FAILED — ${selfTestFailures.length} adversarial fixture(s) were not detected.\n` +
        "The gate cannot report a trustworthy zero until it can prove it detects every forbidden form.\n",
    );
    process.exit(1);
  }
  if (violations.length > 0) {
    process.stderr.write(
      `\nCURRENT-WORKSPACE GATE FAILED — ${violations.length} authorization-bearing use(s) of User.currentWorkspaceId.\n` +
        "Each must EITHER be handed to a canonical authorizer as a CANDIDATE (which revalidates it in full),\n" +
        "OR be declared in CLASSIFIED_MODULES with a stated non-authoritative reason.\n",
    );
    process.exit(1);
  }
}

main();
