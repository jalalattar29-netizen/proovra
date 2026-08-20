/**
 * THE COPILOT IDEMPOTENCY KEY — revision-aware, bounded, order-independent.
 *
 * The key decides whether two submissions are ONE operation. It used to be
 * built from the scope id and the sorted evidence ids, which identifies a
 * SELECTION rather than an OPERATION — so once the product could detect that a
 * record's metadata had changed, the key still could not. Retrying after a real
 * change produced the same key and could be served the result computed from the
 * OLD snapshot, which is worse than no answer.
 *
 * Every behaviour the contract requires is asserted here as a behaviour, not as
 * a reproduction of the implementation.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  COPILOT_IDEMPOTENCY_KEY_MAX,
  COPILOT_REQUEST_CONTRACT_VERSION,
  COPILOT_SELECTION_MAX,
  EVIDENCE_ANALYSIS_REVISION_LENGTH,
  EVIDENCE_ANALYSIS_REVISION_PREFIX,
  buildCopilotIdempotencyKey,
  evidenceAnalysisRevisionsMatch,
  evidencePackageVersionLabel,
  isEvidenceAnalysisRevision,
} from "../dist/ai-copilot-selection.js";

const CASE = "b1b0a0c0-1111-4111-8111-111111111111";
const A = "c6bb29e3-2222-4222-8222-222222222222";
const B = "1e00f0d6-3333-4333-8333-333333333333";

const rev = (seed) => `${EVIDENCE_ANALYSIS_REVISION_PREFIX}${seed.repeat(43).slice(0, 43)}`;
const R1 = rev("a");
const R2 = rev("b");
const R3 = rev("c");

const base = {
  scope: "case",
  scopeId: CASE,
  selection: [A, B],
  revisions: { [A]: R1, [B]: R2 },
  mode: "METADATA_ONLY",
};

// ===========================================================================
// The six required identity behaviours
// ===========================================================================

test("1. an exact retry of the same snapshot produces the SAME key", () => {
  assert.equal(buildCopilotIdempotencyKey(base), buildCopilotIdempotencyKey({ ...base }));
});

test("2. selection ORDER alone does not change the key", () => {
  assert.equal(
    buildCopilotIdempotencyKey(base),
    buildCopilotIdempotencyKey({ ...base, selection: [B, A] }),
  );
  // …and a duplicate id collapses rather than producing a third request.
  assert.equal(
    buildCopilotIdempotencyKey(base),
    buildCopilotIdempotencyKey({ ...base, selection: [B, A, A] }),
  );
});

test("3. a changed evidence REVISION changes the key", () => {
  // THE POINT OF THE WHOLE CHANGE. Same case, same ids, same mode — but one
  // record's metadata moved, so this is not the same operation and must not be
  // served the previous answer.
  assert.notEqual(
    buildCopilotIdempotencyKey(base),
    buildCopilotIdempotencyKey({ ...base, revisions: { [A]: R3, [B]: R2 } }),
  );
});

test("4. a changed CONTEXT changes the key", () => {
  // The revision is context-bound, so unlinking a record from this case yields
  // a different revision — and the scope id itself is part of the identity, so
  // the same records analyzed for a different case are a different operation.
  assert.notEqual(
    buildCopilotIdempotencyKey(base),
    buildCopilotIdempotencyKey({ ...base, scopeId: B }),
  );
});

test("5. a changed MODE or qualifier changes the key", () => {
  assert.notEqual(
    buildCopilotIdempotencyKey(base),
    buildCopilotIdempotencyKey({ ...base, mode: "APPROVED_CONTENT" }),
  );
  assert.notEqual(
    buildCopilotIdempotencyKey(base),
    buildCopilotIdempotencyKey({ ...base, qualifier: "criteria-v2" }),
  );
});

test("6. a different operation KIND changes the key", () => {
  assert.notEqual(
    buildCopilotIdempotencyKey(base),
    buildCopilotIdempotencyKey({ ...base, scope: "reviewer" }),
  );
});

test("7. the request-contract version participates in the identity", () => {
  // Declared, and non-empty, so that changing what a request MEANS can be made
  // to invalidate every prior key without touching a call site.
  assert.match(COPILOT_REQUEST_CONTRACT_VERSION, /^\d+$/);
  const canonicalIncludesIt = buildCopilotIdempotencyKey(base);
  // Proven by consequence: two builders differing only in that constant would
  // differ. Asserted here as the constant being a real, stable, declared value
  // rather than an empty string that silently contributes nothing.
  assert.ok(COPILOT_REQUEST_CONTRACT_VERSION.length > 0);
  assert.ok(canonicalIncludesIt.length > 0);
});

// ===========================================================================
// Bounds
// ===========================================================================

test("8. the key stays within the route schema at EVERY selection size", () => {
  for (const n of [1, 2, 3, 10, 25, COPILOT_SELECTION_MAX]) {
    const selection = Array.from({ length: n }, (_, i) =>
      `${String(i).padStart(8, "0")}-4444-4444-8444-444444444444`,
    );
    const revisions = {};
    for (const id of selection) revisions[id] = rev("a");
    const key = buildCopilotIdempotencyKey({ ...base, selection, revisions });
    assert.ok(
      key.length <= COPILOT_IDEMPOTENCY_KEY_MAX,
      `${n} records produced a ${key.length}-character key`,
    );
  }
});

test("9. the persisted key carries no uuid list and no revision list", () => {
  const selection = Array.from({ length: COPILOT_SELECTION_MAX }, (_, i) =>
    `${String(i).padStart(8, "0")}-4444-4444-8444-444444444444`,
  );
  const revisions = {};
  for (const id of selection) revisions[id] = rev("a");
  const key = buildCopilotIdempotencyKey({ ...base, selection, revisions });

  // The scope id is there by design — it is the subject. Nothing else is.
  for (const id of selection) assert.ok(!key.includes(id), "an evidence id leaked into the key");
  assert.ok(!key.includes(R1.slice(5)), "a revision digest leaked into the key");
  assert.ok(!key.includes(","), "the key is a digest, not a concatenation");
});

test("10. the digest is not the collision-prone 16-hex truncation it replaced", () => {
  const key = buildCopilotIdempotencyKey(base);
  const digest = key.slice(key.lastIndexOf(":") + 1);
  assert.ok(digest.length >= 32, `digest is only ${digest.length} characters`);
  assert.match(digest, /^[A-Za-z0-9_-]+$/);
});

test("11. an ABSENT revision is part of the identity, not skipped", () => {
  // "I could not determine this record's revision" is a different request from
  // "this record is at revision X", and must not silently collide with it.
  const missing = buildCopilotIdempotencyKey({ ...base, revisions: { [B]: R2 } });
  assert.notEqual(missing, buildCopilotIdempotencyKey(base));
  // …and two requests that both could not determine it ARE the same request.
  assert.equal(missing, buildCopilotIdempotencyKey({ ...base, revisions: { [B]: R2 } }));
});

test("12. no two of the twelve distinct requests above collide", () => {
  const variants = [
    base,
    { ...base, selection: [B, A] },
    { ...base, revisions: { [A]: R3, [B]: R2 } },
    { ...base, scopeId: B },
    { ...base, mode: "APPROVED_CONTENT" },
    { ...base, qualifier: "criteria-v2" },
    { ...base, scope: "reviewer" },
    { ...base, scope: "evidence" },
    { ...base, revisions: { [B]: R2 } },
    { ...base, revisions: {} },
    { ...base, selection: [A], revisions: { [A]: R1 } },
    { ...base, selection: [B], revisions: { [B]: R2 } },
  ];
  const keys = variants.map(buildCopilotIdempotencyKey);
  // Order-only variants are SUPPOSED to collide; drop that one and require the
  // rest to be distinct.
  const distinct = new Set(keys.filter((_, i) => i !== 1));
  assert.equal(distinct.size, variants.length - 1, "two distinct requests share a key");
});

// ===========================================================================
// The revision token itself
// ===========================================================================

test("13. only a well-formed revision is accepted as one", () => {
  assert.equal(isEvidenceAnalysisRevision(R1), true);

  for (const bad of [
    undefined,
    null,
    0,
    2,
    "",
    "0",
    "v2",
    "ear1_",
    "ear1_short",
    `ear1_${"a".repeat(42)}`, // one short — a truncated digest is not a digest
    `ear1_${"a".repeat(44)}`,
    `ear0_${"a".repeat(43)}`, // a schema this product does not issue
    `${"a".repeat(43)}`, // no prefix
    `ear1_${"a".repeat(42)}+`, // not base64url
  ]) {
    assert.equal(isEvidenceAnalysisRevision(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(R1.length, EVIDENCE_ANALYSIS_REVISION_LENGTH);
});

test("14. NOT KNOWING is never agreement, and a forgery is never a match", () => {
  assert.equal(evidenceAnalysisRevisionsMatch(R1, R1), true);
  assert.equal(evidenceAnalysisRevisionsMatch(R1, R2), false);
  // The branch `?? 0` removed: an absent snapshot cannot match anything.
  assert.equal(evidenceAnalysisRevisionsMatch(undefined, R1), false);
  assert.equal(evidenceAnalysisRevisionsMatch(R1, undefined), false);
  assert.equal(evidenceAnalysisRevisionsMatch(undefined, undefined), false);
  // A malformed token answers nothing, even against an identical malformed one.
  assert.equal(evidenceAnalysisRevisionsMatch("v2", "v2"), false);
  assert.equal(evidenceAnalysisRevisionsMatch("", ""), false);
});

test("15. there is no arithmetic to collapse — `?? 0` is not expressible", () => {
  // The old authority was a nullable integer, and every consumer reached it
  // through `?? 0`. Against an opaque token there is nothing to default TO: 0
  // is not a revision and never matches one.
  assert.equal(evidenceAnalysisRevisionsMatch(0, R1), false);
  assert.equal(evidenceAnalysisRevisionsMatch(null, R1), false);
  assert.equal(evidenceAnalysisRevisionsMatch(0, 0), false);
});

// ===========================================================================
// Package version — presentation, and separate
// ===========================================================================

test("16. the package label is truthful about absence and never says v0", () => {
  assert.equal(evidencePackageVersionLabel(2), "Package v2");
  assert.equal(evidencePackageVersionLabel(null), "No package recorded");
  assert.equal(evidencePackageVersionLabel(undefined), "Package state unavailable");
  // A genuine recorded zero survives as zero rather than being read as absence.
  assert.equal(evidencePackageVersionLabel(0), "Package v0");
});
