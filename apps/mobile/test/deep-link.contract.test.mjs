/**
 * PHASE 11 §5 — mobile deep-link contract/behavior tests (node:test runner).
 *
 * Drives the REAL canonical client authority (src/deep-link.ts, compiled on
 * the fly via the TS in-memory transpilation below is unnecessary — the module
 * is dependency-injected pure TS; we test its transpiled behavior through
 * tsx-free direct source evaluation using the TypeScript compiler API would be
 * heavy, so the source is loaded via a tiny strip-types transform).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { Module } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "../src/deep-link.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = new Module("deep-link");
mod._compile(js, "deep-link.cjs");
const {
  parseCanonicalMobileDeepLink,
  resolveMobileDeepLink,
  __resetDeepLinkGeneration,
} = mod.exports;

const idle = () => false;

test("parses ONLY the canonical shapes; workspace/team query params are discarded", () => {
  const a = parseCanonicalMobileDeepLink("https://app.proovra.com/evidence/ev-1?workspace=team-EVIL&team=x");
  assert.deepEqual(a, { resourceType: "evidence", resourceId: "ev-1", route: "/(stack)/evidence/ev-1" });
  const b = parseCanonicalMobileDeepLink("proovra://cases/case-9");
  assert.deepEqual(b, { resourceType: "cases", resourceId: "case-9", route: "/(stack)/case/case-9" });
});

test("unsupported families/schemes/shapes fail SAFELY (null → ignored)", () => {
  for (const bad of [
    "https://app.proovra.com/admin/secret", // unknown family
    "https://app.proovra.com/evidence", // missing id
    "https://app.proovra.com/evidence/a/b", // extra segments
    "javascript:alert(1)", // hostile scheme
    "notaurl", // unparseable
    "ftp://x/evidence/e", // wrong scheme
  ]) {
    assert.equal(parseCanonicalMobileDeepLink(bad), null, bad);
  }
});

test("valid destination: SERVER approval first, navigation uses the SERVER workspace", async () => {
  __resetDeepLinkGeneration();
  const calls = [];
  const out = await resolveMobileDeepLink("https://app.proovra.com/evidence/ev-1?team=SPOOF", {
    resolve: async (input) => {
      calls.push(input);
      return { ok: true, workspaceId: "team-SERVER" };
    },
    hasActiveWork: idle,
  });
  assert.deepEqual(out, { status: "navigate", route: "/(stack)/evidence/ev-1", workspaceId: "team-SERVER" });
  // The resolver was asked about the RESOURCE only — no URL tenant forwarded.
  assert.deepEqual(calls, [{ resourceType: "evidence", resourceId: "ev-1" }]);
});

test("server denial (anti-enum 404: wrong workspace / revoked membership / suspended org) → ONE generic denied", async () => {
  __resetDeepLinkGeneration();
  const out = await resolveMobileDeepLink("proovra://evidence/ev-hidden", {
    resolve: async () => {
      throw new Error("404");
    },
    hasActiveWork: idle,
  });
  assert.deepEqual(out, { status: "denied" });
});

test("a non-ok resolver response is DENIED, never navigated (no client inference)", async () => {
  __resetDeepLinkGeneration();
  const out = await resolveMobileDeepLink("proovra://evidence/ev-1", {
    resolve: async () => ({ ok: false }),
    hasActiveWork: idle,
  });
  assert.deepEqual(out, { status: "denied" });
});

test("active capture/upload BLOCKS the transition before any server call", async () => {
  __resetDeepLinkGeneration();
  let resolverCalled = false;
  const out = await resolveMobileDeepLink("proovra://evidence/ev-1", {
    resolve: async () => {
      resolverCalled = true;
      return { ok: true, workspaceId: "t" };
    },
    hasActiveWork: () => true,
  });
  assert.deepEqual(out, { status: "blocked_busy" });
  assert.equal(resolverCalled, false);
});

test("a STALE resolution (superseded by a newer link) is discarded — no post-switch mutation", async () => {
  __resetDeepLinkGeneration();
  let releaseFirst;
  const first = resolveMobileDeepLink("proovra://evidence/ev-OLD", {
    resolve: () => new Promise((res) => { releaseFirst = res; }),
    hasActiveWork: idle,
  });
  const second = await resolveMobileDeepLink("proovra://evidence/ev-NEW", {
    resolve: async () => ({ ok: true, workspaceId: "t2" }),
    hasActiveWork: idle,
  });
  assert.equal(second.status, "navigate");
  releaseFirst({ ok: true, workspaceId: "t1" });
  const firstOut = await first;
  assert.deepEqual(firstOut, { status: "stale" }); // late result never navigates
});

test("no open redirect: only closed in-app routes are ever produced", () => {
  const parsed = parseCanonicalMobileDeepLink("https://app.proovra.com/evidence/..%2F..%2Fevil");
  // The id is encoded into the route — it can never escape the route prefix.
  assert.ok(parsed === null || parsed.route.startsWith("/(stack)/evidence/"));
});
