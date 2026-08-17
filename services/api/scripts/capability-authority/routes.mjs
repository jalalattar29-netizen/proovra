#!/usr/bin/env node
/**
 * PHASE 12 — CAPABILITY AUTHORITY: ROUTE REGISTRATION AND AUTHORIZATION.
 *
 * Two questions per registered route, both answered from syntax:
 *
 *   1. Is it registered in PRODUCTION? A route inside `if (devAuthEnabled())`
 *      has production registration ZERO. Reporting it as an unwired product
 *      surface is simply false — it is not a surface.
 *
 *   2. What actually guards it? The retired map recorded `authorization: null`
 *      for every route whose guard is called inside the handler body rather
 *      than declared as a `preHandler` — which is how `/v1/notifications/
 *      run-digests` came to look unauthenticated when it demands a cron
 *      secret on its first line. Both positions are read here.
 *
 * HOW AUTHORIZATION IS CLASSIFIED
 * ---------------------------------------------------------------------------
 * NOT by the guard's name. `requireAuth`, `requireApiKey` and
 * `requireIntegrationCronSecret` are all "require…" and mean entirely
 * different things, and a helper can be renamed without changing what it
 * enforces. Instead each guard is followed THROUGH ITS CALL GRAPH until a
 * TERMINAL MARKER is reached — the session cookie, the constant-time cron
 * comparison, the SCIM bearer prefix, the platform-admin lookup. A guard that
 * reaches no marker is AUTHORIZATION_UNRESOLVED and says so, because a
 * confident wrong answer about a security gate is worse than an admitted gap.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { REPO, INTERP, parse, resolvePathExpr, calleeName, calleeObject, normalizePath, expandTemplate } from "./analyzer.mjs";

const require = createRequire(import.meta.url);
/** @type {import("typescript")} */
const ts = require("typescript");

const rel = (abs) => path.relative(REPO, abs).split(path.sep).join("/");
const ROUTES_DIR = "services/api/src/routes";
const API_SRC = "services/api/src";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

/**
 * A REGISTRATION path is what Fastify was told, not what a caller may write.
 *
 * `normalizePath` applies the `/v1/workspaces` -> `/v1/teams` alias, which is
 * exactly right for a CONSUMER: the plugin rewrites the incoming URL before
 * routing, so a caller of the alias really does reach the canonical handler. It
 * is exactly WRONG for a registration. Applying it here silently reported three
 * routes registered at `/v1/workspaces/ai-policy` and `/v1/workspaces/ai-usage`
 * as if they were registered at `/v1/teams/…` — which nothing was. Every request
 * to either spelling 404'd, and the map said the routes existed and were called.
 *
 * So registrations are recorded verbatim (minus query/trailing slash), and a
 * registration under the alias prefix is UNREACHABLE by construction — reported,
 * not normalized away.
 */
export function registrationPath(raw) {
  let p = String(raw).split("?")[0].split("#")[0];
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

const ALIAS_REGISTRATION_PREFIX = "/v1/workspaces";

export function isUnreachableAliasRegistration(routePath) {
  return routePath === ALIAS_REGISTRATION_PREFIX || routePath.startsWith(`${ALIAS_REGISTRATION_PREFIX}/`);
}

// ===========================================================================
// TERMINAL AUTHORIZATION MARKERS.
//
// Each is a fact about the IMPLEMENTATION — a header constant it compares, a
// primitive it delegates to, a cookie it reads. Reaching one is what licenses
// a classification; a name never is.
// ===========================================================================

const TERMINAL_MARKERS = Object.freeze([
  {
    class: "CRON_SECRET",
    why: "reaches the constant-time cron/integration shared-secret comparison",
    // `cronSecretMatches` / `constantTimeEqual` are the FINAL-003 canonical
    // primitive that `checkCronSecret` and the two reconcile entrypoints now
    // share. The marker is the comparison, not the wrapper that calls it.
    identifiers: ["checkCronSecret", "cronSecretMatches", "constantTimeEqual"],
    strings: ["x-proovra-cron-secret", "x-proovra-integration-cron-secret", "x-internal-secret"],
  },
  {
    class: "SCIM_BEARER",
    why: "reaches the SCIM personal-access-token authority (RFC 7644 bearer)",
    identifiers: ["resolveScimToken", "requireScimAuth", "authenticateScim"],
    strings: ["scim_pat_", 'Bearer realm="scim"'],
  },
  {
    class: "API_KEY_SCOPED",
    why: "reaches the integration API-key/scope authority",
    identifiers: ["requireApiKey", "requireApiScope", "resolveApiKey"],
    strings: [],
  },
  {
    class: "WEBHOOK_SIGNATURE",
    why: "reaches an inbound provider signature verifier",
    // `verifyPayPalWebhook` calls PayPal's verification API and
    // `auditWebhookSignatureVerification` exists for no purpose other than
    // running a signature verifier under audit — POST /paypal has no preHandler
    // and no header string this table already knew, so it read as UNGUARDED
    // while in fact refusing anything PayPal has not signed.
    identifiers: [
      "verifyWebhookSignature",
      "constructEvent",
      "verifySignature",
      "verifyPayPalWebhook",
      "auditWebhookSignatureVerification",
    ],
    strings: ["stripe-signature", "x-hub-signature-256", "svix-signature"],
  },
  {
    class: "DEVELOPMENT_ONLY",
    why: "reaches the production-sacred test bypass gate (NODE_ENV=production returns false unconditionally)",
    // `shouldBypassAuthRateLimit` is three layers: production always false, a
    // 32-character minimum secret, and a constant-time header compare. A route
    // whose handler returns 404 unless it passes is not a production surface.
    identifiers: ["shouldBypassAuthRateLimit", "shouldBypassAuth"],
    strings: [],
  },
  {
    class: "INTERNAL_SERVICE",
    why: "reaches the internal service-token authority",
    identifiers: ["requireInternalServiceAuth"],
    strings: ["x-internal-service-token"],
  },
  {
    class: "ADMIN_GATED",
    why: "reaches the platform-administrator lookup",
    identifiers: ["isPlatformAdmin"],
    strings: [],
  },
  {
    class: "ORGANIZATION_GATED",
    why: "reaches the canonical organization access evaluator (org lifecycle + ACTIVE org membership + role precedence + contract expiry)",
    // `checkOrgAccess` is a PEER of `authorizeOrFail`, not a lesser check: it
    // refuses an ARCHIVED or SUSPENDED organization outright, hands the
    // membership status to `organizationMembershipGrantsAccess` (the one
    // predicate that decides which statuses grant anything), and expires a
    // contract-bounded membership. It was absent from this table, so all 42
    // `/v1/orgs/*` routes classified as merely AUTHENTICATED and the report
    // showed an organization product with zero organization-authorized routes.
    identifiers: [
      "checkOrgAccess",
      "requireOrgAccess",
      "assertOrgAccess",
      "organizationMembershipGrantsAccess",
    ],
    strings: [],
  },
  {
    class: "CAPABILITY_GATED",
    why: "reaches the canonical authorization evaluator",
    identifiers: [
      "authorizeOrFail",
      "evaluateAuthorize",
      "requireAuthorize",
      "requireLiveAuthorizedWorkspaceContext",
      "authorizeWithEmergencyOverlay",
      "requireDelegatedTier",
      "requireDelegatedTierAny",
    ],
    strings: [],
  },
  {
    class: "PORTAL_TOKEN",
    why: "reaches the external-review portal grant/session authority",
    identifiers: [
      "resolvePortalSession",
      "resolvePortalGrant",
      "requirePortalToken",
      "resolveExternalReviewGrant",
      // The two token authorities the external-review surface actually uses.
      // Both perform the lookup AND the anti-enumeration refusal, so reaching
      // either is the authorization decision, not a step before it.
      "establishPortalSession",
      "lookupExternalReviewGrantByToken",
    ],
    strings: [],
  },
  {
    class: "INVITATION_TOKEN",
    why: "reaches the invitation/intake token authority",
    identifiers: [
      "resolveIntakeToken",
      "resolveInvitationToken",
      "resolveExternalIntakeLink",
      "validateIntakeToken",
    ],
    strings: [],
  },
  {
    class: "AUTHENTICATED",
    why: "reaches the session-cookie / bearer-JWT resolution",
    identifiers: [],
    strings: ["proovra_session", "AUTH_JWT_SECRET"],
  },
]);

// ===========================================================================
// Function index over the API source, so a guard can be followed to its body.
// ===========================================================================

function walkFiles(root, out = []) {
  const absRoot = path.isAbsolute(root) ? root : path.join(REPO, root);
  if (!existsSync(absRoot)) return out;
  const stack = [absRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  }
  return out;
}

export function indexApiFunctions() {
  /** @type {Map<string, Array<{file:string,node:any}>>} */
  const byName = new Map();
  const sources = new Map();
  for (const abs of walkFiles(API_SRC)) {
    const file = rel(abs);
    if (/\.(test|spec)\.tsx?$/.test(file)) continue;
    const sf = parse(file, readFileSync(abs, "utf8"));
    sources.set(file, sf);
    const visit = (node) => {
      let name = null;
      if (ts.isFunctionDeclaration(node) && node.name) name = node.name.text;
      else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        name = node.name.text;
      }
      if (name !== null) {
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push({ file, node });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { byName, sources };
}

/** Every identifier and string literal appearing anywhere inside a node. */
function surfaceOf(node) {
  const identifiers = new Set();
  const strings = new Set();
  const visit = (n) => {
    if (ts.isIdentifier(n)) identifiers.add(n.text);
    else if (ts.isStringLiteralLike(n)) strings.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return { identifiers, strings };
}

/**
 * Follow `guardName` through the call graph, collecting terminal markers.
 *
 * Depth-bounded: the graph is followed far enough to pass through the two
 * indirection layers this codebase actually uses (`requirePlatformAdmin` ->
 * `requireAuth` -> session cookie; `requireIntegrationCronSecret` ->
 * `checkCronSecret` -> constant-time compare) without walking into unrelated
 * business logic that a deeper search would reach.
 */
export function classifyGuard(guardName, index, depth = 4, seen = new Set()) {
  const found = new Map();
  followName(guardName, depth, index, seen, found);
  return found;
}

/** Terminal markers reachable from an arbitrary AST node (e.g. a handler body). */
export function collectMarkers(node, index, depth, seen = new Set()) {
  const found = new Map();
  markersOn(node, "handler", found);
  const visitCalls = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = calleeName(n);
      if (callee) followName(callee, depth - 1, index, seen, found);
    }
    ts.forEachChild(n, visitCalls);
  };
  visitCalls(node);
  return found;
}

function markersOn(node, where, found) {
  const { identifiers, strings } = surfaceOf(node);
  for (const marker of TERMINAL_MARKERS) {
    const hitId = marker.identifiers.find((i) => identifiers.has(i));
    const hitStr = marker.strings.find((s) => strings.has(s));
    if ((hitId || hitStr) && !found.has(marker.class)) {
      found.set(marker.class, `${where}: ${marker.why} (${hitId ?? `"${hitStr}"`})`);
    }
  }
}

function followName(name, depth, index, seen, found) {
  if (depth < 0 || seen.has(name)) return;
  seen.add(name);
  const decls = index.byName.get(name);
  if (!decls) return;
  for (const { file, node } of decls) {
    markersOn(node, file, found);
    const visitCalls = (n) => {
      if (ts.isCallExpression(n)) {
        const callee = calleeName(n);
        if (callee && callee !== name) followName(callee, depth - 1, index, seen, found);
      }
      ts.forEachChild(n, visitCalls);
    };
    visitCalls(node);
  }
}

// ===========================================================================
// ROUTE EXTRACTION
// ===========================================================================

/** True when `node` sits inside the THEN branch of `if (devAuthEnabled())`. */
function insideDevGate(node) {
  let cur = node;
  while (cur.parent) {
    const parent = cur.parent;
    if (ts.isIfStatement(parent) && parent.thenStatement === cur) {
      const cond = parent.expression.getText();
      if (/devAuthEnabled\s*\(\s*\)/.test(cond)) return true;
    }
    cur = parent;
  }
  return false;
}

/**
 * Guard names named in a route's options object (`preHandler`), incl. arrays.
 *
 * The options argument is not always an inline object. `analytics.routes.ts`
 * writes `const ADMIN_PRE = { preHandler: requirePlatformAdmin }` once and
 * passes the IDENTIFIER to eleven routes. Reading only inline literals made
 * every one of those look unguarded — an analyzer bug that presents as a
 * five-alarm security finding, which is the most expensive kind of wrong
 * answer. So an identifier is resolved to its constant object first.
 */
function preHandlerNames(optionsNode, objectConsts, valueConsts) {
  const names = [];
  if (optionsNode && ts.isIdentifier(optionsNode) && objectConsts?.has(optionsNode.text)) {
    optionsNode = objectConsts.get(optionsNode.text);
  }
  if (!optionsNode || !ts.isObjectLiteralExpression(optionsNode)) return names;

  const seen = new Set();
  const collect = (n) => {
    if (n === undefined || n === null) return;
    if (ts.isIdentifier(n)) {
      // The guard list is frequently hoisted:
      //     const preHandler = [requireAuth, requireLegalAcceptance];
      //     app.get(path, { preHandler }, handler)
      // Recording the identifier `preHandler` instead of following it to the
      // array loses BOTH guards, which is how seven organization bulk-invite
      // and member/seat CSV routes came to look completely unauthenticated.
      if (valueConsts?.has(n.text) && !seen.has(n.text)) {
        seen.add(n.text);
        collect(valueConsts.get(n.text));
        return;
      }
      names.push(n.text);
      return;
    }
    if (ts.isArrayLiteralExpression(n)) {
      n.elements.forEach(collect);
      return;
    }
    if (ts.isCallExpression(n)) {
      // `requireDelegatedTier("x")` — the FACTORY is the guard.
      const cn = calleeName(n);
      if (cn) names.push(cn);
      return;
    }
    ts.forEachChild(n, collect);
  };

  for (const prop of optionsNode.properties) {
    const key =
      prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : null;
    if (key !== "preHandler" && key !== "onRequest") continue;
    // `{ preHandler }` is a SHORTHAND assignment — a different node kind with
    // no `.initializer` at all. Handling only PropertyAssignment silently
    // skips every route written in the shorthand style.
    if (ts.isShorthandPropertyAssignment(prop)) collect(prop.name);
    else if (ts.isPropertyAssignment(prop)) collect(prop.initializer);
  }
  return names;
}

/**
 * The handler declared INSIDE a route-options object.
 *
 * Fastify accepts the handler in either position:
 *
 *     app.get(path, { preHandler }, handler)          // third argument
 *     app.get(path, { preHandler, handler })          // inside the options
 *
 * Reading only the argument position made the second form report
 * `handler = undefined`, and every downstream fact derived from the handler —
 * in-handler guard detection, handler-body terminal markers, and the whole
 * tenancy walk — silently became "not statically extractable". That is how 32
 * `/v1/collaboration-teams/*` routes came to be reported as tenant-UNRESOLVED
 * while their first handler line resolves an ACTIVE workspace membership.
 *
 * Generic on purpose: it accepts the property assignment, the `{ handler }`
 * shorthand, and the `async handler(req, reply) {}` method form, and it
 * resolves an options IDENTIFIER to its constant object first, exactly as
 * `preHandlerNames` does. No route-specific exception exists anywhere in it.
 */
function handlerFromOptions(optionsNode, objectConsts) {
  let o = optionsNode;
  if (o && ts.isIdentifier(o) && objectConsts?.has(o.text)) o = objectConsts.get(o.text);
  if (!o || !ts.isObjectLiteralExpression(o)) return null;
  for (const prop of o.properties) {
    const key =
      prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : null;
    if (key !== "handler") continue;
    if (ts.isPropertyAssignment(prop)) return prop.initializer;
    // `{ handler }` — the binding, resolved to a declaration by the caller.
    if (ts.isShorthandPropertyAssignment(prop)) return prop.name;
    // `{ async handler(req, reply) { … } }` — the method IS the function.
    if (ts.isMethodDeclaration(prop)) return prop;
  }
  return null;
}

/** Guard calls made inside the handler body — the position the old map missed. */
function inHandlerGuardNames(handlerNode, knownGuards) {
  const names = [];
  if (!handlerNode) return names;
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const cn = calleeName(n);
      if (cn && knownGuards.has(cn)) names.push(cn);
    }
    ts.forEachChild(n, visit);
  };
  visit(handlerNode);
  return names;
}

/**
 * @param index the API function index
 * @param routesDir the directory to walk. Defaults to the production route
 *        tree; an ABSOLUTE path is accepted so an adversarial fixture can be
 *        parsed WITHOUT being written into `services/api/src/routes`.
 *
 *        That is not a convenience. A fixture written into the production tree
 *        is visible to every other suite in the same vitest run: three fixture
 *        routes made the live inventory 1088, and the freshness check, the
 *        module-reachability gate, the tenant-isolation gate and the route-count
 *        baseline all failed on a file that existed for 800 milliseconds. A test
 *        that mutates the tree it is measuring is not a test.
 */
export function extractRoutes(index, routesDir = ROUTES_DIR) {
  const routes = [];
  const dynamicUnresolved = [];

  // Any function whose name reaches a terminal marker is a candidate guard.
  // Computed once so in-handler detection does not depend on a name list.
  const knownGuards = new Set();
  for (const name of index.byName.keys()) {
    if (!/^(require|authorize|assert|check|verify|resolve|ensure)/i.test(name)) continue;
    if (classifyGuard(name, index, 3, new Set()).size > 0) knownGuards.add(name);
  }

  for (const abs of walkFiles(routesDir)) {
    const file = rel(abs);
    if (/\.(test|spec)\.tsx?$/.test(file)) continue;
    const text = readFileSync(abs, "utf8");
    const sf = parse(file, text);

    const consts = new Map();
    // Constants holding a route-options OBJECT, e.g.
    // `const ADMIN_PRE = { preHandler: requirePlatformAdmin }`.
    const objectConsts = new Map();
    const valueConsts = new Map();
    const collectConsts = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (ts.isStringLiteralLike(node.initializer)) consts.set(node.name.text, node.initializer.text);
        else if (ts.isObjectLiteralExpression(node.initializer)) objectConsts.set(node.name.text, node.initializer);
        // Any other bound value — notably a hoisted guard ARRAY.
        valueConsts.set(node.name.text, node.initializer);
      }
      ts.forEachChild(node, collectConsts);
    };
    collectConsts(sf);
    const ctx = { lookupConst: (n) => consts.get(n) };

    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const method = calleeName(node);
        const obj = calleeObject(node);
        const isRouteCall =
          method !== null && HTTP_METHODS.has(method) && obj !== null && /^(app|server|fastify|instance)$/.test(obj);
        const isObjectForm = method === "route" && obj !== null && /^(app|server|fastify|instance)$/.test(obj);

        if (isRouteCall || isObjectForm) {
          const record = readRegistration(node, method, isObjectForm, ctx, objectConsts);
          if (record === null) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            dynamicUnresolved.push({
              file,
              line: line + 1,
              reason: "route path is not statically resolvable",
              text: node.getText(sf).slice(0, 120).replace(/\s+/g, " "),
            });
          } else {
            const guardNames = [
              ...preHandlerNames(record.options, objectConsts, valueConsts),
              ...inHandlerGuardNames(record.handler, knownGuards),
            ];
            record.guardNames = [...new Set(guardNames)];
            record.devOnly = insideDevGate(node);
            record.registeringFile = file;
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            record.registrationLine = line + 1;
            if (record.routeExpansions?.length > 0) {
              for (const concrete of record.routeExpansions) {
                routes.push({ ...record, route: concrete, routeExpansions: [] });
              }
            } else {
              routes.push(record);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return { routes, dynamicUnresolved, knownGuards };
}

function readRegistration(node, method, isObjectForm, ctx, objectConsts) {
  if (isObjectForm) {
    const arg = node.arguments?.[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
    let url = null;
    let methods = [];
    let handler = null;
    for (const prop of arg.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
      if (key === "url") {
        const r = resolvePathExpr(prop.initializer, ctx);
        if (r.resolved) url = r.value;
      } else if (key === "method") {
        const collect = (n) => {
          if (ts.isStringLiteralLike(n)) methods.push(n.text.toLowerCase());
          else if (ts.isArrayLiteralExpression(n)) n.elements.forEach(collect);
        };
        collect(prop.initializer);
      } else if (key === "handler") handler = prop.initializer;
    }
    // Shorthand / method-form handler in the object registration form.
    if (handler === null) handler = handlerFromOptions(arg, objectConsts);
    if (url === null || methods.length === 0) return null;
    // Object form with a method ARRAY registers several routes; the caller
    // expands them, so only the first is returned here with the full list.
    return { method: methods[0].toUpperCase(), methods, route: registrationPath(url), options: arg, handler };
  }

  const pathArg = node.arguments?.[0];
  const r = resolvePathExpr(pathArg, ctx);
  if (!r.resolved) return null;
  // A loop over a literal table registers one route per row. Resolving the loop
  // variable to an interpolation invented a single route at a path that does not
  // exist and lost both real ones.
  const expanded = expandTemplate(pathArg, (n) => resolvePathExpr(n, ctx));
  // AN UNRESOLVED INTERPOLATION IS NOT A PATH.
  //
  // `resolvePathExpr` marks a template it cannot read as RESOLVED with the
  // `<interp>` placeholder still in it, and this function accepted that: the
  // inventory gained a route registered at a literal path containing
  // `<interp>` — a URL nothing can ever request — while
  // `DynamicUnresolvedRouteRegistrations` stayed at zero. An invented route
  // that reports itself as measured is the worst of both failures. Returning
  // null hands it to the caller's dynamic-unresolved list, where an unreadable
  // registration belongs.
  if (expanded.length === 0 && String(r.value).includes(INTERP)) return null;
  const second = node.arguments?.[1];
  const third = node.arguments?.[2];
  // The options argument may be an inline object OR an identifier bound to a
  // shared options constant (`app.get(path, ADMIN_PRE, handler)`). Treating the
  // latter as the handler loses the guard entirely.
  const isOptions =
    second &&
    (ts.isObjectLiteralExpression(second) || (ts.isIdentifier(second) && objectConsts.has(second.text)));
  const options = isOptions ? second : null;
  // The handler is the argument after the options when one was passed there,
  // and otherwise the options object's own `handler` property. Both positions
  // are read because Fastify accepts both and this codebase uses both.
  const handler = (options ? (third ?? handlerFromOptions(options, objectConsts)) : second) ?? null;
  return {
    method: method.toUpperCase(),
    methods: [method],
    route: registrationPath(r.value),
    routeExpansions: expanded.map(registrationPath),
    options,
    handler,
  };
}

/**
 * Final authorization class for a route, from the union of its guards'
 * terminal evidence.
 */
export function classifyRouteAuth(route, index) {
  if (route.devOnly) {
    return {
      authClassification: "DEVELOPMENT_ONLY",
      authEvidence: ["registered only inside `if (devAuthEnabled())` — production registration is zero"],
      gates: [],
    };
  }

  const classes = new Map();
  for (const g of route.guardNames) {
    for (const [cls, why] of classifyGuard(g, index, 4, new Set())) {
      if (!classes.has(cls)) classes.set(cls, `${g} -> ${why}`);
    }
  }

  // The handler BODY is analysed the same way, because a guard is not always
  // a named `require*` helper. Twilio's webhook routes have no preHandler at
  // all: their only auth is a signature check reached through
  // `handleTwilioWebhook`, and portal routes authenticate via
  // `resolvePortalSession` on the handler's first line. A name-shaped filter
  // misses both and reports them as UNGUARDED — a false alarm on two of the
  // most security-sensitive surfaces in the system.
  //
  // Shallow on purpose. Following the handler deep enough to reach ordinary
  // business logic would eventually touch a session somewhere and classify
  // every route as AUTHENTICATED, which is the opposite failure.
  if (route.handler) {
    for (const [cls, why] of collectMarkers(route.handler, index, 2, new Set())) {
      if (!classes.has(cls)) classes.set(cls, `handler body -> ${why}`);
    }
  }

  if (classes.size === 0) {
    return {
      authClassification: route.guardNames.length === 0 ? "PUBLIC_UNGUARDED" : "AUTHORIZATION_UNRESOLVED",
      authEvidence:
        route.guardNames.length === 0
          ? ["no preHandler and no in-handler guard call was found"]
          : [`guards found but none reached a terminal marker: ${route.guardNames.join(", ")}`],
      gates: route.guardNames,
    };
  }

  // Specific gates outrank the generic session check: a route that demands a
  // cron secret is a CRON_SECRET route even though the fallback path also
  // resolves a session.
  // PRECEDENCE must be TOTAL over the marker table. A class present in
  // TERMINAL_MARKERS but absent here filters out of `present`, and `present[0]`
  // on an empty array is `undefined` — an authorization classification of
  // literally nothing, which then flows into the map and into every gate reading
  // it. The assertion below is what makes adding a marker without ranking it a
  // loud failure instead of a silent hole.
  const PRECEDENCE = [
    "CRON_SECRET",
    "WEBHOOK_SIGNATURE",
    "SCIM_BEARER",
    "API_KEY_SCOPED",
    "INTERNAL_SERVICE",
    "PORTAL_TOKEN",
    "INVITATION_TOKEN",
    "ORGANIZATION_GATED",
    "CAPABILITY_GATED",
    "ADMIN_GATED",
    "DEVELOPMENT_ONLY",
    "AUTHENTICATED",
  ];
  const unranked = [...classes.keys()].filter((c) => !PRECEDENCE.includes(c));
  if (unranked.length > 0) {
    return {
      authClassification: "AUTHORIZATION_UNRESOLVED",
      authEvidence: [`terminal marker(s) reached but not ranked in PRECEDENCE: ${unranked.join(", ")}`],
      gates: route.guardNames,
    };
  }
  const present = PRECEDENCE.filter((c) => classes.has(c));
  const authClassification = present.length > 1 ? "MULTI_GATE" : present[0];

  return {
    authClassification,
    authEvidence: present.map((c) => classes.get(c)),
    gates: present,
  };
}
