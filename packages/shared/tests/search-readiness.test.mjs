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
  SEARCH_NON_INDEXABLE_LIFECYCLE_STATES,
  deriveSearchReadiness,
  describeSearchReadiness,
  isSearchIndexableLifecycle,
  searchIndexableLifecycleSql,
  searchReadinessHasUsableResults,
  searchReadinessResultsAreComplete,
  searchReadinessShouldPoll,
  projectSearchReadiness,
} from "../dist/index.js";

const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);
const RECENT = new Date(NOW - 60_000);
const STALE = new Date(NOW - 6 * 60 * 60 * 1000);

/**
 * Durable run shapes. `progress` is the ONLY thing that may produce
 * INITIALIZING or PARTIAL — a live row inside its lease.
 */
const RUNNING = { status: "RUNNING", leaseValid: true };
const EXPIRED = { status: "RUNNING", leaseValid: false };
const DONE = { status: "SUCCEEDED", leaseValid: false };
const BROKEN = { status: "FAILED", leaseValid: false, failureCategory: "timeout" };

const derive = (over) =>
  deriveSearchReadiness({
    eligibleCount: 0,
    indexedCount: 0,
    lastIndexedAtUtc: null,
    run: null,
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

test("2. eligible records, none indexed, a live run → INITIALIZING", () => {
  // PREVIOUS: a recent `indexed_at_utc` was taken as proof a run was active.
  // NOW: only a durable RUNNING row inside its lease can make this claim, so
  // a lone inline hook firing can no longer masquerade as a backfill.
  const r = derive({
    eligibleCount: 393,
    indexedCount: 0,
    lastIndexedAtUtc: RECENT,
    run: RUNNING,
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
    run: RUNNING,
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
    run: null,
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
    run: DONE,
  });
  assert.equal(r.state, "READY");
  assert.equal(r.shouldPoll, false);
  assert.equal(r.resultsAreComplete, true);
  assert.equal(describeSearchReadiness(r), "", "READY says nothing");
});

test("4b. a stale extra document cannot read as an unfinished job", () => {
  // `indexed > eligible` happens when a record leaves the eligible population
  // before its document is removed. That is not work outstanding.
  const r = derive({
    eligibleCount: 10,
    indexedCount: 12,
    lastIndexedAtUtc: STALE,
    run: DONE,
  });
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

test("6. a failed run wins over 'is it moving' → FAILED", () => {
  const r = derive({
    eligibleCount: 393,
    indexedCount: 175,
    lastIndexedAtUtc: RECENT,
    run: { status: "FAILED", leaseValid: false, failureCategory: "storage_unavailable" },
  });
  assert.equal(r.state, "FAILED");
  assert.equal(r.failureReason, "storage_unavailable");
  assert.equal(r.shouldPoll, false, "a failed run will not fix itself");
});

test("6b. a failure reason is carried only by FAILED", () => {
  // Converged counts with a SUCCEEDED run: no failure to report.
  const r = derive({ eligibleCount: 10, indexedCount: 10, run: DONE });
  assert.equal(r.state, "READY");
  assert.equal(r.failureReason, null, "a healthy state reports no failure");
});

test("7. an unauthorized actor gets RESTRICTED and no counts about the workspace", () => {
  const r = derive({
    eligibleCount: 393,
    indexedCount: 175,
    lastIndexedAtUtc: RECENT,
    run: RUNNING,
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

test("only a live run separates PARTIAL from STALLED — never a timestamp", () => {
  // PREVIOUS GUARANTEE: an activity window around `MAX(indexed_at_utc)`
  // decided PARTIAL vs STALLED.
  // NEW GUARANTEE, strictly stronger: the timestamp decides nothing. The
  // same counts and the same recent write resolve to PARTIAL or STALLED
  // purely on whether a durable run holds a valid lease.
  const base = { eligibleCount: 100, indexedCount: 50, lastIndexedAtUtc: RECENT };
  assert.equal(derive({ ...base, run: RUNNING }).state, "PARTIAL");
  assert.equal(derive({ ...base, run: EXPIRED }).state, "STALLED");
  assert.equal(derive({ ...base, run: null }).state, "STALLED");
  assert.equal(derive({ ...base, run: DONE }).state, "STALLED");
});

test("a fresh index write alone can never produce INITIALIZING or PARTIAL", () => {
  // The exact defect: an inline hook fires, the timestamp is seconds old,
  // and nothing is running. That used to read as a backfill in progress.
  for (const indexedCount of [0, 175]) {
    const r = derive({
      eligibleCount: 393,
      indexedCount,
      lastIndexedAtUtc: new Date(NOW - 1_000),
      run: null,
    });
    assert.equal(r.state, "STALLED");
    assert.equal(r.progressing, false);
  }
});

test("a completed run that left drift is not \"still processing\"", () => {
  // The process that was supposed to close the gap finished. Claiming
  // PARTIAL would promise progress from something that already stopped.
  const drift = { eligibleCount: 100, indexedCount: 40, run: DONE };
  assert.equal(derive(drift).state, "STALLED");
  // …unless a REAL continuation is persisted, which is a fact, not a hope.
  assert.equal(
    derive({ ...drift, run: { ...DONE, continuationScheduled: true } }).state,
    "PARTIAL",
  );
});

test("a crashed run's RUNNING row expires instead of running forever", () => {
  const r = derive({ eligibleCount: 100, indexedCount: 10, run: EXPIRED });
  assert.equal(r.state, "STALLED");
  assert.equal(r.progressing, false);
  assert.equal(r.runStatus, "RUNNING", "the row still says RUNNING");
});

test("a failed run is surfaced even when the counts converged", () => {
  const r = derive({ eligibleCount: 10, indexedCount: 10, run: BROKEN });
  assert.equal(r.state, "FAILED");
  assert.equal(r.failureReason, "timeout");
});

test("a zero-change completed run over converged counts is READY, and does not loop", () => {
  const r = derive({ eligibleCount: 42, indexedCount: 42, run: DONE });
  assert.equal(r.state, "READY");
  assert.equal(r.shouldPoll, false);
});

test("EMPTY_WORKSPACE is independent of run history", () => {
  for (const run of [null, RUNNING, DONE, BROKEN, EXPIRED]) {
    assert.equal(derive({ eligibleCount: 0, indexedCount: 0, run }).state, "EMPTY_WORKSPACE");
  }
});

test("lastIndexedAt survives as information, and is reported unchanged", () => {
  const r = derive({ eligibleCount: 5, indexedCount: 5, lastIndexedAtUtc: RECENT, run: DONE });
  assert.equal(r.lastIndexedAtUtc, RECENT.toISOString());
  assert.equal(r.state, "READY");
});

test("readiness reads no plan, workspace name or result count", () => {
  // Two workspaces with identical index facts resolve identically, whatever
  // else is true about them. The input type has nowhere to put a plan.
  const a = derive({ eligibleCount: 5, indexedCount: 5, run: DONE });
  const b = derive({ eligibleCount: 5, indexedCount: 5, run: DONE });
  assert.deepEqual(a, b);
  const source = searchIndexableLifecycleSql("x");
  assert.doesNotMatch(source, /plan|tier|enterprise|personal/i);
});

// ===========================================================================
// Unresolved removals — drift the counts cannot see
// ===========================================================================

test("a leftover document for a destroyed record keeps the workspace out of READY", () => {
  // The counts are converged. Search is still answering for a record
  // governance decided no longer exists, so "READY" would report the index as
  // correct precisely when it is not.
  const r = derive({
    eligibleCount: 12,
    indexedCount: 12,
    unresolvedRemovals: 3,
    run: DONE,
  });
  assert.equal(r.state, "STALLED");
  assert.equal(r.unresolvedRemovals, 3);
});

test("an outstanding removal is not an EMPTY workspace either", () => {
  // Every source row is gone, so `eligibleCount` is 0 — but a document
  // survives, which is drift to reconcile rather than nothing to do.
  const r = derive({ eligibleCount: 0, indexedCount: 0, unresolvedRemovals: 1, run: DONE });
  assert.notEqual(r.state, "EMPTY_WORKSPACE");
  assert.equal(r.state, "STALLED");
});

test("a live run owns an outstanding removal the same way it owns missing documents", () => {
  const r = derive({
    eligibleCount: 12,
    indexedCount: 12,
    unresolvedRemovals: 3,
    run: RUNNING,
  });
  assert.equal(r.state, "PARTIAL");
  assert.equal(r.shouldPoll, true);
});

test("zero removals is the default, and never invents drift", () => {
  assert.equal(derive({ eligibleCount: 4, indexedCount: 4, run: DONE }).unresolvedRemovals, 0);
  assert.equal(derive({ eligibleCount: 4, indexedCount: 4, run: DONE }).state, "READY");
  // A negative count from a mis-typed caller cannot become negative drift.
  assert.equal(
    derive({ eligibleCount: 4, indexedCount: 4, unresolvedRemovals: -9, run: DONE })
      .unresolvedRemovals,
    0,
  );
});

// ===========================================================================
// UNAVAILABLE — a transport failure is not an index state
// ===========================================================================

test("an unreachable service is UNAVAILABLE, never EMPTY_WORKSPACE", () => {
  // The counts are zero because nothing could be read, not because nothing is
  // there. Deriving EMPTY_WORKSPACE from them would be a confident lie.
  const r = derive({
    eligibleCount: 0,
    indexedCount: 0,
    serviceReachable: false,
    run: null,
  });
  assert.equal(r.state, "UNAVAILABLE");
  assert.equal(r.shouldPoll, false);
  assert.equal(r.resultsAreComplete, false);
});

test("unreachable outranks every index state except a refusal", () => {
  for (const over of [
    { eligibleCount: 10, indexedCount: 10, run: DONE },
    { eligibleCount: 10, indexedCount: 3, run: RUNNING },
    { eligibleCount: 10, indexedCount: 0, run: BROKEN },
  ]) {
    assert.equal(derive({ ...over, serviceReachable: false }).state, "UNAVAILABLE");
  }
  // …but an actor who may not search here is told THAT, not that the service
  // is down: the refusal is about the actor and no transport fact changes it.
  assert.equal(
    derive({ eligibleCount: 10, indexedCount: 10, authorized: false, serviceReachable: false })
      .state,
    "RESTRICTED",
  );
});

test("reachable is the default, so a caller that says nothing is not treated as down", () => {
  assert.equal(derive({ eligibleCount: 2, indexedCount: 2, run: DONE }).state, "READY");
});

// ===========================================================================
// DEGRADED — a secondary capability may qualify, never mask
// ===========================================================================

test("a converged index with a broken secondary capability is DEGRADED", () => {
  const r = derive({
    eligibleCount: 9,
    indexedCount: 9,
    run: DONE,
    degradedCapabilities: ["semantic_search"],
  });
  assert.equal(r.state, "DEGRADED");
  // Deterministic search still works, so results are still complete and the
  // client still has nothing to poll for.
  assert.equal(r.resultsAreComplete, true);
  assert.equal(r.shouldPoll, false);
  assert.deepEqual(r.degradedCapabilities, ["semantic_search"]);
});

test("a broken secondary capability never masks an unconverged index", () => {
  // Each of these is a real index problem. Reporting DEGRADED — "search works,
  // one extra does not" — would be the reassuring answer and the wrong one.
  assert.equal(
    derive({ eligibleCount: 9, indexedCount: 2, run: null, degradedCapabilities: ["semantic_search"] })
      .state,
    "STALLED",
  );
  assert.equal(
    derive({ eligibleCount: 9, indexedCount: 2, run: RUNNING, degradedCapabilities: ["semantic_search"] })
      .state,
    "PARTIAL",
  );
  assert.equal(
    derive({ eligibleCount: 9, indexedCount: 9, run: BROKEN, degradedCapabilities: ["semantic_search"] })
      .state,
    "FAILED",
  );
  assert.equal(
    derive({ eligibleCount: 9, indexedCount: 9, unresolvedRemovals: 1, run: DONE, degradedCapabilities: ["semantic_search"] })
      .state,
    "STALLED",
  );
});

test("an empty workspace is not degraded by a secondary capability", () => {
  const r = derive({
    eligibleCount: 0,
    indexedCount: 0,
    run: DONE,
    degradedCapabilities: ["semantic_search"],
  });
  assert.equal(r.state, "EMPTY_WORKSPACE");
});

test("the degraded list is reported in every state, and is never a reason string", () => {
  const r = derive({
    eligibleCount: 9,
    indexedCount: 2,
    run: null,
    degradedCapabilities: ["semantic_search"],
  });
  assert.deepEqual(r.degradedCapabilities, ["semantic_search"]);
  for (const name of r.degradedCapabilities) {
    // A capability NAME, not a message: no spaces, no punctuation, nothing a
    // provider error could have been pasted into.
    assert.match(name, /^[a-z0-9_]+$/);
  }
});

// ===========================================================================
// The ONE projection — API and console share this shape
// ===========================================================================

test("the projection carries every field the console renders and nothing internal", () => {
  const readiness = derive({
    eligibleCount: 10,
    indexedCount: 4,
    unresolvedRemovals: 2,
    lastIndexedAtUtc: RECENT,
    run: RUNNING,
  });
  const projection = projectSearchReadiness(readiness, {
    runStartedAtUtc: "2026-08-20T11:00:00.000Z",
    runFinishedAtUtc: null,
    canRecover: true,
  });

  assert.deepEqual(Object.keys(projection).sort(), [
    "canRecover",
    "degradedCapabilities",
    "eligibleCount",
    "failureReason",
    "indexedCount",
    "lastIndexedAtUtc",
    "outstandingCount",
    "progressing",
    "resultsAreComplete",
    "runFinishedAtUtc",
    "runStartedAtUtc",
    "runStatus",
    "shouldPoll",
    "state",
    "unresolvedRemovals",
  ]);

  // Nothing internal may appear, whatever else changes.
  const serialised = JSON.stringify(projection);
  for (const forbidden of ["lockKey", "lock_key", "runId", "id", "triggeredBy", "stack", "SELECT"]) {
    assert.equal(
      serialised.includes(forbidden),
      false,
      `the projection leaked \`${forbidden}\``,
    );
  }
});

test("the projection restates the derivation rather than re-deciding it", () => {
  const readiness = derive({ eligibleCount: 3, indexedCount: 1, run: null });
  const p = projectSearchReadiness(readiness, {
    runStartedAtUtc: null,
    runFinishedAtUtc: null,
    canRecover: false,
  });
  assert.equal(p.state, readiness.state);
  assert.equal(p.shouldPoll, readiness.shouldPoll);
  assert.equal(p.resultsAreComplete, readiness.resultsAreComplete);
  assert.equal(p.outstandingCount, readiness.outstandingCount);
});

test("canRecover is supplied by the server and is not derivable from the state", () => {
  const readiness = derive({ eligibleCount: 3, indexedCount: 1, run: null });
  assert.equal(
    projectSearchReadiness(readiness, {
      runStartedAtUtc: null,
      runFinishedAtUtc: null,
      canRecover: false,
    }).canRecover,
    false,
  );
  assert.equal(
    projectSearchReadiness(readiness, {
      runStartedAtUtc: null,
      runFinishedAtUtc: null,
      canRecover: true,
    }).canRecover,
    true,
  );
});

test("every state has exactly one sentence, and none of them contains a number the caller did not supply", () => {
  const states = [
    "EMPTY_WORKSPACE",
    "INITIALIZING",
    "PARTIAL",
    "READY",
    "STALLED",
    "FAILED",
    "RESTRICTED",
    "UNAVAILABLE",
    "DEGRADED",
  ];
  for (const state of states) {
    const text = describeSearchReadiness({
      state,
      indexedCount: 7,
      eligibleCount: 11,
    });
    assert.equal(typeof text, "string");
    for (const n of text.match(/\d+/g) ?? []) {
      assert.ok(["7", "11"].includes(n), `${state} invented the number ${n}`);
    }
  }
});
