/**
 * REVIEWER CRITERIA — catalogue projections and the immutability rule.
 *
 * The load-bearing claim: a PUBLISHED set is offered NO edit. The API answers
 * 409 `published_immutable`, and a reviewer's decision is only meaningful
 * against a criteria version that cannot have changed underneath it. An edit
 * control there would not merely fail — it would suggest the record could be
 * rewritten, which is precisely what versioning exists to prevent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/reviewer-criteria.ts"), "utf8").replace(
  /^import type .*$/m,
  "",
);
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const C = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const set = (over = {}) => ({
  id: "s1",
  name: "Water damage",
  description: "Criteria for water-damage claims",
  status: "DRAFT",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  versions: [
    { id: "v1", version: 1, title: "v1", publishedAt: null, createdAt: "2026-09-01T00:00:00.000Z", criteria: [{ key: "a" }, { key: "b" }] },
  ],
  ...over,
});

/* -------------------------------------------------------------------- paths */

test("the paths address the canonical criteria endpoints", () => {
  assert.equal(C.buildCriteriaPath("t1"), "/v1/reviewer-criteria?teamId=t1");
  assert.equal(C.buildCriteriaActionPath("s1", "publish"), "/v1/reviewer-criteria/s1/publish");
  assert.equal(C.buildCriteriaUsagePath("s1", "t1"), "/v1/reviewer-criteria/s1/usage?teamId=t1");
});

/* ------------------------------------------------------------ immutability */

test("a published set is never offered an edit", () => {
  assert.equal(C.isEditable(set({ status: "PUBLISHED" })), false);
  assert.equal(C.isEditable(set({ status: "RETIRED" })), false);
  assert.equal(C.isEditable(set({ status: "DRAFT" })), true);
});

test("the actions offered are exactly the web's, per status", () => {
  // A draft publishes. It is not offered "duplicate": it is already the
  // editable thing, and a second draft of it is a copy nobody asked for.
  assert.deepEqual(C.availableActions(set({ status: "DRAFT" })), ["publish", "retire"]);
  // A published set can be duplicated into a new draft, or retired. Never
  // published again, and never edited.
  assert.deepEqual(C.availableActions(set({ status: "PUBLISHED" })), ["duplicate", "retire"]);
  // A retired set offers nothing: every action on it would be refused.
  assert.deepEqual(C.availableActions(set({ status: "RETIRED" })), []);
});

test("publishing states that it cannot be undone, before it happens", () => {
  assert.match(C.criteriaActionConsequence("publish"), /cannot be edited afterwards/i);
  assert.match(C.criteriaActionConsequence("retire"), /already made against it are unaffected/i);
  // Duplicating is reversible — it creates a draft and changes nothing else.
  assert.equal(C.criteriaActionConsequence("duplicate"), null);
});

test("the immutability 409 is recognised for what it is", () => {
  assert.equal(C.isPublishedImmutable({ statusCode: 409 }), true);
  assert.equal(C.isPublishedImmutable({ code: "published_immutable" }), true);
  assert.equal(C.isPublishedImmutable({ statusCode: 500 }), false);
});

/* ------------------------------------------------------------- projections */

test("versions are newest first, because that is the one in force", () => {
  const [s] = C.parseCriteriaSets({
    sets: [
      set({
        versions: [
          { id: "v1", version: 1, createdAt: "a" },
          { id: "v3", version: 3, createdAt: "c" },
          { id: "v2", version: 2, createdAt: "b" },
        ],
      }),
    ],
  });
  assert.deepEqual(s.versions.map((v) => v.version), [3, 2, 1]);
});

test("a set or version with no id is dropped", () => {
  const list = C.parseCriteriaSets({
    sets: [set(), { name: "nameless" }, null],
  });
  assert.equal(list.length, 1);

  const [s] = C.parseCriteriaSets({
    sets: [set({ versions: [{ version: 1 }, { id: "v2", version: 2 }] })],
  });
  assert.deepEqual(s.versions.map((v) => v.id), ["v2"]);
});

test("a criteria count comes from the rows, and an absent list is zero", () => {
  const [s] = C.parseCriteriaSets({
    sets: [set({ versions: [{ id: "v1", version: 1, criteria: [{ key: "a" }, { key: "b" }, { key: "c" }] }] })],
  });
  assert.equal(s.versions[0].criteriaCount, 3);

  const [t] = C.parseCriteriaSets({ sets: [set({ versions: [{ id: "v1", version: 1 }] })] });
  assert.equal(t.versions[0].criteriaCount, 0);
});

test("usage is newest version first and never invents a figure", () => {
  const usage = C.parseCriteriaUsage({
    usage: [
      { version: 1, runCount: 3 },
      { version: 2, runCount: 9, reviewCount: 4, reviewerCount: 2, lastUsedAt: "2026-09-01T00:00:00.000Z" },
      { runCount: 5 },
    ],
  });
  assert.deepEqual(usage.map((u) => u.version), [2, 1]);
  assert.equal(usage[1].reviewCount, 0);
  assert.equal(usage[1].lastUsedAtIso, null);
});

test("status tones and labels never render a retired set as in force", () => {
  assert.equal(C.criteriaStatusTone("PUBLISHED"), "verified");
  assert.equal(C.criteriaStatusTone("DRAFT"), "pending");
  assert.equal(C.criteriaStatusTone("RETIRED"), "neutral");
  assert.equal(C.criteriaStatusLabel("PUBLISHED"), "Published");
  assert.equal(C.criteriaStatusLabel(""), "Unknown");
});
