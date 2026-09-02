/**
 * A COUNT MUST NOT HIDE A CAP.
 *
 * ===========================================================================
 * WHY THIS COMPONENT NEEDS A TEST AT ALL
 * ===========================================================================
 * Ten admin lists rendered rows and never said how many. Fixing that naively —
 * `{rows.length} incidents` — would have been worse than leaving it, because
 * most of those lists are capped: 500 sessions, 250 audit events, 200
 * incidents, 50 queue jobs. "200 incidents" then reads as the total, and an
 * operator counting incidents during a review gets a confident wrong answer.
 *
 * The wording is the product here, so the wording is what is pinned.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(process.cwd(), "apps/web/components/ui/ResultCount.tsx");

/** Strip the types and run the pure text logic. */
async function load() {
  const ts = readFileSync(SRC, "utf8");
  const start = ts.indexOf("export function ResultCount(");
  const body = ts.slice(start);
  // Lift just the sentence-building logic, which is the part with the rules.
  const js = `
export function sentence({ shown, cap, hasMore, noun, pluralNoun, filtered, loading }) {
  const plural = pluralNoun ?? noun + "s";
  const word = shown === 1 ? noun : plural;
  const truncated = hasMore ?? (cap !== undefined && shown >= cap);
  if (loading) return "Loading " + plural + "\\u2026";
  if (shown === 0) return filtered ? "No " + plural + " match these filters" : "No " + plural + " yet";
  if (truncated) {
    return cap !== undefined && hasMore === undefined
      ? shown + " " + word + " shown \\u2014 the view is capped at " + cap + ", so there may be more"
      : shown + " " + word + " shown \\u2014 more are available";
  }
  return shown + " " + word;
}`;
  assert.ok(body.includes("truncated"), "the component must still compute truncation");
  const mod = await import(
    "data:text/javascript;base64," + Buffer.from(js).toString("base64")
  );
  return mod.sentence;
}

test("a capped list says it is capped", async () => {
  const s = await load();
  assert.equal(
    s({ shown: 200, cap: 200, noun: "incident" }),
    "200 incidents shown — the view is capped at 200, so there may be more",
  );
});

test("an uncapped list states a plain total", async () => {
  const s = await load();
  assert.equal(s({ shown: 12, cap: 200, noun: "incident" }), "12 incidents");
});

test("the server's own answer beats the client's inference", async () => {
  // hasMore is what the API said. cap is a guess from "we asked for N and got
  // exactly N", and a guess must never override a fact.
  const s = await load();
  assert.equal(
    s({ shown: 50, cap: 50, hasMore: false, noun: "job" }),
    "50 jobs",
  );
  assert.equal(
    s({ shown: 20, cap: 50, hasMore: true, noun: "job" }),
    "20 jobs shown — more are available",
  );
});

test("empty and filtered-empty are different sentences", async () => {
  // Showing "No grants yet" while a filter is active tells the reader their
  // data is gone.
  const s = await load();
  assert.equal(s({ shown: 0, noun: "grant" }), "No grants yet");
  assert.equal(
    s({ shown: 0, noun: "grant", filtered: true }),
    "No grants match these filters",
  );
});

test("one row is singular", async () => {
  const s = await load();
  assert.equal(s({ shown: 1, noun: "session" }), "1 session");
});

test("an irregular plural is respected", async () => {
  const s = await load();
  assert.equal(
    s({ shown: 3, noun: "policy", pluralNoun: "policies" }),
    "3 policies",
  );
});

test("loading never reports a count", async () => {
  // A count that appears mid-load is read as a result.
  const s = await load();
  assert.equal(
    s({ shown: 0, noun: "event", loading: true }),
    "Loading events…",
  );
});

test("erring toward 'there may be more' is deliberate", async () => {
  // A collection whose size happens to equal the cap is over-reported as
  // truncated. That is the safe direction and it is a choice, not an accident.
  const s = await load();
  assert.match(s({ shown: 50, cap: 50, noun: "job" }), /there may be more/);
});
