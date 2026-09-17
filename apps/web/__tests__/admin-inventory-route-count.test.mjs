/**
 * WCC-NEW-023 / PV-INV-001 — the admin inventory sees every registration.
 *
 * `admin-inventory.mjs` stripped comments with two regexes over raw text. A
 * line comment containing the two characters that open a block comment (a
 * Batch E note about `/v1/orgs/<star>`) opened a phantom block that swallowed
 * code up to the next close: six registrations vanished (1108 -> 1102) and a
 * guard read as NONE, with nothing failing. Separately the reader accepted
 * only a string literal starting `/v1/`, so hoisted path constants and every
 * non-/v1 route were invisible — the committed inventory said 1,108 routes
 * against 1,141 `app.<method>(` call sites.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  blankComments,
  readApiRoutes,
  readRegistrations,
} from "../scripts/admin-inventory.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTES_DIR = resolve(WEB_ROOT, "..", "..", "services", "api", "src", "routes");
const OPEN = "/" + "*";
const CLOSE = "*" + "/";

test("a block-comment opener inside a line comment or a string hides no code", () => {
  const src = [
    `// org routes live under /v1/orgs${OPEN} and are gated per org`,
    `app.get("/v1/a", handlerA);`,
    `const glob = "/v1/files/${OPEN}";`,
    `app.post("/v1/b", handlerB);`,
    `${OPEN} a real block comment ${CLOSE}`,
    `app.get("/v1/c", handlerC); // trailing ${CLOSE} note`,
  ].join("\n");
  const code = blankComments(src, "fixture.ts");
  for (const path of ["/v1/a", "/v1/b", "/v1/c"]) assert.ok(code.includes(`"${path}"`), path);
  assert.ok(code.includes(`"/v1/files/${OPEN}"`), "a string is not a comment");
  assert.ok(!code.includes("a real block comment"), "a real comment is blanked");
  assert.ok(!code.includes("gated per org"), "a real line comment is blanked");
  // Offsets are preserved, so every slice and line number stays true.
  assert.equal(code.length, src.length);
  assert.equal(code.split("\n").length, src.split("\n").length);
});

test("JSX text and regex literals are code, not comments", () => {
  const src = [
    "const re = /\\/\\/ not a comment/;",
    "const el = <p>Don't stop // this is text</p>;",
    "app.get(\"/v1/d\", h);",
  ].join("\n");
  const code = blankComments(src, "fixture.tsx");
  assert.ok(code.includes("not a comment"));
  assert.ok(code.includes("this is text"));
  assert.ok(code.includes('"/v1/d"'));
});

test("registrations resolve hoisted path constants and non-/v1 paths", () => {
  const src = [
    `const AI_POLICY_PATH = "/v1/teams/ai-policy";`,
    `app.get(AI_POLICY_PATH, h);`,
    `app.post("/v2/scim/Users", h);`,
    `app.get("/healthz", h);`,
    "app.post(`/v1/incidents/:id/${action}`, h);",
    `app.get(computePath(), h);`,
  ].join("\n");
  const regs = readRegistrations(src, "fixture.ts");
  assert.deepEqual(
    regs.map((r) => `${r.method} ${r.path}`),
    [
      "get /v1/teams/ai-policy",
      "post /v2/scim/Users",
      "get /healthz",
      "post /v1/incidents/:id/${action}",
      "get null",
    ],
  );
});

function routeFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("the inventory reads every app.<method>( call site in the API", () => {
  let callSites = 0;
  let registrations = 0;
  const unresolved = [];
  for (const file of routeFiles(ROUTES_DIR)) {
    const text = readFileSync(file, "utf8");
    // Independent count: a plain regex over the comment-blanked text.
    callSites += (
      blankComments(text, file).match(/\bapp\.(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(/g) ?? []
    ).length;
    for (const r of readRegistrations(text, file)) {
      registrations += 1;
      if (r.path === null) unresolved.push(`${file}: ${r.method} ${r.firstArgument}`);
    }
  }
  assert.equal(registrations, callSites, "the syntax tree and the text agree on the call sites");
  // Every call site has a path the inventory can name.
  assert.deepEqual(unresolved, []);
  assert.ok(callSites >= 1141, `${callSites} call sites`);
});

test("the registrations the old reader could not see are in the inventory", () => {
  const routes = readApiRoutes();
  for (const key of [
    "GET /v1/evidence/:id/annotations",
    "POST /v1/evidence/bulk",
    "GET /v1/teams/ai-policy",
    "GET /healthz",
    "POST /v2/scim/Users",
  ]) {
    assert.ok(routes.has(key), key);
  }
});
