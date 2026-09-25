/**
 * Trust Center projections — behavioural.
 *
 * The property under test is that a TRUST surface never overstates. A section
 * that could not be read, one that is plan-locked, and one that is genuinely
 * empty are three different facts, and collapsing them is how a trust page ends
 * up implying "we publish nothing" when it actually means "we could not check".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/trust-center.ts"), "utf8").replace(
  /^import type .*$/m,
  "",
);
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const T = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const article = (over = {}) => ({
  id: "a1",
  slug: "how-we-verify",
  title: "How we verify",
  summary: "What the platform checks.",
  body: "Full text.",
  version: 3,
  updatedAtUtc: "2026-02-01T00:00:00.000Z",
  status: "PUBLISHED",
  ...over,
});

test("the five canonical article kinds are covered", () => {
  assert.deepEqual(
    T.TRUST_SECTIONS.map((s) => s.kind),
    ["METHODOLOGY", "SECURITY", "AI_DISCLOSURE", "SUBPROCESSOR", "STATUS"],
  );
  // Each names the web route it ports, so the mapping is checkable.
  for (const s of T.TRUST_SECTIONS) {
    assert.match(s.webRoute, /^\/trust-center/);
  }
});

test("published articles are projected with their version and date", () => {
  const state = T.parseTrustArticles({ articles: [article()] });
  assert.equal(state.phase, "loaded");
  assert.equal(state.articles[0].title, "How we verify");
  assert.equal(state.articles[0].version, 3);
  assert.equal(state.articles[0].updatedAtIso, "2026-02-01T00:00:00.000Z");
});

test("a DRAFT or DEPRECATED article is never shown as the trust position", () => {
  // An unpublished claim on a trust surface is worse than showing nothing.
  const state = T.parseTrustArticles({
    articles: [article({ status: "DRAFT" }), article({ id: "a2", status: "DEPRECATED" })],
  });
  assert.equal(state.phase, "empty");
});

test("a degraded read is NOT rendered as empty", () => {
  const state = T.parseTrustArticles({ degraded: true, reason: "ARTICLE_READ_FAILED" });
  assert.equal(state.phase, "degraded");
  assert.equal(state.reason, "ARTICLE_READ_FAILED");
});

test("a degraded read with no reason still carries one", () => {
  assert.equal(T.parseTrustArticles({ degraded: true }).reason, "ARTICLE_READ_FAILED");
});

test("an entitlement denial is a product state, not an error", () => {
  assert.equal(T.parseTrustArticles({ denial: "ENTITLEMENT_REQUIRED" }).phase, "locked");
  assert.equal(T.isEntitlementDenial({ status: 403 }), true);
  assert.equal(T.isEntitlementDenial({ body: { denial: "ENTITLEMENT_REQUIRED" } }), true);
  assert.equal(T.isEntitlementDenial({ status: 500 }), false);
  assert.equal(T.isEntitlementDenial(null), false);
});

test("a genuinely empty section reads as empty", () => {
  assert.equal(T.parseTrustArticles({ articles: [] }).phase, "empty");
  assert.equal(T.parseTrustArticles({}).phase, "empty");
  assert.equal(T.parseTrustArticles(null).phase, "empty");
});

test("a malformed article degrades to safe defaults rather than throwing", () => {
  const state = T.parseTrustArticles({ articles: [{ status: "PUBLISHED" }] });
  assert.equal(state.phase, "loaded");
  assert.equal(state.articles[0].title, "Untitled");
  assert.equal(state.articles[0].version, null, "an absent version is not 0");
});

test("the request names the kind and encodes it", () => {
  assert.equal(T.buildTrustArticlesPath("METHODOLOGY"), "/v1/trust/articles?kind=METHODOLOGY");
  assert.ok(T.buildTrustArticlesPath("A B").includes("A%20B"));
});

test("section tone distinguishes the three failure-shaped states", () => {
  assert.equal(T.trustSectionTone({ phase: "degraded", reason: "x" }), "risk");
  assert.equal(T.trustSectionTone({ phase: "locked" }), "governance");
  assert.equal(T.trustSectionTone({ phase: "empty" }), "neutral");
  assert.equal(T.trustSectionTone({ phase: "loaded", articles: [] }), "verified");
});

test("an article's publication state is read from the server's `state`", () => {
  // trust-center.service.ts projects `state`; reading `status` defaulted every
  // article to PUBLISHED, so DRAFT and DEPRECATED ones were shown as trust content.
  const out = T.parseTrustArticles({
    articles: [
      { id: "a1", slug: "a1", title: "Published", state: "PUBLISHED", version: 2 },
      { id: "a2", slug: "a2", title: "Draft", state: "DRAFT", version: 1 },
      { id: "a3", slug: "a3", title: "Old", state: "DEPRECATED", version: 4 },
    ],
  });
  assert.equal(out.phase, "loaded");
  assert.deepEqual(out.articles.map((a) => a.title), ["Published"]);
});
