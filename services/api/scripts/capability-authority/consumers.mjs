#!/usr/bin/env node
/**
 * PHASE 12 — CAPABILITY AUTHORITY: THE CONSUMER SIDE.
 *
 * `routes.mjs` answers "what is registered and what guards it". This module
 * answers the other half: "who actually calls it, and is that caller a product
 * surface a human can reach, or a machine".
 *
 * WHY IT IS NOT A SEARCH FOR PATH-SHAPED STRINGS
 * ---------------------------------------------------------------------------
 * The retired text verifier counted every string that looked like an API path.
 * That reading credits `router.push("/collaboration-teams/x")`, an `href`, a
 * doc comment and an analytics label as callers — so an endpoint no human being
 * can reach looks wired, which is the single most expensive wrong answer this
 * whole exercise exists to prevent. Here a path counts only when it is passed
 * to something that PERFORMS A REQUEST, and "performs a request" is itself
 * derived: a seed set of terminals plus a fixpoint over every function that
 * forwards a parameter into one, however many wrappers deep.
 *
 * WHAT IT REFUSES TO GUESS
 * ---------------------------------------------------------------------------
 * A request whose path cannot be resolved statically is published as
 * DYNAMIC_UNRESOLVED with its file and line. It is never dropped and never
 * counted, because both of those convert an unknown into a false certainty —
 * silently, and in the direction that makes the report look better.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import {
  REPO,
  INTERP,
  TREES,
  analyzeSources,
  calleeName,
  calleeObject,
  candidatePaths,
  literalUnionOf,
  normalizePath,
  resolvePathExpr,
} from "./analyzer.mjs";

const require = createRequire(import.meta.url);
/** @type {import("typescript")} */
const ts = require("typescript");

/**
 * Only these prefixes are API paths. A request to `/_next/...`, an absolute
 * `https://sentry.io/...` or a relative `./data.json` is a request, but it is
 * not a call on this API and must not be recorded as one.
 */
const API_PREFIXES = ["/v1/", "/public/", "/healthz", "/readyz", "/metrics", "/paypal", "/stripe"];

const isApiPath = (p) =>
  API_PREFIXES.some((prefix) => (prefix.endsWith("/") ? p.startsWith(prefix) : p === prefix)) ||
  p === "/v1";

/**
 * Whether an INTERPOLATED origin is this API's origin.
 *
 * `${base}/v1/billing/subscriptions/${id}/cancel` in `paypal.service.ts` is a
 * call to PAYPAL — whose REST API also versions under `/v1/` and also has
 * `/v1/billing/...`. Treating any interpolated origin as ours silently imported
 * six of PayPal's endpoints into this system's route inventory as callers of
 * routes that do not exist. The origin expression is therefore read, and only a
 * recognised base for THIS API is accepted; anything else is a third party.
 */
// Deliberately narrow. `baseUrl` was in this list for one revision and it
// matched PayPal's own `baseUrl`, quietly importing PayPal's `/v1/oauth2/token`
// and `/v1/billing/subscriptions` as calls on THIS API. A generic name is not
// evidence of whose origin it holds.
const OUR_ORIGIN_EXPR =
  /\b(apiBaseUrl|API_BASE|NEXT_PUBLIC_API_BASE|EXPO_PUBLIC_API_BASE)\b/;

/**
 * Browser code must reach the API through the origin `apiBaseUrl()` resolves.
 * A RELATIVE `/v1/...` given to raw `fetch` is served by the Next.js origin,
 * which has no rewrite for it — the call 404s at runtime while looking perfectly
 * correct in review. This is a defect class the repository has already been bitten
 * by, so it is measured rather than remembered.
 */
export const WRONG_ORIGIN = "WRONG_ORIGIN";

// ===========================================================================
// Object-literal constants: `const EP = { list: "/v1/x" }` -> EP.list
// ===========================================================================

function collectObjectPathConsts(sf) {
  /** @type {Map<string, Map<string,string>>} */
  const objects = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const props = new Map();
      for (const p of node.initializer.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const key = ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) ? p.name.text : null;
        if (key !== null && ts.isStringLiteralLike(p.initializer)) props.set(key, p.initializer.text);
      }
      if (props.size > 0) objects.set(node.name.text, props);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return objects;
}

/**
 * Object METHODS that forward into a request: `const api = { get: (p) => apiFetch(p) }`.
 * Recorded as `api.get` so a call written `api.get("/v1/x")` is recognised
 * without making every `.get(` in the tree look like an HTTP call.
 */
function collectRequestMethods(sf, isRequestCall, entry) {
  const methods = new Set();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const objName = node.name.text;
      for (const p of node.initializer.properties) {
        const key =
          p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : null;
        if (key === null) continue;
        const fn = ts.isPropertyAssignment(p) ? p.initializer : ts.isMethodDeclaration(p) ? p : null;
        if (fn === null) continue;
        const params = new Set(
          (fn.parameters ?? []).filter((x) => ts.isIdentifier(x.name)).map((x) => x.name.text),
        );
        if (params.size === 0) continue;
        const body = ts.isPropertyAssignment(p) ? fn.body : fn.body;
        if (!body) continue;
        let hit = false;
        const scan = (n) => {
          if (hit) return;
          if (ts.isCallExpression(n) && isRequestCall(n, entry)) {
            const arg = n.arguments?.[0];
            if (arg && mentions(arg, params)) hit = true;
          }
          ts.forEachChild(n, scan);
        };
        scan(body);
        if (hit) methods.add(`${objName}.${key}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return methods;
}

/** `{key, body}` when `node` declares a discovered request function, else null. */
function declaredRequestFnName(node, entry, requestFns) {
  let name = null;
  let fn = null;
  if (ts.isFunctionDeclaration(node) && node.name) {
    name = node.name.text;
    fn = node;
  } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    const init = node.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
      name = node.name.text;
      fn = init;
    }
  }
  if (name === null || fn === null || !fn.body) return null;
  const key = `${entry.file}#${name}`;
  return requestFns.has(key) ? { key, body: fn.body } : null;
}

/**
 * True when `name` is bound by a PARAMETER of some function enclosing `node`.
 *
 * Scope, not string matching. A React component receiving `onTransition` as a
 * prop and a module-level `onTransition` that happens to issue a request are
 * different bindings, and only the second is a request function.
 */
function isEnclosingParameter(node, name) {
  let cur = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur)
    ) {
      for (const p of cur.parameters ?? []) {
        if (ts.isIdentifier(p.name) && p.name.text === name) return true;
        // Destructured props: `({ onTransition, row })`.
        if (ts.isObjectBindingPattern(p.name)) {
          for (const el of p.name.elements) {
            if (ts.isIdentifier(el.name) && el.name.text === name) return true;
          }
        }
      }
    }
    cur = cur.parent;
  }
  return false;
}

function mentions(node, names) {
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
// Enclosing declaration name, so a call site can be attributed to a caller
// rather than only to a line number.
// ===========================================================================

function enclosingName(node) {
  let cur = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && cur.name && ts.isIdentifier(cur.name)) return cur.name.text;
    if (
      ts.isVariableDeclaration(cur) &&
      ts.isIdentifier(cur.name) &&
      cur.initializer &&
      (ts.isArrowFunction(cur.initializer) || ts.isFunctionExpression(cur.initializer))
    ) {
      return cur.name.text;
    }
    cur = cur.parent;
  }
  return "<module>";
}

/**
 * The path argument of a request call.
 *
 * Usually argument 0. Some clients take an options OBJECT — `request({ path })`
 * / `({ url })` — so those two property names are read as well. Anything else
 * is left unresolved rather than assumed.
 */
/**
 * The HTTP method of a request call.
 *
 * `fetch`/`apiFetch` default to GET when no `method` is given, so an absent
 * init is GET — not "unknown". Returns null only when the method is present but
 * not statically knowable (typically `init` forwarded through a wrapper), and
 * null deliberately matches ANY method: the alternative would drop every
 * wrapper-mediated call, which understates consumption far more than it
 * overstates it.
 */
function methodOf(call, primitive) {
  const wrapperMethod = /\.(get|post|put|patch|delete)$/i.exec(primitive ?? "");
  if (wrapperMethod) return wrapperMethod[1].toUpperCase();

  const first = call.arguments?.[0];
  const optionsForm = first !== undefined && ts.isObjectLiteralExpression(first);
  const init = optionsForm ? first : call.arguments?.[1];
  if (init === undefined) return "GET";
  if (!ts.isObjectLiteralExpression(init)) return null;
  for (const p of init.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) ? p.name.text : null;
    if (key !== "method") continue;
    if (ts.isStringLiteralLike(p.initializer)) return p.initializer.text.toUpperCase();
    return null;
  }
  // `runMutation({ key, path })` — the OPTIONS form. An absent `method` here
  // does not mean GET; it means the wrapper chose the method, and the wrapper is
  // elsewhere. Reading it as GET made every admin session mutation look like a
  // GET of a route that only accepts POST, so the real POST route showed up with
  // no consumer at all — an invented orphan.
  return optionsForm ? null : "GET";
}

/**
 * True when the unresolved path expression is simply a PARAMETER of the
 * function doing the forwarding.
 *
 * `apiFetch` itself contains `fetch(url)` where `url` is its own argument. That
 * is plumbing, not an unresolved route call — the real call sites are this
 * function's callers, and they are analysed on their own. Reporting it would
 * fill DYNAMIC_UNRESOLVED with the very wrappers whose discovery is the point.
 */
function isForwardedParameter(argNode, call) {
  if (argNode === undefined) return false;
  const params = new Set();
  let cur = call.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur)
    ) {
      for (const p of cur.parameters ?? []) {
        if (ts.isIdentifier(p.name)) params.add(p.name.text);
      }
    }
    cur = cur.parent;
  }
  return params.size > 0 && mentions(argNode, params);
}

/**
 * Source text of the expression standing in for the origin — the first
 * interpolation of a template that begins with one. Text, not a value: the
 * question is only WHICH base this is, and the name is what answers it.
 */
function originExpressionText(argNode) {
  let node = argNode;
  while (node && ts.isIdentifier(node) === false && ts.isTemplateExpression(node) === false) {
    if (ts.isParenthesizedExpression(node)) node = node.expression;
    else break;
  }
  if (node && ts.isTemplateExpression(node) && node.head.text === "") {
    const first = node.templateSpans?.[0];
    if (first) return first.expression.getText();
  }
  // The path may have been assembled into a local; the identifier's own name is
  // the next best evidence available without re-resolving the binding.
  if (argNode && ts.isIdentifier(argNode)) return argNode.text;
  return null;
}

/**
 * Concrete readings of a template whose interpolations have literal-union types.
 *
 * Bounded on purpose: a path with several union segments multiplies out, and a
 * cap keeps a pathological signature from producing thousands of candidates.
 * Over the cap the expansion is abandoned entirely rather than truncated, so the
 * result is never a silently partial answer.
 */
const MAX_UNION_EXPANSIONS = 24;

function expandLiteralUnions(argNode, resolve, bindings) {
  // The template is as often bound to a local first —
  // `const url = `/v1/redaction/versions/${versionId}/${action}`; apiFetch(url)`
  // — as it is written inline. Looking only at the argument node misses those.
  if (argNode && ts.isIdentifier(argNode) && bindings?.has(argNode.text)) {
    argNode = bindings.get(argNode.text);
  }
  if (!argNode || !ts.isTemplateExpression(argNode)) return [];
  let hasUnion = false;
  /** @type {string[][]} */
  const spanValues = [];
  for (const span of argNode.templateSpans) {
    const union = literalUnionOf(span.expression);
    if (union !== null) {
      hasUnion = true;
      spanValues.push(union);
    } else {
      const r = resolve(span.expression);
      spanValues.push([r.resolved ? r.value : INTERP]);
    }
  }
  if (!hasUnion) return [];

  let total = 1;
  for (const v of spanValues) total *= v.length;
  if (total > MAX_UNION_EXPANSIONS) return [];

  let out = [argNode.head.text];
  argNode.templateSpans.forEach((span, i) => {
    const next = [];
    for (const prefix of out) for (const v of spanValues[i]) next.push(prefix + v + span.literal.text);
    out = next;
  });
  return out;
}

function pathArgumentOf(call) {
  const first = call.arguments?.[0];
  if (first === undefined) return undefined;
  if (ts.isObjectLiteralExpression(first)) {
    for (const p of first.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const key = ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) ? p.name.text : null;
      if (key === "path" || key === "url") return p.initializer;
    }
    return undefined;
  }
  return first;
}

// ===========================================================================
// MAIN
// ===========================================================================

/**
 * @returns {{
 *   consumers: Array<{path:string,candidates:string[],file:string,line:number,class:string,product:boolean,caller:string,primitive:string,origin:string|null}>,
 *   dynamicUnresolved: Array<{file:string,line:number,caller:string,requestPrimitive:string,reason:string,text:string}>,
 *   fileCount: number,
 *   requestFnCount: number,
 * }}
 */
/**
 * Elements whose listed attributes cause the browser to FETCH the URL.
 *
 * `a` is present for `href` only alongside `download`, checked at the call site
 * below — an ordinary anchor is navigation, and counting navigation as an API
 * consumer is the exact mistake that let a broken `<a href="/v1/…">` read as a
 * wired capability for months.
 */
const RESOURCE_ELEMENTS = Object.freeze({
  img: ["src", "srcSet"],
  video: ["src", "poster"],
  audio: ["src"],
  source: ["src", "srcSet"],
  track: ["src"],
  iframe: ["src"],
  embed: ["src"],
  object: ["data"],
  script: ["src"],
  link: ["href"],
});

/** The tag name owning a JSX attribute, lowercased; null when unreadable. */
function jsxElementName(attrNode) {
  let cur = attrNode.parent;
  while (cur && !ts.isJsxOpeningElement(cur) && !ts.isJsxSelfClosingElement(cur)) cur = cur.parent;
  if (!cur) return null;
  const name = cur.tagName?.getText?.();
  return typeof name === "string" ? name.toLowerCase() : null;
}

export function analyzeConsumers(
  originResolutions = new Map(),
  dynamicResolutions = new Map(),
  consumerResolutions = new Map(),
  { includeTests = false } = {},
) {
  const { parsedByPath, requestFns, ctxFor, isRequestCall, requestFnKeyFor, pathBuildingFns } =
    analyzeSources({ includeTests });

  const consumers = [];
  const dynamicUnresolved = [];
  const foreignOrUnknownOrigin = [];
  const reviewedUnresolved = [];
  const synthesized = [];

  // --- Wrappers that speak to somebody ELSE ------------------------------
  //
  // `paypalGet("/v1/billing/plans/…")` looks exactly like a call on this API:
  // relative path, /v1 prefix, no origin in sight. The origin is prepended two
  // lines away inside the wrapper, and it is PayPal's. The reviewed manifest
  // already answers that for the wrapper's own fetch; this carries the answer
  // OUT to its callers, so a third party's endpoints stop appearing as calls on
  // routes this system does not have. Transitive, because wrappers wrap wrappers.
  const externalRequestFns = new Set();
  for (let round = 0; round < 4; round += 1) {
    let grew = false;
    for (const entry of parsedByPath.values()) {
      const visit = (node) => {
        const declared = declaredRequestFnName(node, entry, requestFns);
        if (declared !== null && !externalRequestFns.has(declared.key)) {
          let external = false;
          const scan = (n) => {
            if (external) return;
            if (ts.isCallExpression(n) && isRequestCall(n, entry)) {
              const { line } = entry.sf.getLineAndCharacterOfPosition(n.getStart(entry.sf));
              if (originResolutions.get(`${entry.file}:${line + 1}`) === "EXTERNAL") external = true;
              const target = requestFnKeyFor(n, entry);
              if (target !== null && externalRequestFns.has(target)) external = true;
            }
            ts.forEachChild(n, scan);
          };
          scan(declared.body);
          if (external) {
            externalRequestFns.add(declared.key);
            grew = true;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(entry.sf);
    }
    if (!grew) break;
  }

  for (const entry of parsedByPath.values()) {
    const objectConsts = collectObjectPathConsts(entry.sf);
    const requestMethods = collectRequestMethods(entry.sf, isRequestCall, entry);

    /**
     * Record a browser element whose resource URL is an API path.
     *
     * Deliberately narrow: the URL must resolve to something this API actually
     * registers (`isApiPath`), so an `<img src="/logo.svg">` or an anchor to an
     * app route contributes nothing. `viaResolution` is false because the
     * analyzer read this itself.
     */
    const recordResourceConsumer = (expr, primitive) => {
      if (!expr) return;
      const r = resolve(expr);
      if (!r.resolved) return;
      const normalized = normalizePath(String(r.value));
      if (!isApiPath(normalized)) return;
      const { line } = entry.sf.getLineAndCharacterOfPosition(expr.getStart(entry.sf));
      consumers.push({
        path: normalized,
        candidates: candidatePaths(normalized),
        method: "GET",
        file: entry.file,
        line: line + 1,
        class: entry.class,
        product: entry.product,
        caller: enclosingName(expr),
        primitive,
        origin: null,
        wrongOrigin: false,
      });
    };

    /** Extends the shared resolver with `OBJ.prop` readings local to this file. */
    const resolve = (node) => {
      if (
        node &&
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        objectConsts.has(node.expression.text)
      ) {
        const v = objectConsts.get(node.expression.text).get(node.name.text);
        if (v !== undefined) return { resolved: true, value: v };
      }
      if (node && ts.isTemplateExpression(node)) {
        // Re-implemented only to route nested spans back through THIS resolver
        // so an object-constant inside a template is not lost.
        let out = node.head.text;
        for (const span of node.templateSpans) {
          const inner = resolve(span.expression);
          out += inner.resolved ? inner.value : INTERP;
          out += span.literal.text;
        }
        return { resolved: true, value: out };
      }
      // Fresh context per resolution — `ctxFor`'s cycle guard is single-use.
      return resolvePathExpr(node, ctxFor(entry));
    };

    const visit = (node) => {
      // -------------------------------------------------------------------
      // BROWSER-ELEMENT CONSUMERS.
      //
      // An `<img src>` IS a request — the browser issues a GET the moment the
      // element mounts — but it is not a call expression, so a walk that looks
      // only at calls cannot see it. `GET /v1/evidence/:id/derived-assets/:id/bytes`
      // had two live `<img>` consumers and was counted as a route with no
      // product surface at all.
      //
      // Only RESOURCE attributes count: `src` / `href` on elements that fetch.
      // A `<Link href>` or an anchor to an app page is NAVIGATION and must
      // never be counted as an API consumer, which is why the element name is
      // part of the rule rather than the attribute alone.
      // -------------------------------------------------------------------
      if (ts.isJsxAttribute(node) && node.initializer) {
        const attr = node.name.getText(entry.sf);
        const el = jsxElementName(node);
        const fetching = RESOURCE_ELEMENTS[el];
        if (fetching && fetching.includes(attr)) {
          const expr = ts.isJsxExpression(node.initializer)
            ? node.initializer.expression
            : node.initializer;
          recordResourceConsumer(expr, `<${el} ${attr}>`);
        }
      }
      // `window.location = "…"` / `location.assign("…")` — a real navigation to
      // an API resource (a download, an export) rather than to an app page.
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        /^(assign|replace)$/.test(node.expression.name.text) &&
        /location$/.test(node.expression.expression.getText(entry.sf))
      ) {
        recordResourceConsumer(node.arguments?.[0], "location.assign");
      }

      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        const obj = calleeObject(node);
        const asMethod = obj !== null && name !== null ? `${obj}.${name}` : null;
        const isReq =
          isRequestCall(node, entry) || (asMethod !== null && requestMethods.has(asMethod));

        // A call to a wrapper that BUILDS its own path contributes nothing: the
        // path was already recorded inside the wrapper. Asking this call site
        // for a path produces a false "unresolvable request".
        // A callee that resolves to a PARAMETER of an enclosing function is a
        // prop, not the module-level function of the same name. `onWrite`,
        // `onTransition` and `runDecide` are passed INTO these components; the
        // request they eventually reach lives where the handler is defined and
        // is counted there. Matching them by name alone conflated a prop with an
        // unrelated local and produced an unresolvable request for a call that
        // carries no path at all.
        if (isReq && name !== null && isEnclosingParameter(node, name)) {
          ts.forEachChild(node, visit);
          return;
        }

        // A "request wrapper" whose first argument is a FUNCTION is a
        // higher-order runner — `stepUp.runStepUpAction(async (headers) => …)`
        // runs a callback that may retry it with a step-up header. The path is
        // inside the callback, which is walked on its own.
        const firstArg = node.arguments?.[0];
        if (
          isReq &&
          firstArg &&
          (ts.isArrowFunction(firstArg) || ts.isFunctionExpression(firstArg))
        ) {
          ts.forEachChild(node, visit);
          return;
        }

        const targetKey = requestFnKeyFor(node, entry);
        if (isReq && targetKey !== null && externalRequestFns.has(targetKey)) {
          ts.forEachChild(node, visit);
          return;
        }
        if (isReq && targetKey !== null && pathBuildingFns.has(targetKey)) {
          ts.forEachChild(node, visit);
          return;
        }

        if (isReq) {
          const primitive = asMethod && requestMethods.has(asMethod) ? asMethod : (name ?? "<anonymous>");
          const arg = pathArgumentOf(node);
          const r = resolve(arg);
          const { line } = entry.sf.getLineAndCharacterOfPosition(node.getStart(entry.sf));

          if (!r.resolved) {
            // A reviewed site is one a human has already read and classified —
            // an object-store PUT, an outbound provider call. It stays out of
            // the unresolved list, but it is still RECORDED: a manifest that
            // suppressed its own evidence would make every entry look stale the
            // moment anything asked whether the exemption was still needed.
            const site = `${entry.file}:${line + 1}`;
            const reviewed = dynamicResolutions.has(site);
            if (reviewed) reviewedUnresolved.push(site);
            if (!reviewed && !isForwardedParameter(arg, node)) {
              dynamicUnresolved.push({
                file: entry.file,
                line: line + 1,
                caller: enclosingName(node),
                requestPrimitive: primitive,
                reason: r.reason,
                text: node.getText(entry.sf).slice(0, 140).replace(/\s+/g, " "),
              });
            }
          } else {
            const raw = r.value;
            // Strip a resolved absolute origin (`https://host/v1/x`) down to the
            // path, and remember that it WAS absolute.
            let origin = null;
            let pathPart = raw;
            const abs = /^(https?:)?\/\/[^/]+/.exec(raw);
            if (abs) {
              origin = abs[0];
              pathPart = raw.slice(abs[0].length);
            } else if (raw.startsWith(INTERP)) {
              // `${base}/v1/x` — the interpolation stands in for an origin, so
              // the remainder is a path. WHOSE path depends on what `base` is.
              origin = originExpressionText(arg);
              if (origin === null || !OUR_ORIGIN_EXPR.test(origin)) {
                // Not recognisably this API's origin. A reviewed manifest may
                // say otherwise — the worker's internal client and the portal
                // SSO callback both build our origin from a locally-named
                // variable — but the analyzer will not decide it. Unreviewed,
                // it is published rather than dropped, and the closure gate
                // fails until a human has answered it once.
                const verdict = originResolutions.get(`${entry.file}:${line + 1}`);
                if (verdict !== "OURS") {
                  if (verdict === undefined) {
                    foreignOrUnknownOrigin.push({
                      file: entry.file,
                      line: line + 1,
                      caller: enclosingName(node),
                      originExpression: origin,
                      path: normalizePath(raw.slice(INTERP.length)),
                      text: node.getText(entry.sf).slice(0, 120).replace(/\s+/g, " "),
                    });
                  }
                  ts.forEachChild(node, visit);
                  return;
                }
              }
              pathPart = raw.slice(INTERP.length);
            }

            const normalized = normalizePath(pathPart);
            if (!isApiPath(normalized)) {
              // A request built on THIS API's origin whose path cannot be read
              // is an unresolved route, not a non-API request. Dropping it
              // silently is the one behaviour this module is not allowed:
              // `apps/web/app/api/_marketing-leads.ts` builds
              // `${apiBase}${config.upstreamPath}` and served BOTH the
              // contact-sales and demo-request routes, which consequently
              // appeared to have no product consumer at all.
              // A human may already have read this site and named the routes it
              // reaches — `_marketing-leads.ts` picks its upstream path out of a
              // config table two functions away. The reviewed answer becomes a
              // real consumer, carrying `viaResolution` so it is never mistaken
              // for something the analyzer resolved on its own.
              const reviewedRoutes = consumerResolutions.get(`${entry.file}:${line + 1}`);
              if (reviewedRoutes !== undefined) {
                for (const rid of reviewedRoutes) {
                  const space = rid.indexOf(" ");
                  synthesized.push({
                    routeId: rid,
                    method: rid.slice(0, space),
                    path: rid.slice(space + 1),
                    file: entry.file,
                    line: line + 1,
                    class: entry.class,
                    product: entry.product,
                    caller: enclosingName(node),
                    primitive,
                    origin,
                    wrongOrigin: false,
                    viaResolution: true,
                  });
                }
                ts.forEachChild(node, visit);
                return;
              }
              const dropSite = `${entry.file}:${line + 1}`;
              if (dynamicResolutions.has(dropSite)) reviewedUnresolved.push(dropSite);
              else if (origin !== null && normalized.includes(INTERP)) {
                dynamicUnresolved.push({
                  file: entry.file,
                  line: line + 1,
                  caller: enclosingName(node),
                  requestPrimitive: primitive,
                  reason: "origin is this API but the path is not statically resolvable",
                  text: node.getText(entry.sf).slice(0, 140).replace(/\s+/g, " "),
                });
              }
              ts.forEachChild(node, visit);
              return;
            }

            // A `${action}` segment whose type is a literal union names its own
            // routes; expanding it is reading, not guessing.
            const expansions = expandLiteralUnions(arg, resolve, entry.bindings).map(normalizePath);
            const allCandidates = new Set(candidatePaths(normalized));
            for (const e of expansions) for (const c of candidatePaths(e)) allCandidates.add(c);

            consumers.push({
              path: normalized,
              method: methodOf(node, primitive),
              candidates: [...allCandidates],
              file: entry.file,
              line: line + 1,
              class: entry.class,
              product: entry.product,
              caller: enclosingName(node),
              primitive: primitive,
              origin,
              // A BROWSER-tree raw `fetch` with no origin at all reaches the
              // Next.js server, not the API. `apiFetch` supplies the origin
              // itself, so only the bare primitive can be wrong this way.
              wrongOrigin:
                entry.class === "WEB" && origin === null && (primitive === "fetch" || primitive === "$fetch"),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(entry.sf);
  }

  // --- reviewed resolutions the walk never reached ------------------------
  //
  // The synthesis above fires only where the analyzer SAW a request call and
  // could not read its path. A reviewed entry pointing at a site the walk never
  // visits at all — a default fetcher argument (`const f = input.fetcher ??
  // apiFetch`), a ternary-built suffix, a mobile `FileSystem.downloadAsync`
  // with an absolute origin — did nothing whatsoever, silently. Five routes
  // with real, cited product callers stayed in the "no consumer" bucket because
  // of it, and a manifest entry that quietly does nothing is worse than no
  // manifest: it reads as answered.
  //
  // So an unreached reviewed resolution becomes a DECLARED consumer, carrying
  // `viaResolution: true` exactly like the other synthesis path, and the count
  // of them is reported so declarations can never be mistaken for measurements.
  const reachedSites = new Set(
    [...consumers, ...synthesized].map((c) => `${c.file}:${c.line}`),
  );
  let declaredConsumers = 0;
  for (const [site, routes] of consumerResolutions) {
    if (reachedSites.has(site)) continue;
    const idx = site.lastIndexOf(":");
    const file = site.slice(0, idx);
    const line = Number(site.slice(idx + 1));
    const cls = TREES.find((t) => t.roots.some((r) => file.startsWith(`${r}/`)));
    if (cls === undefined) continue;
    for (const rid of routes) {
      const space = rid.indexOf(" ");
      synthesized.push({
        routeId: rid,
        method: rid.slice(0, space),
        path: rid.slice(space + 1),
        file,
        line,
        class: cls.class,
        product: cls.product,
        caller: "declared-by-review",
        primitive: "declared",
        origin: null,
        wrongOrigin: false,
        viaResolution: true,
      });
      declaredConsumers += 1;
    }
  }

  return {
    consumers,
    dynamicUnresolved,
    reviewedUnresolved,
    synthesized,
    declaredConsumers,
    foreignOrUnknownOrigin,
    fileCount: parsedByPath.size,
    requestFnCount: requestFns.size,
  };
}

/**
 * Attach consumers to routes.
 *
 * Matching is delegated to `matches`/`segMatch` in analyzer.mjs, which refuses
 * to let an interpolated consumer segment satisfy a LITERAL route segment. That
 * asymmetry is deliberate: over-matching hides an orphan, under-matching only
 * costs a human a written disposition.
 */
export function attachConsumers(routeIds, consumers, matches, resolutions = new Map()) {
  /** @type {Map<string, Array<object>>} */
  const byRoute = new Map(routeIds.map((id) => [id, []]));
  const unmatched = [];
  const ambiguous = [];

  for (const c of consumers) {
    let hit = false;
    for (const id of routeIds) {
      const [routeMethod, pattern] = id.split(" ");
      // A consumer with a KNOWN method credits only that method. `c.method ===
      // null` means the method travels through a wrapper and cannot be read, so
      // it credits any method on the path — the only reading that does not
      // discard wrapper-mediated calls wholesale.
      if (c.method !== null && c.method !== routeMethod) continue;
      if (c.candidates.some((cand) => matches(pattern, cand))) {
        byRoute.get(id).push(c);
        hit = true;
      }
    }
    if (hit) continue;

    // A path whose ACTION segment is interpolated — `/v1/me/inbox/items/${id}/
    // ${action}` where `action` is "read" or "archive" — is a real call to real
    // routes, but which ones cannot be read from syntax. `segMatch` refuses to
    // let `<interp>` satisfy a literal segment, and that refusal is right: the
    // alternative credits `POST /v1/cases/${id}` as a caller of every POST under
    // /v1/cases. So the call is neither counted nor discarded. It is published
    // as AMBIGUOUS and answered ONCE, by a human, in the resolutions manifest —
    // with the file and line that has to be read to answer it.
    const site = `${c.file}:${c.line}`;
    const resolved = resolutions.get(site);
    if (resolved !== undefined) {
      let credited = false;
      for (const id of resolved) {
        if (byRoute.has(id)) {
          byRoute.get(id).push({ ...c, viaResolution: true });
          credited = true;
        }
      }
      if (credited) continue;
    }

    if (c.path.includes(INTERP)) ambiguous.push(c);
    else unmatched.push(c);
  }

  return { byRoute, unmatched, ambiguous };
}

// Re-exported so the generator has exactly one import surface.
export { REPO, path as nodePath, readFileSync };
