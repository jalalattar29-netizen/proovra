/**
 * A COUNT MUST NOT INFER COMPLETENESS FROM THE NUMBER OF ROWS IT RECEIVED.
 *
 * ===========================================================================
 * WHY THE FIRST VERSION OF THIS FILE WAS WORTHLESS
 * ===========================================================================
 * It was a `.mjs` test that could not import the `.tsx` component, so it
 * carried a hand-copied duplicate of the sentence logic. When `total` was
 * added and the wording changed to "Showing 100 of 250", all eight cases kept
 * passing — against the copy. A test that duplicates its subject stops testing
 * at the first change and says nothing about it.
 *
 * The logic now lives in `lib/ui/resultCountSentence.ts`, and this imports it.
 *
 * ===========================================================================
 * WHAT IS BEING PROTECTED
 * ===========================================================================
 * Ten admin lists are server-capped: 500 sessions, 250 audit events, 200
 * incidents, 100 sync failures, 50 queue jobs. Reporting `rows.length` on any
 * of them says "200 incidents" when it means "the newest 200", and an operator
 * counting open conditions during a review gets a confident wrong answer.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { resultCountSentence as s } from "../lib/ui/resultCountSentence";

// --------------------------------------------------------------------------
// Authority order: total beats hasMore beats cap.
// --------------------------------------------------------------------------

test("an authoritative total states a fact", () => {
  assert.equal(s({ shown: 250, total: 250, noun: "incident" }), "250 incidents");
});

test("a total larger than the page says so, with both numbers", () => {
  assert.equal(
    s({ shown: 100, total: 250, cap: 100, noun: "sync failure" }),
    "Showing 100 of 250 sync failures",
  );
});

test("a total overrides the cap inference", () => {
  // shown === cap would otherwise read as truncated. The server said 40, so
  // it is 40 — the guess must not survive contact with the fact.
  assert.equal(s({ shown: 50, cap: 50, total: 50, noun: "job" }), "50 jobs");
});

test("hasMore overrides the cap inference", () => {
  assert.equal(s({ shown: 50, cap: 50, hasMore: false, noun: "job" }), "50 jobs");
  assert.equal(
    s({ shown: 20, cap: 50, hasMore: true, noun: "job" }),
    "20 jobs loaded — more available",
  );
});

test("with only a cap, the wording is a bound and admits it", () => {
  assert.equal(
    s({ shown: 200, cap: 200, noun: "incident" }),
    "200 incidents shown — the view is capped at 200, so there may be more",
  );
});

// --------------------------------------------------------------------------
// The boundaries.
// --------------------------------------------------------------------------

test("zero, unfiltered", () => {
  assert.equal(s({ shown: 0, noun: "grant" }), "No grants yet");
  assert.equal(s({ shown: 0, total: 0, noun: "grant" }), "No grants yet");
});

test("zero, filtered — a different sentence", () => {
  // "No grants yet" while a filter is active tells the reader their data is
  // gone.
  assert.equal(
    s({ shown: 0, total: 0, filtered: true, noun: "grant" }),
    "No grants match these filters",
  );
});

test("below the cap is complete", () => {
  assert.equal(s({ shown: 12, cap: 200, noun: "incident" }), "12 incidents");
});

test("exactly at the cap is reported as possibly truncated", () => {
  // Over-reports by exactly one case — a collection whose size equals the cap.
  // Erring toward "there may be more" is the safe direction on a page somebody
  // makes decisions from.
  assert.match(s({ shown: 50, cap: 50, noun: "job" }), /there may be more/);
});

test("the final page of a cursor feed does not claim more", () => {
  assert.equal(
    s({ shown: 37, cap: 50, hasMore: false, noun: "event" }),
    "37 events",
  );
});

test("one row is singular, in every wording", () => {
  assert.equal(s({ shown: 1, noun: "session" }), "1 session");
  assert.equal(s({ shown: 1, total: 1, noun: "session" }), "1 session");
  assert.equal(
    s({ shown: 1, total: 9, noun: "session" }),
    "Showing 1 of 9 sessions",
  );
});

test("an irregular plural is respected everywhere", () => {
  assert.equal(
    s({ shown: 3, noun: "policy", pluralNoun: "policies" }),
    "3 policies",
  );
  assert.equal(
    s({ shown: 0, noun: "inquiry", pluralNoun: "inquiries", filtered: true }),
    "No inquiries match these filters",
  );
});

test("loading never reports a count", () => {
  // A number that appears mid-load is read as a result.
  assert.equal(s({ shown: 0, noun: "event", loading: true }), "Loading events…");
  assert.equal(
    s({ shown: 40, total: 900, noun: "event", loading: true }),
    "Loading events…",
  );
});

test("no wording ever asserts a total it was not given", () => {
  // The property that matters: without `total`, the sentence must not contain
  // a bare "N nouns" for a capped list, because that reads as the total.
  const capped = s({ shown: 200, cap: 200, noun: "incident" });
  assert.notEqual(capped, "200 incidents");
});

// ===========================================================================
// THE BOUNDARIES
// ===========================================================================
// Every wording above is chosen by a comparison — `shown < total`,
// `shown >= cap`, `total === 0`. Each of those has an edge on either side, and
// an off-by-one in any of them produces a sentence that is confidently wrong
// rather than visibly broken. These walk the boundaries one row at a time.

test("zero, one, and two agree on singular and plural", () => {
  assert.equal(s({ shown: 0, total: 0, noun: "record" }), "No records yet");
  assert.equal(s({ shown: 1, total: 1, noun: "record" }), "1 record");
  assert.equal(s({ shown: 2, total: 2, noun: "record" }), "2 records");
});

test("a page below its limit is complete and says so plainly", () => {
  // 49 of 50 asked for: the server had nothing more to give.
  assert.equal(s({ shown: 49, cap: 50, noun: "failed job" }), "49 failed jobs");
});

test("a page exactly at its limit is assumed truncated", () => {
  // The one deliberate over-report: a collection of exactly 50 reads as
  // "there may be more". Erring toward more is the safe direction on a page
  // somebody makes a decision from.
  assert.equal(
    s({ shown: 50, cap: 50, noun: "failed job" }),
    "50 failed jobs shown — the view is capped at 50, so there may be more",
  );
});

test("a server total resolves the at-the-limit ambiguity in both directions", () => {
  // Exactly 50 exist — the cap guess would have said "there may be more".
  assert.equal(
    s({ shown: 50, total: 50, cap: 50, noun: "failed job" }),
    "50 failed jobs",
  );
  // 51 exist — one row is hidden, and the wording names both numbers.
  assert.equal(
    s({ shown: 50, total: 51, cap: 50, noun: "failed job" }),
    "Showing 50 of 51 failed jobs",
  );
});

test("hasMore outranks a cap that disagrees with it", () => {
  // Server says another page exists although the view came back short. A
  // cursor endpoint returning a partial page is normal, and the cap guess
  // would have called this complete.
  assert.equal(
    s({ shown: 12, cap: 50, hasMore: true, noun: "event" }),
    "12 events loaded — more available",
  );
  // And the final page: full, but the server says that is all.
  assert.equal(
    s({ shown: 50, cap: 50, hasMore: false, noun: "event" }),
    "50 events",
  );
});

test("a filtered view that matches everything is not an empty view", () => {
  // `filtered` must only change the EMPTY wording. A filter that happens to
  // match every row still reports a count.
  assert.equal(
    s({ shown: 7, total: 7, noun: "grant", filtered: true }),
    "7 grants",
  );
  assert.equal(
    s({ shown: 0, total: 0, noun: "grant", filtered: true }),
    "No grants match these filters",
  );
});

test("a filtered total describes the FILTERED population, not the table", () => {
  // The server counts over the same predicate as the rows. If a page passed
  // an unfiltered total here it would render "Showing 3 of 900" while three
  // rows match — the count and the list describing different populations is
  // the exact failure this component exists to prevent.
  assert.equal(
    s({ shown: 3, total: 3, cap: 50, noun: "grant", filtered: true }),
    "3 grants",
  );
});

test("a failed load never reports emptiness", () => {
  // The rows array is `[]` whether the list is empty or the request threw.
  // "No records yet" is a statement of fact, and this is the one moment the
  // page has no basis for it.
  assert.equal(
    s({ shown: 0, noun: "record", failed: true }),
    "Count unavailable",
  );
  assert.equal(
    s({ shown: 0, total: 0, noun: "record", failed: true, filtered: true }),
    "Count unavailable",
  );
});

test("a retry in flight outranks the failure it is retrying", () => {
  // Otherwise the page shows a stale error while it is already asking again.
  assert.equal(
    s({ shown: 0, noun: "record", failed: true, loading: true }),
    "Loading records…",
  );
});

test("a stale total from before a filter change is still reported honestly", () => {
  // The page is expected to clear `total` when the filter changes. If it does
  // not, the sentence must still not invent completeness: 3 shown against a
  // stale 900 reads as a truncation, which is wrong but VISIBLE — the reader
  // sees two numbers that do not fit. The failure mode being excluded is the
  // silent one, where it would print "3 grants" and look correct.
  assert.equal(
    s({ shown: 3, total: 900, noun: "grant", filtered: true }),
    "Showing 3 of 900 grants",
  );
});
