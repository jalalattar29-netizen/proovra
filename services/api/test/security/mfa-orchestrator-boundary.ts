/**
 * PHASE 13 (NEW-058) — THE MFA ORCHESTRATOR BOUNDARY, ASSERTED DIRECTLY.
 *
 * WHAT THIS REPLACES AND WHY
 * ---------------------------------------------------------------------------
 * `phase-r8-1-1-mfa-orchestrator.test.ts` pinned the BYTE SIZE of
 * `identity-security.routes.ts`. That pin was a proxy for a real architectural
 * rule — "this file is an orchestrator; the rules live in services" — and it is
 * a bad proxy in both directions. It fires on growth that STRENGTHENS
 * enforcement, and it stays silent when someone adds a parallel MFA authority
 * while deleting an equal number of bytes somewhere else. The file's own
 * comment already admitted this and kept the pin "as a secondary drift
 * detector"; what was missing was the primary check.
 *
 * This module is that primary check. It is a PURE function over source text, so
 * the adversarial suite can hand it a deliberately-violating tree and assert it
 * refuses — a gate whose only evidence is that it passed once has not been
 * shown to be capable of failing.
 *
 * HOW IT DECIDES
 * ---------------------------------------------------------------------------
 * By AST, never by a character window. NEW-047 was exactly this defect: two
 * verifiers decided authority by matching across fixed character windows, so a
 * comment pushed a re-export past 400 characters and a 940-line RBAC authority
 * read as unreachable. Routes are identified by the PATH they register, not by
 * the name of the variable holding their schema, so renaming `StartBody` proves
 * nothing and cannot evade the check.
 *
 * THE FOUR INVARIANTS
 * ---------------------------------------------------------------------------
 *   CallerSuppliedDestination   A step-up request body may not carry a
 *                               destination. This is NEW-058 itself: the old
 *                               body took the handset from the caller, so an
 *                               approved challenge proved possession of a phone
 *                               the ATTACKER chose. Only the enrolment-start
 *                               route may name a destination, and only because
 *                               that is what enrolment means.
 *
 *   ParallelMfaAuthorities      No ROUTE file may write `mfa_factors`. The
 *                               factor lifecycle belongs to its services; a
 *                               handler that writes the table directly is a
 *                               second authority over what "verified" means.
 *
 *   EnrollmentHandlersCanonical Every enrolment handler delegates to the
 *                               canonical factor service, touches no database
 *                               client, and resolves no destination itself.
 *
 *   StepUpAuthorityIntact       The step-up route file neither approves nor
 *                               consumes a challenge (the pre-existing
 *                               invariant, carried forward unchanged).
 */

import ts from "typescript";

// ===========================================================================
// Inputs
// ===========================================================================

export type BoundarySources = {
  /** repo-relative path -> source text, for every API route module. */
  routeFiles: Record<string, string>;
  /** repo-relative path -> source text, for every non-route API source file. */
  serviceFiles: Record<string, string>;
  /**
   * The route path at which an account acquires a factor. This is the ONE
   * step-up-bearing request permitted to carry a destination, and it is named
   * here rather than inferred so that adding a second such route is a visible
   * edit to this contract rather than a silent widening.
   */
  enrollmentStartPath: string;
  /**
   * Functions that constitute the step-up / contact-factor authority. A handler
   * that calls one of these is IN SCOPE for the destination rule, wherever it
   * lives.
   *
   * Scoping by BEHAVIOUR rather than by path is deliberate. A path prefix would
   * be evaded by registering the same capability somewhere else, and it would
   * also mis-fire: `/v1/communications/verify/start` legitimately takes a phone
   * because it IS the generic verification primitive, and a `to` field on a
   * `/transition` route is a target STATE, not a handset. Neither touches the
   * step-up authority, so neither is in scope.
   */
  stepUpAuthorityFunctions: readonly string[];
  /** Module specifier suffix of the canonical contact-factor authority. */
  factorServiceSpecifier: string;
  /**
   * Non-route modules permitted to write `mfa_factors`. Route files are never
   * permitted, whatever this list says.
   */
  sanctionedFactorWriters: readonly string[];
  /** The step-up route module, by repo-relative path. */
  stepUpRoutePath: string;
  /** The contact-factor enrolment route module, by repo-relative path. */
  enrollmentRoutePath: string;
};

export type BoundaryReport = {
  problems: string[];
  callerSuppliedDestination: number;
  parallelMfaAuthorities: number;
  enrollmentHandlersCanonical: boolean;
  stepUpAuthorityIntact: boolean;
};

// ===========================================================================
// Vocabulary
// ===========================================================================

/**
 * Field names that name a place a code can be SENT. The point of NEW-058 is
 * that none of them may appear in a step-up request, so the list is deliberately
 * broader than the field that actually existed: renaming `phone` to `to` must
 * not launder the defect back in.
 */
const DESTINATION_KEYS: ReadonlySet<string> = new Set([
  "phone",
  "phoneNumber",
  "phoneE164",
  "phoneE164OrRaw",
  "destination",
  "destinationE164",
  "destinationRaw",
  "recipient",
  "recipientPhone",
  "msisdn",
  "handset",
  "number",
  "to",
]);

/** Prisma write methods. A read never establishes an authority. */
const WRITE_METHODS: ReadonlySet<string> = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);

/**
 * The primitives that TURN A STRING INTO A DESTINATION. A route calling any of
 * them is resolving a destination itself, which is the thing the factor service
 * exists to be the only place for.
 */
const DESTINATION_PRIMITIVES: ReadonlySet<string> = new Set([
  "normaliseToE164",
  "normalizeToE164",
  "maskPhonePreview",
  "hashRecipientPhone",
  "sealSecret",
  "openSecret",
]);

/** Database client identifiers. An enrolment handler may touch none of them. */
const DB_CLIENTS: ReadonlySet<string> = new Set(["prisma", "db", "tx"]);

const HTTP_METHODS: ReadonlySet<string> = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
]);

// ===========================================================================
// AST helpers
// ===========================================================================

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** `a.b.c` -> "a.b.c"; anything computed or non-trivial -> null. */
function dottedName(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const left = dottedName(node.expression);
    return left === null ? null : `${left}.${node.name.text}`;
  }
  return null;
}

/** Strips `.strict()`, `.partial()`, … back to the `z.object({...})` call. */
function unwrapToZodObject(expr: ts.Expression): ts.ObjectLiteralExpression | null {
  let cur: ts.Expression = expr;
  for (let depth = 0; depth < 12; depth += 1) {
    if (!ts.isCallExpression(cur)) return null;
    const callee = dottedName(cur.expression);
    if (callee === "z.object" || callee?.endsWith(".object")) {
      const arg = cur.arguments[0];
      return arg && ts.isObjectLiteralExpression(arg) ? arg : null;
    }
    if (!ts.isPropertyAccessExpression(cur.expression)) return null;
    cur = cur.expression.expression;
  }
  return null;
}

function objectKeys(obj: ts.ObjectLiteralExpression): string[] {
  const out: string[] = [];
  for (const prop of obj.properties) {
    const name = prop.name;
    if (!name) continue;
    if (ts.isIdentifier(name)) out.push(name.text);
    else if (ts.isStringLiteral(name)) out.push(name.text);
  }
  return out;
}

type RouteRegistration = {
  method: string;
  path: string;
  handler: ts.Node | null;
  node: ts.CallExpression;
};

/** Every `app.<method>("<literal path>", …)` in a source file. */
function routeRegistrations(sf: ts.SourceFile): RouteRegistration[] {
  const out: RouteRegistration[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const callee = n.expression;
    // Tolerate `app.delete<Params>(…)` — the generic wraps the callee.
    if (ts.isPropertyAccessExpression(callee) === false) return;
    const access = callee as ts.PropertyAccessExpression;
    const method = access.name.text;
    if (!HTTP_METHODS.has(method)) return;
    const first = n.arguments[0];
    if (!first || !ts.isStringLiteral(first)) return;
    const handler = n.arguments.find(
      (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
    );
    out.push({ method, path: first.text, handler: handler ?? null, node: n });
  });
  return out;
}

/** `const Name = z.object({...}).strict()` declarations, by local name. */
function zodSchemaDeclarations(
  sf: ts.SourceFile,
): Map<string, ts.ObjectLiteralExpression> {
  const out = new Map<string, ts.ObjectLiteralExpression>();
  walk(sf, (n) => {
    if (!ts.isVariableDeclaration(n)) return;
    if (!ts.isIdentifier(n.name) || !n.initializer) return;
    const obj = unwrapToZodObject(n.initializer);
    if (obj) out.set(n.name.text, obj);
  });
  return out;
}

/**
 * Schema names a handler parses its REQUEST BODY with.
 *
 * Only `.parse`/`.safeParse` applied to something reading `req.body` counts:
 * a schema used for a query string or for a response projection is not a
 * request body and must not be judged as one.
 */
function bodySchemasParsedIn(handler: ts.Node): string[] {
  const out: string[] = [];
  walk(handler, (n) => {
    if (!ts.isCallExpression(n)) return;
    if (!ts.isPropertyAccessExpression(n.expression)) return;
    const method = n.expression.name.text;
    if (method !== "parse" && method !== "safeParse") return;
    const target = dottedName(n.expression.expression);
    if (!target) return;
    const argText = n.arguments[0] ? n.arguments[0].getText() : "";
    if (!/\breq(uest)?\.body\b/.test(argText)) return;
    out.push(target);
  });
  return out;
}

/** Local names imported from a module whose specifier ends with `suffix`. */
function importedFrom(sf: ts.SourceFile, suffix: string): Set<string> {
  const out = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!stmt.moduleSpecifier.text.includes(suffix)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) out.add(el.name.text);
    }
  }
  return out;
}

/** Prisma-model write calls: `<anything>.<model>.<writeMethod>(…)`. */
function modelWrites(sf: ts.SourceFile, model: string): string[] {
  const out: string[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    if (!ts.isPropertyAccessExpression(n.expression)) return;
    const method = n.expression.name.text;
    if (!WRITE_METHODS.has(method)) return;
    const owner = n.expression.expression;
    if (!ts.isPropertyAccessExpression(owner)) return;
    if (owner.name.text !== model) return;
    out.push(`${model}.${method}`);
  });
  return out;
}

/** Identifiers called as functions anywhere under `node`. */
function calledNames(node: ts.Node): Set<string> {
  const out = new Set<string>();
  walk(node, (n) => {
    if (!ts.isCallExpression(n)) return;
    if (ts.isIdentifier(n.expression)) out.add(n.expression.text);
    else if (ts.isPropertyAccessExpression(n.expression)) {
      const root = dottedName(n.expression);
      if (root) out.add(root);
    }
  });
  return out;
}

// ===========================================================================
// The evaluator
// ===========================================================================

export function mfaOrchestratorBoundary(src: BoundarySources): BoundaryReport {
  const problems: string[] = [];

  // -------------------------------------------------------- destination ---
  // A step-up-bearing request may not carry a destination. Scope is decided by
  // what the handler CALLS, so moving the route changes nothing; the schema is
  // found through the variable the handler parses `req.body` with, so renaming
  // it changes nothing either.
  const authority = new Set(src.stepUpAuthorityFunctions);
  let callerSuppliedDestination = 0;
  for (const [path, text] of Object.entries(src.routeFiles)) {
    const sf = parse(path, text);
    const schemas = zodSchemaDeclarations(sf);
    for (const route of routeRegistrations(sf)) {
      if (!route.handler) continue;
      if (route.path === src.enrollmentStartPath) continue; // enrolment IS the input
      const called = calledNames(route.handler);
      if (![...authority].some((fn) => called.has(fn))) continue;
      for (const schemaName of bodySchemasParsedIn(route.handler)) {
        const obj = schemas.get(schemaName);
        if (!obj) continue;
        for (const key of objectKeys(obj)) {
          if (!DESTINATION_KEYS.has(key)) continue;
          callerSuppliedDestination += 1;
          problems.push(
            `CallerSuppliedDestination: ${path} route ${route.method.toUpperCase()} ${route.path} accepts a caller-supplied destination field \`${key}\``,
          );
        }
      }
    }
  }

  // --------------------------------------------------- parallel authority ---
  // No route file writes mfa_factors, ever. Non-route writers must be on the
  // sanctioned list.
  let parallelMfaAuthorities = 0;
  for (const [path, text] of Object.entries(src.routeFiles)) {
    const writes = modelWrites(parse(path, text), "mfaFactor");
    if (writes.length === 0) continue;
    parallelMfaAuthorities += 1;
    problems.push(
      `ParallelMfaAuthorities: route module ${path} writes mfa_factors directly (${[...new Set(writes)].join(", ")}); the factor lifecycle belongs to its service`,
    );
  }
  for (const [path, text] of Object.entries(src.serviceFiles)) {
    const writes = modelWrites(parse(path, text), "mfaFactor");
    if (writes.length === 0) continue;
    if (src.sanctionedFactorWriters.includes(path)) continue;
    parallelMfaAuthorities += 1;
    problems.push(
      `ParallelMfaAuthorities: ${path} writes mfa_factors and is not a sanctioned factor authority`,
    );
  }

  // ------------------------------------------------- enrolment canonical ---
  let enrollmentHandlersCanonical = true;
  const enrollSrc = src.routeFiles[src.enrollmentRoutePath];
  if (enrollSrc === undefined) {
    enrollmentHandlersCanonical = false;
    problems.push(
      `EnrollmentHandlersCanonical: the enrolment route module ${src.enrollmentRoutePath} is absent`,
    );
  } else {
    const sf = parse(src.enrollmentRoutePath, enrollSrc);
    const canonical = importedFrom(sf, src.factorServiceSpecifier);
    if (canonical.size === 0) {
      enrollmentHandlersCanonical = false;
      problems.push(
        `EnrollmentHandlersCanonical: ${src.enrollmentRoutePath} imports nothing from the canonical factor service`,
      );
    }
    const routes = routeRegistrations(sf);
    if (routes.length === 0) {
      enrollmentHandlersCanonical = false;
      problems.push(
        `EnrollmentHandlersCanonical: ${src.enrollmentRoutePath} registers no routes`,
      );
    }
    for (const route of routes) {
      if (!route.handler) continue;
      const called = calledNames(route.handler);

      // 1. It delegates.
      if (![...canonical].some((name) => called.has(name))) {
        enrollmentHandlersCanonical = false;
        problems.push(
          `EnrollmentHandlersCanonical: ${route.method.toUpperCase()} ${route.path} calls no function of the canonical factor service`,
        );
      }
      // 2. It resolves no destination itself.
      for (const primitive of DESTINATION_PRIMITIVES) {
        if (!called.has(primitive)) continue;
        enrollmentHandlersCanonical = false;
        problems.push(
          `EnrollmentHandlersCanonical: ${route.method.toUpperCase()} ${route.path} resolves a destination inline via \`${primitive}\``,
        );
      }
      // 3. It touches no database client.
      for (const name of called) {
        const root = name.split(".")[0]!;
        if (!DB_CLIENTS.has(root) || !name.includes(".")) continue;
        enrollmentHandlersCanonical = false;
        problems.push(
          `EnrollmentHandlersCanonical: ${route.method.toUpperCase()} ${route.path} reaches the database directly via \`${name}\`; business logic belongs in the factor service`,
        );
      }
    }
  }

  // --------------------------------------------------- step-up authority ---
  // Carried forward unchanged: this file may never approve or consume a
  // challenge, and its only permitted challenge write is the PENDING -> EXPIRED
  // TTL sweep, which can never grant elevation.
  let stepUpAuthorityIntact = true;
  const stepUpSrc = src.routeFiles[src.stepUpRoutePath];
  if (stepUpSrc === undefined) {
    stepUpAuthorityIntact = false;
    problems.push(
      `StepUpAuthorityIntact: the step-up route module ${src.stepUpRoutePath} is absent`,
    );
  } else {
    const sf = parse(src.stepUpRoutePath, stepUpSrc);
    const called = calledNames(sf);
    if (called.has("consumeApprovedChallenge")) {
      stepUpAuthorityIntact = false;
      problems.push(
        `StepUpAuthorityIntact: ${src.stepUpRoutePath} consumes an approved challenge itself`,
      );
    }
    const writes = modelWrites(sf, "stepUpChallenge");
    const disallowed = writes.filter((w) => w !== "stepUpChallenge.updateMany");
    if (disallowed.length > 0) {
      stepUpAuthorityIntact = false;
      problems.push(
        `StepUpAuthorityIntact: ${src.stepUpRoutePath} performs challenge writes beyond the TTL sweep (${[...new Set(disallowed)].join(", ")})`,
      );
    }
    for (const marker of ["APPROVED", "CANCELLED"]) {
      if (!new RegExp(`StepUpChallengeStatus\\.${marker}`).test(stepUpSrc)) continue;
      stepUpAuthorityIntact = false;
      problems.push(
        `StepUpAuthorityIntact: ${src.stepUpRoutePath} writes StepUpChallengeStatus.${marker}`,
      );
    }
  }

  return {
    problems,
    callerSuppliedDestination,
    parallelMfaAuthorities,
    enrollmentHandlersCanonical,
    stepUpAuthorityIntact,
  };
}
