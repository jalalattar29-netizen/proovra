#!/usr/bin/env node
/**
 * PHASE 12 REMEDIATION — AUTH-004 (2026-08-06).
 *
 * LIVE static authorization-authority verifier.
 *
 * What it replaces
 * ----------------
 * `services/api/src/services/identity/authorization-allowlist.ts` declared
 * itself "the canonical authorization exception registry + migration ledger"
 * whose PENDING list must be empty for Phase 1 to be done. Its PENDING list
 * WAS empty — and simultaneously `intelligence.routes.ts`,
 * `me-inbox.routes.ts` and `external-portal.routes.ts` all carried
 * status-blind gates and appeared nowhere in it. The file additionally had
 * ZERO production importers, so nothing enforced it anywhere. It was a
 * FICTIONAL CONTROL: a governance artifact that recorded a conclusion
 * without ever computing it.
 *
 * What this does instead
 * ----------------------
 * It COMPUTES the conclusion, from the real source, every time it runs:
 *
 *   1. Discovers route modules from ACTUAL PRODUCTION REGISTRATION — it
 *      parses `src/server.ts` for `app.register(<x>)` and resolves each
 *      registered symbol back to the module that defines it. A route file
 *      nobody registers is not a production authority and is not judged as
 *      one; a newly registered file is judged automatically, with no ledger
 *      to remember to update.
 *
 *   2. Walks the TypeScript AST of every reachable production module and
 *      finds each `*.teamMember.find*` / `*.teamMember.count` call —
 *      SEMANTICALLY, as call expressions on a `teamMember` property access,
 *      not by matching text. Comments, strings and doc blocks that merely
 *      mention `teamMember` are invisible to it, which is precisely the
 *      false-positive class the audit hit when scanning with a regex.
 *
 *   3. Classifies each call by reading its own `where` argument and its
 *      enclosing function:
 *
 *        STATUS_SCOPED   — the query itself constrains `status`, so an
 *                          inactive row cannot be returned.
 *        STATUS_CHECKED  — the enclosing function tests the loaded row's
 *                          status through the canonical predicate
 *                          (`teamMemberStatusGrantsAccess`) or an explicit
 *                          comparison against ACTIVE.
 *        CANONICAL       — the enclosing function reaches the canonical
 *                          primitive (`authorizeOrFail`,
 *                          `requireAuthorize`, `authorizeWorkspaceOrFail`,
 *                          `authorizeCurrentWorkspaceOrFail`,
 *                          `evaluateAuthorizedWorkspace`,
 *                          `evaluateMemberAccess`,
 *                          `loadMemberAccessSnapshot`) and consumes its
 *                          decision.
 *        CLASSIFIED      — the module is declared in CLASSIFIED_MODULES
 *                          below with a stated reason (target/subject
 *                          validation, platform-admin console, token-scoped,
 *                          service/cron, system bootstrap, or the canonical
 *                          authorization modules themselves).
 *        VIOLATION       — none of the above: a direct TeamMember read whose
 *                          result can reach an authorization decision with
 *                          nothing proving the membership is live.
 *
 *   4. Exits NON-ZERO on any VIOLATION, printing file, line and the reason
 *      it could not be classified.
 *
 * Where it runs
 * -------------
 * `pnpm --filter proovra-api verify:authorization` — an ARCHITECTURE /
 * DEPLOYMENT-READINESS command. It is deliberately NOT in the request path:
 * a static property of the source belongs in the build, not in every HTTP
 * request. It is also deliberately not a unit test asserting on regexes over
 * source text — the audit's own finding is that source-shaped assertions
 * mistake vocabulary for behaviour.
 *
 * Bounded output. No secrets, no URLs, no row data — file paths and line
 * numbers only.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(HERE, "..");
const SRC_ROOT = path.join(API_ROOT, "src");
const SERVER_TS = path.join(SRC_ROOT, "server.ts");

// ---------------------------------------------------------------------------
// The canonical vocabulary. Changing these names is a deliberate act; the
// verifier is the thing that notices when a gate stops using them.
// ---------------------------------------------------------------------------

/** Calls that constitute reaching the canonical authorization authority. */
const CANONICAL_AUTHORIZERS = new Set([
  "authorizeOrFail",
  "requireAuthorize",
  "evaluateAuthorize",
  "authorizeWorkspaceOrFail",
  "authorizeCurrentWorkspaceOrFail",
  "evaluateAuthorizedWorkspace",
  "evaluateMemberAccess",
  "loadMemberAccessSnapshot",
  "evaluateAccess",
  // The canonical accessible-workspace resolver (AUTH-002) is an
  // enumeration authority built on the same predicate + classifier.
  "listAccessibleWorkspaces",
  "resolveAccessibleWorkspace",
]);

/** The canonical membership-status predicate. */
const STATUS_PREDICATES = new Set([
  "teamMemberStatusGrantsAccess",
  "isActiveTeamMemberStatus",
]);

// ---------------------------------------------------------------------------
// CORRECTIVE PASS (2026-08-06) — BRAND FORGERY ENFORCEMENT.
//
// `AuthorizedWorkspaceContext` carries a `unique symbol` brand so a plain
// object literal cannot satisfy the type. The previous pass claimed that made
// it "unforgeable". THAT CLAIM WAS OVERSTATED, and the corrective mandate is
// right to challenge it: TypeScript's `as` assertion defeats a brand
// completely. Any module could write
//
//     const ctx = { workspaceId: victimId, … } as AuthorizedWorkspaceContext;
//
// and every downstream reader — which scopes its queries by `ctx.workspaceId`
// — would trust it. The brand stops ACCIDENTAL structural construction; it
// does nothing about a deliberate assertion.
//
// A type cannot enforce this, so the BUILD does. The only legitimate place to
// assert this type is the constructor inside the authorization authority
// itself. Anywhere else is a forged authorization proof and fails the gate.
//
// This is the difference between a claim and a control, which is the same
// lesson AUTH-004 recorded about `authorization-allowlist.ts`.
// ---------------------------------------------------------------------------

/** Types that may only be asserted inside their owning authority module. */
const BRANDED_AUTHORITY_TYPES = new Set([
  "AuthorizedWorkspaceContext",
  "AuthorizedWorkspaceOutcome",
]);

/** The one module permitted to construct a branded authorization proof. */
const BRAND_CONSTRUCTOR_MODULE = "src/middleware/authorize.ts";

function typeReferenceName(typeNode) {
  if (!typeNode) return null;
  if (ts.isTypeReferenceNode(typeNode)) {
    const n = typeNode.typeName;
    if (ts.isIdentifier(n)) return n.text;
    if (ts.isQualifiedName(n)) return n.right.text;
  }
  return null;
}

/**
 * Collect every assertion / declared-type use that would mint a branded
 * authorization proof outside the owning module.
 */
function findBrandForgeries(sourceFile, relPath) {
  if (relPath === BRAND_CONSTRUCTOR_MODULE) return [];
  const out = [];
  const record = (node, how) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    out.push({ line: line + 1, how });
  };
  const visit = (node) => {
    // `expr as AuthorizedWorkspaceContext` / `<T>expr`
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression?.(node)) {
      const name = typeReferenceName(node.type);
      if (name && BRANDED_AUTHORITY_TYPES.has(name)) {
        record(node, `type assertion to ${name}`);
      }
    }
    // `expr satisfies AuthorizedWorkspaceContext`
    if (ts.isSatisfiesExpression?.(node)) {
      const name = typeReferenceName(node.type);
      if (name && BRANDED_AUTHORITY_TYPES.has(name)) {
        record(node, `satisfies ${name}`);
      }
    }
    // `const ctx: AuthorizedWorkspaceContext = { … }` — an initialised
    // declaration typed as the brand is construction, not consumption.
    if (
      ts.isVariableDeclaration(node) &&
      node.type &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const name = typeReferenceName(node.type);
      if (name && BRANDED_AUTHORITY_TYPES.has(name)) {
        record(node, `object literal declared as ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

const TEAM_MEMBER_READS = new Set([
  "findUnique",
  "findFirst",
  "findMany",
  "findUniqueOrThrow",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);

/**
 * Modules whose direct TeamMember reads are NOT actor-authorization
 * decisions. Every entry states WHY, and the verifier prints the reason
 * alongside the classification so the justification stays visible rather
 * than becoming a silent suppression.
 *
 * This is the ONLY hand-maintained input, and — unlike the registry it
 * replaces — an omission here FAILS the check rather than silently passing
 * it. The default is VIOLATION, not ALLOW.
 */
const CLASSIFIED_MODULES = new Map([
  [
    "src/middleware/authorize.ts",
    "CANONICAL AUTHORITY — this module IS the primitive.",
  ],
  [
    "src/services/identity/access-policy.service.ts",
    "CANONICAL AUTHORITY — the access-policy engine itself.",
  ],
  [
    "src/services/access/accessible-workspaces.ts",
    "CANONICAL AUTHORITY — the accessible-workspace resolver; enforces the status predicate, access expiry, workspace kind and Organization lifecycle itself.",
  ],
  [
    "src/services/access/current-workspace-pointer.ts",
    "HYGIENE — repairs the navigation pointer at membership-withdrawal boundaries. Makes no access decision.",
  ],
  [
    "src/services/identity/rbac.service.ts",
    "MEMBERSHIP TRANSITION ENGINE — reads the SUBJECT membership row it is about to mutate; the ACTOR is authorized upstream by the orchestrator.",
  ],
  [
    "src/services/identity/membership-provisioning.service.ts",
    "MEMBERSHIP ORCHESTRATOR — provisions and withdraws the SUBJECT's membership; the ACTOR is authorized at the route boundary.",
  ],
  [
    "src/services/access-control/scim.service.ts",
    "ENTERPRISE IDENTITY PROVISIONING — authorized by a SCIM bearer token bound to the workspace, not by workspace membership.",
  ],
  [
    "src/services/access-control/scim-reconciliation.service.ts",
    "ENTERPRISE IDENTITY PROVISIONING — scheduled reconciliation running as the system, not as a member.",
  ],
  [
    "src/services/identity/access-review.service.ts",
    "REVIEW SUBJECT — locates the membership row an access-review decision is about to REVOKE or SUSPEND. Requiring ACTIVE here would make an already-suspended member un-revokable; the transition validity is enforced by the rbac state machine. The ACTOR is authorized at the route boundary.",
  ],
  [
    "src/services/identity-security/session-timeout-policy.service.ts",
    "INFORMATIONAL ROLE READ — derives WHICH session-timeout field applies to a user. Makes no allow/deny decision, and a suspended member's timeout still needs deriving while their session is torn down.",
  ],
]);

// ---------------------------------------------------------------------------
// Step 0 — VALIDATE the declared exception ledger.
//
// `authorization-allowlist.ts` is NO LONGER an authority. It is now DATA
// that this verifier checks, which is the whole difference between a
// governance artifact and a governance control:
//
//   * its PENDING list claims "no known unmigrated status-blind gate
//     remains". This verifier now PROVES or DISPROVES that claim from
//     source, independently, in step 3. The ledger's assertion is checked
//     for internal consistency here (PENDING must be empty), and the real
//     answer comes from the AST walk.
//
//   * its EXCEPTION entries name files. A stale entry — naming a file that
//     no longer exists — is a ledger that has drifted from the system it
//     claims to describe, so it FAILS.
//
// Crucially the ledger CANNOT suppress a finding. Classification lives in
// `CLASSIFIED_MODULES` above, keyed by full path with a stated reason, and
// the default for anything unlisted is VIOLATION. Reading the ledger can
// only ADD failures, never remove them.
// ---------------------------------------------------------------------------

const ALLOWLIST_TS = path.join(
  SRC_ROOT,
  "services",
  "identity",
  "authorization-allowlist.ts",
);

function validateDeclaredLedger(program, allProductionFiles) {
  const problems = [];
  const source = program.getSourceFile(ALLOWLIST_TS);
  if (!source) {
    // The ledger having been deleted outright is acceptable — this verifier
    // is the authority. Nothing to validate.
    return { present: false, exceptionCount: 0, pendingCount: 0, problems };
  }
  const arrays = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      let init = node.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression?.(init)) {
        init = init.expression;
      }
      if (ts.isArrayLiteralExpression(init)) {
        arrays.set(node.name.text, init);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const exceptions = arrays.get("AUTHORIZATION_EXCEPTIONS");
  const pending = arrays.get("PENDING_AUTHORIZATION_MIGRATIONS");
  const pendingCount = pending ? pending.elements.length : 0;
  if (pendingCount > 0) {
    problems.push({
      file: relativeToApi(ALLOWLIST_TS),
      line: 0,
      reason: `Declared ledger still lists ${pendingCount} PENDING authorization migration(s); its own definition of done requires PENDING to be empty.`,
    });
  }

  const basenames = new Set(
    allProductionFiles.map((f) => path.basename(f)),
  );
  let exceptionCount = 0;
  if (exceptions) {
    for (const el of exceptions.elements) {
      if (!ts.isObjectLiteralExpression(el)) continue;
      exceptionCount += 1;
      const fileProp = el.properties.find(
        (p) =>
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          p.name.text === "file",
      );
      if (!fileProp || !ts.isStringLiteral(fileProp.initializer)) continue;
      const declared = fileProp.initializer.text;
      if (!basenames.has(declared)) {
        const { line } = source.getLineAndCharacterOfPosition(
          fileProp.getStart(source),
        );
        problems.push({
          file: relativeToApi(ALLOWLIST_TS),
          line: line + 1,
          reason: `Declared exception names "${declared}", which is not a production source file. The ledger has drifted from the system it describes.`,
        });
      }
    }
  }
  return { present: true, exceptionCount, pendingCount, problems };
}

// ---------------------------------------------------------------------------
// Step 1 — discover production route modules from actual registration.
// ---------------------------------------------------------------------------

function discoverRegisteredRouteModules(program) {
  const serverSource = program.getSourceFile(SERVER_TS);
  if (!serverSource) {
    throw new Error(
      "server.ts is not part of the compiled program — cannot discover route registration.",
    );
  }
  const registered = new Set();

  // Local import bindings: identifier -> resolved module file.
  const importBindings = new Map();
  for (const stmt of serverSource.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const resolved = resolveLocalModule(serverSource.fileName, stmt.moduleSpecifier.text);
    if (!resolved) continue;
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name) importBindings.set(clause.name.text, resolved);
    const named = clause.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) {
        importBindings.set(el.name.text, resolved);
      }
    }
  }

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRegister =
        ts.isPropertyAccessExpression(callee) && callee.name.text === "register";
      if (isRegister && node.arguments.length > 0) {
        const arg = node.arguments[0];
        // `app.register(fooRoutes)`
        if (ts.isIdentifier(arg)) {
          const file = importBindings.get(arg.text);
          if (file) registered.add(file);
        }
        // `app.register((await import("./routes/x.js")).xRoutes)`
        const dynamicSpecifier = findDynamicImportSpecifier(arg);
        if (dynamicSpecifier) {
          const file = resolveLocalModule(serverSource.fileName, dynamicSpecifier);
          if (file) registered.add(file);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(serverSource);
  return registered;
}

function findDynamicImportSpecifier(node) {
  let found = null;
  const visit = (n) => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments.length > 0 &&
      ts.isStringLiteral(n.arguments[0])
    ) {
      found = n.arguments[0].text;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function resolveLocalModule(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    path.join(base, "index.ts"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return path.normalize(c);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step 2/3 — find and classify TeamMember reads.
// ---------------------------------------------------------------------------

function isTeamMemberRead(node) {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const method = callee.name.text;
  if (!TEAM_MEMBER_READS.has(method)) return null;
  const owner = callee.expression;
  if (!ts.isPropertyAccessExpression(owner)) return null;
  if (owner.name.text !== "teamMember") return null;
  return method;
}

/** Does the call's own `where` argument constrain `status`? */
function queryIsStatusScoped(callNode) {
  const arg = callNode.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  let scoped = false;
  const visit = (n) => {
    if (scoped) return;
    if (
      (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
      n.name &&
      ts.isIdentifier(n.name) &&
      n.name.text === "status"
    ) {
      scoped = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(arg);
  return scoped;
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
  return null;
}

/**
 * Does `scope` (a function body, or the whole module when the call sits at
 * module scope) prove membership validity some other way — by testing the
 * canonical status predicate, comparing against ACTIVE, or consuming the
 * canonical authorization primitive?
 */
function scopeProvesValidity(scope) {
  const result = { statusChecked: false, canonical: false };
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name && STATUS_PREDICATES.has(name)) result.statusChecked = true;
      if (name && CANONICAL_AUTHORIZERS.has(name)) result.canonical = true;
    }
    // `x.status === "ACTIVE"` / `x.status !== "ACTIVE"` / an `in [ACTIVE...]`
    // membership test, however the row was spelled.
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      const isEq =
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken;
      if (isEq && mentionsStatus(n.left) && mentionsActive(n.right)) {
        result.statusChecked = true;
      }
      if (isEq && mentionsStatus(n.right) && mentionsActive(n.left)) {
        result.statusChecked = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return result;
}

function mentionsStatus(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "status";
  if (ts.isNonNullExpression(node)) return mentionsStatus(node.expression);
  if (ts.isParenthesizedExpression(node)) return mentionsStatus(node.expression);
  return false;
}

function mentionsActive(node) {
  if (ts.isStringLiteral(node)) return node.text === "ACTIVE";
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "ACTIVE";
  return false;
}

function relativeToApi(file) {
  return path.relative(API_ROOT, file).split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const configPath = path.join(API_ROOT, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, (p) => readFileSync(p, "utf8"));
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    API_ROOT,
  );
  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    noEmit: true,
  });

  const registeredRouteModules = discoverRegisteredRouteModules(program);

  const productionFiles = program
    .getSourceFiles()
    .filter(
      (sf) =>
        !sf.isDeclarationFile &&
        path.normalize(sf.fileName).startsWith(SRC_ROOT + path.sep),
    )
    .map((sf) => path.normalize(sf.fileName));

  const ledger = validateDeclaredLedger(program, productionFiles);

  const findings = [...ledger.problems];
  const summary = {
    modulesScanned: 0,
    registeredRouteModules: registeredRouteModules.size,
    declaredLedgerPresent: ledger.present,
    declaredExceptions: ledger.exceptionCount,
    declaredPending: ledger.pendingCount,
    teamMemberReads: 0,
    statusScoped: 0,
    statusChecked: 0,
    canonical: 0,
    classified: 0,
    brandForgeries: 0,
    violations: ledger.problems.length,
  };

  for (const sourceFile of program.getSourceFiles()) {
    const file = path.normalize(sourceFile.fileName);
    if (sourceFile.isDeclarationFile) continue;
    // PRODUCTION source only. Tests, scripts and generated clients are not
    // production authorities and are out of scope by construction.
    if (!file.startsWith(SRC_ROOT + path.sep)) continue;
    summary.modulesScanned += 1;
    const rel = relativeToApi(file);
    const classification = CLASSIFIED_MODULES.get(rel) ?? null;

    // BRAND FORGERY — an authorization proof minted outside its authority.
    for (const forgery of findBrandForgeries(sourceFile, rel)) {
      summary.brandForgeries += 1;
      summary.violations += 1;
      findings.push({
        file: rel,
        line: forgery.line,
        method: "brand-forgery",
        registeredRoute: registeredRouteModules.has(file),
        reason: `Forged authorization proof: ${forgery.how}. A branded authorization context may only be constructed inside ${BRAND_CONSTRUCTOR_MODULE}; asserting the type elsewhere fabricates authorization that no check produced.`,
      });
    }

    const visit = (node) => {
      const method = isTeamMemberRead(node);
      if (method) {
        summary.teamMemberReads += 1;
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        if (queryIsStatusScoped(node)) {
          summary.statusScoped += 1;
        } else if (classification) {
          summary.classified += 1;
        } else {
          const scope = enclosingFunction(node) ?? sourceFile;
          const proof = scopeProvesValidity(scope);
          if (proof.statusChecked) summary.statusChecked += 1;
          else if (proof.canonical) summary.canonical += 1;
          else {
            summary.violations += 1;
            findings.push({
              file: rel,
              line: line + 1,
              method,
              registeredRoute: registeredRouteModules.has(file),
              reason:
                "Direct TeamMember read with no status predicate in the query, no status check in the enclosing function, no canonical authorization call, and no module classification.",
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const report = {
    check: "authorization-authorities",
    generatedBy: "services/api/scripts/verify-authorization-authorities.mjs",
    summary,
    violations: findings.sort((a, b) =>
      a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
    ),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (findings.length > 0) {
    process.stderr.write(
      `\nAUTHORIZATION AUTHORITY CHECK FAILED — ${findings.length} unclassified direct TeamMember authorization read(s).\n` +
        `Each must EITHER constrain \`status\` in the query, OR check the canonical status predicate, OR route through the canonical\n` +
        `authorization primitive, OR be explicitly classified (with a stated reason) in CLASSIFIED_MODULES.\n`,
    );
    process.exit(1);
  }
}

main();
