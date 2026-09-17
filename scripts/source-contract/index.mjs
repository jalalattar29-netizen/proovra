/**
 * SOURCE CONTRACTS BY STRUCTURE, NOT BY CHARACTER COUNT (WCC-NEW-027).
 *
 * A source-contract test reads product source and asserts something about
 * it. The tree had 349 of them written as
 *
 *     const idx = SRC.indexOf("async function checkRedis");
 *     const slice = SRC.slice(idx, idx + 3000);
 *     expect(slice).toMatch(/connectTimeout: 500/);
 *
 * A fixed budget is wrong in both directions. A comment added inside the
 * function pushes the asserted text past the budget and fails a test about
 * behaviour nobody changed; a budget longer than the function reads the NEXT
 * function, so an assertion can pass on text that is not in the unit it
 * names. Adding a comment must not be able to break a behavioural gate, and
 * a gate must not be able to pass on its neighbour's code.
 *
 * These helpers return the CONSTRUCT the test is about, found by the
 * TypeScript parser: a named function, a route registration, the statement /
 * function / call / object / JSX element around a marker, or the text between
 * two markers. Every helper throws when its target is missing, so a renamed
 * function fails loudly instead of slicing from -1.
 *
 * One implementation for every test tree (services/api/test,
 * services/worker/test, apps/web/__tests__). TypeScript is resolved through
 * services/api, which every install of this monorepo contains.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ts = createRequire(path.join(REPO, "services", "api", "package.json"))("typescript");

function parse(src, fileName) {
  const kind = /\.tsx$/.test(fileName)
    ? ts.ScriptKind.TSX
    : /\.(mjs|cjs|js|jsx)$/.test(fileName)
      ? ts.ScriptKind.JSX
      : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind);
}

function fail(what) {
  throw new Error(`source contract: ${what}`);
}

function only(hits, what) {
  if (hits.length === 0) fail(`${what} not found`);
  if (hits.length > 1) fail(`${what} is ambiguous (${hits.length} matches)`);
  return hits[0];
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

const isFunctionLike = (n) =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isConstructorDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n);

/**
 * The full text of a named function: `function name`, `const name = (…) =>`,
 * `const name = function …`, or a method `name(…) { … }`. Must be unique.
 */
export function functionSource(src, name, fileName = "source.ts") {
  const sf = parse(src, fileName);
  const hits = [];
  walk(sf, (n) => {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name?.getText(sf) === name) {
      hits.push(n);
    } else if (
      ts.isVariableStatement(n) &&
      n.declarationList.declarations.some(
        (d) => d.name.getText(sf) === name && d.initializer && isFunctionLike(d.initializer),
      )
    ) {
      hits.push(n);
    }
  });
  return only(hits, `function ${name}`).getText(sf);
}

/**
 * The full text of a route registration: `<receiver>.<method>("<path>", …)`.
 * The receiver is not fixed (app, fastify, instance). Must be unique.
 */
export function routeSource(src, method, routePath, fileName = "routes.ts") {
  const sf = parse(src, fileName);
  const verb = method.toLowerCase();
  const hits = [];
  walk(sf, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === verb &&
      n.arguments[0] &&
      (ts.isStringLiteral(n.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(n.arguments[0])) &&
      n.arguments[0].text === routePath
    ) {
      hits.push(n);
    }
  });
  return only(hits, `${method.toUpperCase()} ${routePath}`).getText(sf);
}

const KINDS = {
  statement: (n) => ts.isStatement(n) || ts.isClassElement(n),
  function: isFunctionLike,
  call: (n) => ts.isCallExpression(n) || ts.isNewExpression(n),
  object: (n) => ts.isObjectLiteralExpression(n),
  jsx: (n) => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n),
  block: (n) => ts.isBlock(n),
};

/**
 * The smallest construct of `kind` that contains the `occurrence`-th match of
 * `marker` (0-based, the same text `indexOf` would find first by default).
 *
 * kind: "statement" (default) | "function" | "call" | "object" | "jsx" | "block".
 * For "function", a marker inside `const name = () => …`'s NAME resolves to
 * that whole declaration. Pass `{ unique: true }` to refuse a marker that
 * appears more than once.
 */
export function enclosingSource(src, marker, kind = "statement", options = {}) {
  const { occurrence = 0, unique = false, fileName = "source.tsx" } = options;
  const test = KINDS[kind];
  if (!test) fail(`unknown kind "${kind}"`);
  const positions = [];
  for (let at = src.indexOf(marker); at >= 0; at = src.indexOf(marker, at + 1)) positions.push(at);
  if (positions.length === 0) fail(`marker ${JSON.stringify(marker)} not found`);
  if (unique && positions.length > 1) fail(`marker ${JSON.stringify(marker)} appears ${positions.length} times`);
  const pos = positions[occurrence];
  if (pos === undefined) fail(`marker ${JSON.stringify(marker)} has no occurrence ${occurrence}`);
  const end = pos + marker.length;

  const sf = parse(src, fileName);
  let best = null;
  walk(sf, (n) => {
    if (n.getStart(sf) <= pos && n.getEnd() >= end && test(n)) best = n; // deepest wins: walk is pre-order
  });
  if (!best && kind === "function") {
    // `const name = () => …` with the marker on the name: the declaration is the unit.
    walk(sf, (n) => {
      if (
        ts.isVariableStatement(n) &&
        n.getStart(sf) <= pos &&
        n.getEnd() >= end &&
        n.declarationList.declarations.some((d) => d.initializer && isFunctionLike(d.initializer))
      ) {
        best = n;
      }
    });
  }
  if (!best) fail(`no ${kind} encloses ${JSON.stringify(marker)}`);
  return best.getText(sf);
}

/**
 * The text from `start` (inclusive) to the first `end` after it (exclusive).
 * For a contract that genuinely spans constructs — a region a comment block
 * delimits, a sequence of statements. Both markers must exist, in order.
 */
export function betweenMarkers(src, start, end) {
  const a = src.indexOf(start);
  if (a < 0) fail(`start marker ${JSON.stringify(start)} not found`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) fail(`end marker ${JSON.stringify(end)} not found after the start marker`);
  return src.slice(a, b);
}
