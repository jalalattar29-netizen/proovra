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

/* ------------------------------------------------- authoring a draft version */

const row = (over = {}) => ({ key: "k", title: "t", required: false, reviewGuidance: "", ...over });

test("the authoring paths are the canonical ones", () => {
  assert.equal(C.CRITERIA_CREATE_PATH, "/v1/reviewer-criteria");
  assert.equal(C.buildCriteriaDraftPath("s1"), "/v1/reviewer-criteria/s1/draft");
  assert.equal(C.buildCriteriaSetPath("s1", "t1"), "/v1/reviewer-criteria/s1?teamId=t1");
});

test("the draft state carries the concurrency token and whether it is published", () => {
  const d = C.parseDraftState({
    set: {
      updatedAt: "2026-09-20T10:00:00.000Z",
      versions: [
        {
          version: 3,
          title: "Baseline",
          publishedAt: null,
          criteria: [{ key: "a", title: "A", required: true, reviewGuidance: "look" }],
        },
      ],
    },
  });
  assert.equal(d.updatedAtIso, "2026-09-20T10:00:00.000Z");
  assert.equal(d.latestPublished, false);
  assert.equal(d.version, 3);
  assert.deepEqual(d.rows, [{ key: "a", title: "A", required: true, reviewGuidance: "look" }]);
});

test("a published latest version is reported as published", () => {
  const d = C.parseDraftState({
    set: { updatedAt: "x", versions: [{ version: 1, publishedAt: "2026-09-01T00:00:00.000Z", criteria: [] }] },
  });
  assert.equal(d.latestPublished, true);
});

test("a set with no versions has no draft state", () => {
  assert.equal(C.parseDraftState({ set: { versions: [] } }), null);
  assert.equal(C.parseDraftState({}), null);
});

test("the validator states which row is wrong, not just that something is", () => {
  assert.match(C.validateDraft("", [row()]), /title/i);
  assert.match(C.validateDraft("t", []), /at least one/i);
  assert.match(C.validateDraft("t", [row({ key: "" })]), /Criterion 1 needs a key/);
  assert.match(C.validateDraft("t", [row(), row({ key: "k2", title: "" })]), /Criterion 2 needs a title/);
  assert.equal(C.validateDraft("t", [row()]), null);
});

test("two criteria cannot share a key", () => {
  // Rows live under one version; a duplicate key makes a reviewer's recorded
  // answers ambiguous after the fact, which is what a version exists to stop.
  assert.match(C.validateDraft("t", [row({ key: "a" }), row({ key: "a" })]), /used twice/);
});

test("the route bounds are enforced before the request", () => {
  assert.match(C.validateDraft("x".repeat(161), [row()]), /160/);
  assert.match(C.validateDraft("t", [row({ key: "k".repeat(61) })]), /60/);
  assert.match(C.validateDraft("t", [row({ title: "x".repeat(201) })]), /200/);
  assert.match(C.validateDraft("t", [row({ reviewGuidance: "x".repeat(601) })]), /600/);
  assert.match(C.validateDraft("t", Array.from({ length: 51 }, (_, i) => row({ key: `k${i}` }))), /50/);
});

test("order is the row position, and empty guidance is absent", () => {
  const body = C.buildDraftBody("t1", " Base ", [row({ key: "a" }), row({ key: "b" })], null);
  assert.equal(body.title, "Base");
  assert.deepEqual(body.criteria.map((c) => c.order), [0, 1]);
  assert.equal("reviewGuidance" in body.criteria[0], false);
  assert.equal("expectedUpdatedAt" in body, false);
});

test("the concurrency token is sent whenever it is known", () => {
  // Omitting it skips the check entirely, so a save could land on state it was
  // never written against.
  const body = C.buildDraftBody("t1", "T", [row()], "2026-09-20T10:00:00.000Z");
  assert.equal(body.expectedUpdatedAt, "2026-09-20T10:00:00.000Z");
});

test("the two 409s are told apart, because they need opposite recoveries", () => {
  assert.equal(C.classifyDraftFailure({ statusCode: 409, code: "draft_conflict" }), "CONFLICT");
  assert.equal(
    C.classifyDraftFailure({ statusCode: 409, code: "published_immutable" }),
    "PUBLISHED_IMMUTABLE",
  );
  // The code can also arrive nested in the error details.
  assert.equal(
    C.classifyDraftFailure({ statusCode: 409, details: { error: { code: "published_immutable" } } }),
    "PUBLISHED_IMMUTABLE",
  );
  assert.equal(C.classifyDraftFailure({ statusCode: 403 }), "FORBIDDEN");
  assert.equal(C.classifyDraftFailure({ statusCode: 404 }), "NOT_FOUND");
  assert.equal(C.classifyDraftFailure({ statusCode: 500 }), "UNKNOWN");
});

test("an unlabelled 409 is treated as the recoverable one", () => {
  // Reloading a version that turns out to be published is harmless; assuming
  // immutability would strand a draft that was still editable.
  assert.equal(C.classifyDraftFailure({ statusCode: 409 }), "CONFLICT");
});

test("every failure says what was NOT saved, or what to do instead", () => {
  assert.match(C.draftFailureMessage("CONFLICT"), /not saved/i);
  assert.match(C.draftFailureMessage("PUBLISHED_IMMUTABLE"), /duplicate/i);
  assert.match(C.draftFailureMessage("FORBIDDEN"), /owners and admins/i);
});

test("saving as a new draft is offered only after a publish", () => {
  // After an ordinary edit there is nothing to duplicate.
  assert.equal(C.canSaveAsNewDraft({ latestPublished: true, rows: [] }), true);
  assert.equal(C.canSaveAsNewDraft({ latestPublished: false, rows: [] }), false);
  assert.equal(C.canSaveAsNewDraft(null), false);
});

test("the comparison shows only rows whose text actually differs", () => {
  const mine = [row({ key: "a", title: "Mine" }), row({ key: "b", title: "Same" })];
  const theirs = [row({ key: "a", title: "Theirs" }), row({ key: "b", title: "Same" })];
  assert.deepEqual(C.diffDraftRows(mine, theirs), [{ key: "a", mine: "Mine", theirs: "Theirs" }]);
});

test("a row removed on one side shows as removed, not as missing", () => {
  const d = C.diffDraftRows([row({ key: "a", title: "Kept" })], []);
  assert.deepEqual(d, [{ key: "a", mine: "Kept", theirs: null }]);
});

/* ------------------------------------------------------- creating a new set */

test("the set name and the version title are kept apart", () => {
  // The route takes both; collapsing them puts the wrong text on the version.
  const body = C.buildCreateSetBody("t1", " Intake ", "  ", " Baseline ", [row()]);
  assert.equal(body.name, "Intake");
  assert.equal(body.title, "Baseline");
  assert.equal("description" in body, false);
  assert.equal(body.criteria.length, 1);
});

test("creating reuses the version rules rather than restating them", () => {
  assert.match(C.validateNewSet("", "t", [row()]), /name/i);
  assert.match(C.validateNewSet("n".repeat(161), "t", [row()]), /160/);
  // The row failure is the draft validator speaking, word for word.
  assert.equal(C.validateNewSet("n", "t", [row({ key: "" })]), C.validateDraft("t", [row({ key: "" })]));
  assert.equal(C.validateNewSet("n", "t", [row()]), null);
});

test("the list's criteria count is the server's `_count.criteria`", () => {
  // GET /v1/reviewer-criteria selects the latest version with _count.criteria —
  // not the criteria rows — so counting rows always said "0 criteria".
  const sets = C.parseCriteriaSets({
    sets: [{ id: "s1", name: "Water damage", status: "PUBLISHED", versions: [{ id: "v3", version: 3, title: "v3", publishedAt: "2026-09-01T00:00:00.000Z", _count: { criteria: 7 } }] }],
  });
  assert.equal(sets[0].versions[0].criteriaCount, 7);
});
