/**
 * Search readiness — the state model and the one eligibility predicate.
 *
 * These reproduce the two production states that started this work, and pin
 * the distinction the old count-comparison could not make: a run that is
 * progressing versus a run that stopped.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  SEARCH_INDEX_ACTIVITY_WINDOW_MS,
  SEARCH_NON_INDEXABLE_LIFECYCLE_STATES,
  deriveSearchReadiness,
  describeSearchReadiness,
  isSearchIndexableLifecycle,
  searchIndexableLifecycleSql,
  searchReadinessHasUsableResults,
  searchReadinessResultsAreComplete,
  searchReadinessShouldPoll,
} from "../dist/index.js";

const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);
const RECENT = new Date(NOW - 60_000); // one minute ago — a live run
const STALE = new Date(NOW - 6 * 60 * 60 * 1000); // six hours ago — stopped

const derive = (over) =>
  deriveSearchReadiness({
    eligibleCount: 0,
    indexedCount: 0,
    lastIndexedAtUtc: null,
    authorized: true,
    now: NOW,
    ...over,
  });

// ===========================================================================
// The eligibility predicate — one rule, two expressions
// ===========================================================================

test("only the two terminal lifecycle states are non-indexable", () => {
  assert.deepEqual(
    [...SEARCH_NON_INDEXABLE_LIFECYCLE_STATES],
    ["DESTROYED", "PENDING_DESTRUCTION"],
  );
  // Trash, archive and lock are all findable — a user has to be able to find
  // a record in order to restore it.
  for (const state of ["ACTIVE", "ARCHIVED", "LOCKED", "IN_TRASH", null, undefined]) {
    assert.equal(isSearchIndexableLifecycle(state), true, `${state} must index`);
  }
  for (const state of ["DESTROYED", "PENDING_DESTRUCTION"]) {
    assert.equal(isSearchIndexableLifecycle(state), false);
  }
  // Case-insensitive: the column is free text and has held both casings.
  assert.equal(isSearchIndexableLifecycle("destroyed"), false);
});

test("the SQL clause is emitted from the same constant, not written twice", () => {
  const sql = searchIndexableLifecycleSql("e.lifecycle_state");
  assert.equal(
    sql,
    "COALESCE(e.lifecycle_state, 'ACTIVE') NOT IN ('DESTROYED','PENDING_DESTRUCTION')",
  );
  // Every excluded state the predicate knows about appears in the clause, so
  // the counting queries and the projection builder cannot drift apart.
  for (const state of SEARCH_NON_INDEXABLE_LIFECYCLE_STATES) {
    assert.ok(sql.includes(`'${state}'`));
  }
  assert.ok(sql.includes("e.lifecycle_state"), "the caller's column is used");
});

// ===========================================================================
// 1–7. The states
// ===========================================================================

test("1. no eligible records → EMPTY_WORKSPACE", () => {
  const r = derive({ eligibleCount: 0, indexedCount: 0 });
  assert.equal(r.state, "EMPTY_WORKSPACE");
  assert.equal(r.shouldPoll, false, "nothing is coming, so nothing to watch");
  assert.equal(r.resultsAreComplete, true);
  assert.match(describeSearchReadiness(r), /No searchable records yet/);
});

test("2. eligible records, none indexed, run progressing → INITIALIZING", () => {
  const r = derive({
    eligibleCount: 393,
    indexedCount: 0,
    lastIndexedAtUtc: RECENT,
  });
  assert.equal(r.state, "INITIALIZING");
  assert.equal(r.progressing, true);
  assert.equal(r.shouldPoll, true);
  assert.equal(r.resultsAreComplete, false, "a count would be premature");
});

test("3. 175 of 393 with a live run → PARTIAL", () => {
  const r = derive({
    eligibleCount: 393,
    indexedCount: 175,
    lastIndexedAtUtc: RECENT,
  });
  assert.equal(r.state, "PARTIAL");
  assert.equal(r.outstandingCount, 218);
  assert.equal(r.shouldPoll, true);
  assert.equal(searchReadinessHasUsableResults(r.state), true);
  assert.match(
    describeSearchReadiness(r),
    /Indexing in progress — 175 of 393 records searchable/,
  );
});

test("3b. THE PRODUCTION STATE: 175 of 393 with NO run → STALLED, not PARTIAL", () => {
  // This is what the paid workspace actually was. The old classifier compared
  // two numbers, saw `indexed < eligible`, and said "still catching up" —
  // indefinitely, because nothing was catching up.
  const r = derive({
    eligibleCount: 393,
    indexedCount: 175,
    lastIndexedAtUtc: STALE,
  });
  assert.equal(r.state, "STALLED");
  assert.equal(r.progressing, false);
  assert.equal(r.outstandingCount, 218);
  assert.equal(r.shouldPoll, false, "polling a stopped job is a forever loop");
  assert.match(describeSearchReadiness(r), /not progressing/);
  assert.doesNotMatch(describeSearchReadiness(r), /moment|catching up|shortly/i);
});

test("4. everything indexed → READY, with nothing to disclose", () => {
  const r = derive({
    eligibleCount: 393,
    indexedCount: 393,
    lastIndexedAtUtc: STALE,
  });
  assert.equal(r.state, "READY");
  assert.equal(r.shouldPoll, false);
  assert.equal(r.resultsAreComplete, true);
  assert.equal(describeSearchReadiness(r), "", "READY says nothing");
});

test("4b. a stale extra document cannot read as an unfinished job", () => {
  // `indexed > eligible` happens when a record leaves the eligible population
  // before its document is removed. That is not work outstanding.
  const r = derive({ eligibleCount: 10, indexedCount: 12, lastIndexedAtUtc: STALE });
  assert.equal(r.state, "READY");
  assert.equal(r.outstandingCount, 0, "never negative");
});

test("5. THE OTHER PRODUCTION STATE: nothing indexed, no run → STALLED", () => {
  // The personal workspace. Identical defect, more extreme: not one inline
  // hook had ever fired, so the index was empty and nothing would fill it.
  // The old classifier called this `empty_index` and rendered "Search is being
  // set up. Try again in a moment." — a promise no process was keeping.
  const r = derive({
    eligibleCount: 42,
    indexedCount: 0,
    lastIndexedAtUtc: null,
  });
  assert.equal(r.state, "STALLED");
  assert.equal(r.shouldPoll, false);
  assert.doesNotMatch(describeSearchReadiness(r), /being set up|try again/i);
});

test("6. a recorded failure wins over 'is it moving' → FAILED", () => {
  const r = derive({
    eligibleCount: 393,
    indexedCount: 175,
    lastIndexedAtUtc: RECENT,
    lastRunFailedReason: "storage_unavailable",
  });
  assert.equal(r.state, "FAILED");
  assert.equal(r.failureReason, "storage_unavailable");
  assert.equal(r.shouldPoll, false, "a failed run will not fix itself");
});

test("6b. a failure reason is carried only by FAILED", () => {
  const r = derive({
    eligibleCount: 10,
    indexedCount: 10,
    lastRunFailedReason: "storage_unavailable",
  });
  assert.equal(r.state, "READY");
  assert.equal(r.failureReason, null, "a healthy state reports no failure");
});

test("7. an unauthorized actor gets RESTRICTED and no counts about the workspace", () => {
  const r = derive({
    eligibleCount: 393,
    indexedCount: 175,
    lastIndexedAtUtc: RECENT,
    authorized: false,
  });
  assert.equal(r.state, "RESTRICTED");
  // Authorization is answered BEFORE the index is described, so a refusal can
  // never be reported as a workspace that is busy indexing.
  assert.equal(r.shouldPoll, false);
  assert.doesNotMatch(describeSearchReadiness(r), /indexing|records searchable/i);
});

// ===========================================================================
// Polling and count semantics
// ===========================================================================

test("polling happens in exactly the two states that change by themselves", () => {
  const polling = ([
      "EMPTY_WORKSPACE",
      "INITIALIZING",
      "PARTIAL",
      "READY",
      "STALLED",
      "FAILED",
      "RESTRICTED",
      "UNAVAILABLE",
      "DEGRADED",
    ]
  ).filter(searchReadinessShouldPoll);
  assert.deepEqual(polling, ["INITIALIZING", "PARTIAL"]);
});

test("a result count may claim completeness only when it is complete", () => {
  assert.equal(searchReadinessResultsAreComplete("READY"), true);
  assert.equal(searchReadinessResultsAreComplete("EMPTY_WORKSPACE"), true);
  assert.equal(searchReadinessResultsAreComplete("DEGRADED"), true);
  for (const s of ["INITIALIZING", "PARTIAL", "STALLED", "FAILED", "RESTRICTED", "UNAVAILABLE"]) {
    assert.equal(searchReadinessResultsAreComplete(s), false, s);
  }
});

test("partial and stalled results stay usable — they are real, just incomplete", () => {
  assert.equal(searchReadinessHasUsableResults("PARTIAL"), true);
  assert.equal(searchReadinessHasUsableResults("STALLED"), true);
  assert.equal(searchReadinessHasUsableResults("INITIALIZING"), false);
  assert.equal(searchReadinessHasUsableResults("RESTRICTED"), false);
});

test("the activity window is the only thing separating PARTIAL from STALLED", () => {
  const base = { eligibleCount: 100, indexedCount: 50 };
  const justInside = derive({
    ...base,
    lastIndexedAtUtc: new Date(NOW - SEARCH_INDEX_ACTIVITY_WINDOW_MS + 1_000),
  });
  const justOutside = derive({
    ...base,
    lastIndexedAtUtc: new Date(NOW - SEARCH_INDEX_ACTIVITY_WINDOW_MS - 1_000),
  });
  assert.equal(justInside.state, "PARTIAL");
  assert.equal(justOutside.state, "STALLED");
});

test("readiness reads no plan, workspace name or result count", () => {
  // Two workspaces with identical index facts resolve identically, whatever
  // else is true about them. The input type has nowhere to put a plan.
  const a = derive({ eligibleCount: 5, indexedCount: 5 });
  const b = derive({ eligibleCount: 5, indexedCount: 5 });
  assert.deepEqual(a, b);
  const source = searchIndexableLifecycleSql("x");
  assert.doesNotMatch(source, /plan|tier|enterprise|personal/i);
});
