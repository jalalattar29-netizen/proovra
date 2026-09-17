/**
 * WCC-NEW-027 — source contracts read constructs, not character budgets.
 *
 * `scripts/source-contract` returns the function, route registration or
 * enclosing construct a test is about. These cases pin the helpers, and the
 * last one is the standing rule: no test in the three test trees slices
 * source with a fixed budget (`src.slice(idx, idx + 3000)`).
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  betweenMarkers,
  enclosingSource,
  functionSource,
  routeSource,
} from "../../../scripts/source-contract/index.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const SRC = [
  "async function checkRedis() {",
  "  // a comment that grows",
  "  const client = { connectTimeout: 500 };",
  "  return client;",
  "}",
  "function checkS3() {",
  "  return { connectTimeout: 9 };",
  "}",
  "const helper = (x: number) => x + 1;",
  'app.get("/v1/a", { preHandler: requireAuth }, async () => {',
  '  const where = { teamId: "t" };',
  "  return where;",
  "});",
  'app.post("/v1/a", async () => null);',
].join("\n");

test("functionSource returns exactly the named function", () => {
  const fn = functionSource(SRC, "checkRedis");
  assert.match(fn, /connectTimeout: 500/);
  assert.doesNotMatch(fn, /connectTimeout: 9/, "never the next function");
  assert.match(functionSource(SRC, "helper"), /x \+ 1/);
  assert.throws(() => functionSource(SRC, "missing"), /not found/);
});

test("a comment inside the function cannot push an assertion out of it", () => {
  const grown = SRC.replace("// a comment that grows", `// ${"x".repeat(8000)}`);
  assert.match(functionSource(grown, "checkRedis"), /connectTimeout: 500/);
});

test("routeSource returns the registration for one method and path", () => {
  const get = routeSource(SRC, "GET", "/v1/a");
  assert.match(get, /teamId/);
  assert.doesNotMatch(routeSource(SRC, "POST", "/v1/a"), /teamId/);
  assert.throws(() => routeSource(SRC, "DELETE", "/v1/a"), /not found/);
});

test("enclosingSource returns the construct around a marker", () => {
  assert.match(enclosingSource(SRC, '"/v1/a"', "statement"), /return where/);
  assert.equal(enclosingSource(SRC, "connectTimeout: 500", "object"), "{ connectTimeout: 500 }");
  assert.match(enclosingSource(SRC, "helper", "function"), /x \+ 1/);
  assert.match(enclosingSource(SRC, "connectTimeout: 500", "function"), /^async function checkRedis/);
  assert.throws(() => enclosingSource(SRC, "connectTimeout", "object", { unique: true }), /appears 2 times/);
  assert.throws(() => enclosingSource(SRC, "nope"), /not found/);
});

test("betweenMarkers requires both markers, in order", () => {
  assert.match(betweenMarkers(SRC, "function checkS3", "const helper"), /connectTimeout: 9/);
  assert.throws(() => betweenMarkers(SRC, "const helper", "function checkS3"), /not found after/);
});

// ---------------------------------------------------------------------------
// The standing rule.
// ---------------------------------------------------------------------------

const TREES = ["services/api/test", "services/worker/test", "apps/web/__tests__"];
// Forward windows (`src.slice(idx, idx + 3000)`, `idx + 8_000`) and backward
// windows (`src.slice(idx - 1500, idx)`).
const FIXED_WINDOW =
  /\.(slice|substring)\(\s*(?:[A-Za-z_$][\w$.]*\s*,\s*[A-Za-z_$][\w$.]*\s*\+\s*[\d_]{3,}|[A-Za-z_$][\w$.]*\s*-\s*[\d_]{3,}\s*,\s*[A-Za-z_$][\w$.]*)\s*\)/g;

function testFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) testFiles(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * Measured when the rule was introduced: 349 fixed windows in 154 files. All
 * of them now read the construct they are about, so the rule is absolute.
 */

test("no test slices source with a fixed character budget", () => {
  const hits = [];
  for (const tree of TREES) {
    for (const file of testFiles(resolve(REPO, tree))) {
      if (file.endsWith("source-contract-structure.test.mjs")) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(FIXED_WINDOW)) {
        const line = text.slice(0, m.index).split("\n").length;
        hits.push(`${file.slice(REPO.length + 1).replace(/\\/g, "/")}:${line} ${m[0]}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});
