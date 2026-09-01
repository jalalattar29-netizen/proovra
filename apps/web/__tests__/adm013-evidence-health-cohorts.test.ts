/**
 * ADM-013 — EVIDENCE HEALTH COHORTS, THE UI CONTRACT.
 *
 * ===========================================================================
 * WHAT THIS PINS, AND WHY EACH ASSERTION EARNS ITS PLACE
 * ===========================================================================
 * The arithmetic itself is proven against live PostgreSQL in
 * `services/api/test/adm013-evidence-cohorts.integration.test.ts` — that suite
 * seeds 3 / 4 / 2 records and asserts the union is 9 rather than the 11 an
 * operator would have got by adding the two old totals.
 *
 * This file pins the part a database cannot: that the PAGE presents those
 * numbers in a way that does not re-create the error. Specifically —
 *
 *   1. the overlapping cohorts SAY they overlap, next to the number, because a
 *      tile reading "9" beside three tiles reading 3, 4 and 2 invites exactly
 *      the addition this work exists to stop;
 *   2. the reconciliation self-check is RENDERED, so a future predicate change
 *      that breaks the sum is visible on the page rather than silent;
 *   3. an unmeasured count never renders as 0 and never offers a drill-down,
 *      because a link promising records we could not count lands on an empty
 *      table that reads as "nothing wrong";
 *   4. a non-retryable row states its reason, because "you cannot retry this"
 *      with no reason is the message an operator escalates about;
 *   5. the page invents no retryability of its own — the words come from the
 *      remediation registry through the API, and a second opinion here would
 *      eventually offer a retry the incident surface refuses;
 *   6. the drill-down and the tile use the same cohort key, so the number on
 *      the card and the rows behind it cannot describe different populations;
 *   7. no evidence content appears.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string =>
  readFileSync(resolve(APP_ROOT, rel), "utf8");

const HEALTH = "app/(app)/admin/evidence-ops/page.tsx";
const RECORDS = "app/(app)/admin/evidence-ops/records/page.tsx";

/** The three disjoint parts, the measured union, and the two action cuts. */
const COHORTS = [
  "TSA_FAILED_ONLY",
  "SIGNED_NO_REPORT_ONLY",
  "BOTH",
  "ALL_AFFECTED",
  "RETRYABLE",
  "MANUAL_REVIEW",
];

// ===========================================================================
// The summary.
// ===========================================================================

test("the health page renders every cohort, and renders them first", () => {
  const src = read(HEALTH);
  for (const c of COHORTS) {
    assert.match(src, new RegExp(c), `cohort ${c} is not on the page`);
  }
  assert.match(
    src,
    /Records needing attention/,
    "the cohort section must be titled by the question it answers",
  );
  // Order matters: the section that counts RECORDS has to precede the sections
  // that count FAILURES, or the first number an operator sees is one of the
  // overlapping ones.
  const cohortAt = src.indexOf("Records needing attention");
  const uploadsAt = src.indexOf('title="Uploads"');
  assert.ok(cohortAt > 0 && uploadsAt > 0, "both sections must exist");
  assert.ok(
    cohortAt < uploadsAt,
    "the cohort section must come before the failure-count sections",
  );
});

test("the overlapping cohorts say so, in the tile", () => {
  const src = read(HEALTH);
  assert.match(
    src,
    /OVERLAPPING = new Set\(\[/,
    "the page must know which cohorts overlap rather than treating all six alike",
  );
  const decl = /OVERLAPPING = new Set\(\[[\s\S]{0,200}?\]\)/.exec(src)?.[0] ?? "";
  for (const c of ["ALL_AFFECTED", "RETRYABLE", "MANUAL_REVIEW"]) {
    assert.match(decl, new RegExp(c), `${c} overlaps the disjoint three`);
  }
  assert.doesNotMatch(
    decl,
    /TSA_FAILED_ONLY|SIGNED_NO_REPORT_ONLY|"BOTH"/,
    "the three disjoint cohorts must NOT be marked as overlapping",
  );
  assert.match(
    src,
    /do not add to them/i,
    "the warning must be in words on the tile, not only in a code comment",
  );
});

test("the reconciliation self-check is rendered, not merely computed", () => {
  const src = read(HEALTH);
  assert.match(src, /arithmetic\.agrees/, "the page must read the self-check");
  assert.match(
    src,
    /do not reconcile/i,
    "a failed reconciliation must produce visible text, not a silent fallback",
  );
  assert.match(
    src,
    /data-arithmetic-agrees=/,
    "the outcome must be machine-readable for browser verification",
  );
  // And the failure branch must be styled as a problem. A mismatch rendered in
  // muted grey is a mismatch nobody reads.
  assert.match(
    src,
    /agrees === false[\s\S]{0,120}danger/,
    "the mismatch branch must use the danger token",
  );
});

test("an unmeasured cohort is never a zero and never a link", () => {
  const src = read(HEALTH);
  assert.match(src, /unmeasured = c\.count == null/, "null must be detected");
  assert.match(src, /Not measured/, 'null must render as "Not measured"');
  // The drill-down sits inside the `unmeasured ? null :` branch. A link built
  // from a count we could not read lands on an empty table.
  assert.match(
    src,
    /\{unmeasured \? null : \([\s\S]{0,400}drillDown/,
    "the drill-down must be suppressed when the count is unmeasured",
  );
  assert.match(
    src,
    /unavailableCohorts/,
    "unavailable cohorts must be named so a blank is never read as zero",
  );
});

test("the tile states the action and, when refusing, the reason", () => {
  const src = read(HEALTH);
  assert.match(src, /operatorAction/, "every tile must carry an action");
  assert.match(src, /c\.reason \?/, "a refusal must be able to state its reason");
  assert.match(src, /runbookSlug/, "the tile must link its runbook");
});

test("the page decides no retryability of its own", () => {
  const src = read(HEALTH);
  // Every word about retryability arrives from the API, which reads the
  // remediation registry. A local rule here would eventually contradict the
  // incident surface, which reads the same registry.
  assert.doesNotMatch(
    src,
    /tsaStatus === ["']FAILED["'][\s\S]{0,120}retryable/,
    "retryability must not be re-derived from evidence columns in the UI",
  );
  assert.match(src, /c\.retryable \?/, "the tile must read the server's disposition");
});

// ===========================================================================
// The drill-down.
// ===========================================================================

test("the records page offers the same cohorts the summary counts", () => {
  const src = read(RECORDS);
  for (const c of COHORTS) {
    assert.match(src, new RegExp(c), `cohort ${c} is not filterable`);
  }
  assert.match(src, /qs\.set\("cohort", cohort\)/, "the filter must reach the API");
});

test("a cohort in the URL is honoured, not overridden by the signal default", () => {
  const src = read(RECORDS);
  // The summary tiles link here with `?cohort=…`. Falling back to the
  // TSA_FAILED default would show a different population than the tile that
  // was clicked, while the header still named the tile.
  assert.match(
    src,
    /initialCohort \? "" : "TSA_FAILED"/,
    "arriving with a cohort must suppress the signal default",
  );
});

test("every row states its own cohort, age, last change, action and runbook", () => {
  const src = read(RECORDS);
  for (const field of [
    "cohort",
    "ageDays",
    "lastChangeAtUtc",
    "retryable",
    "operatorAction",
    "runbookSlug",
  ]) {
    assert.match(src, new RegExp(`r\\.${field}`), `rows must render ${field}`);
  }
  assert.match(src, /day\{r\.ageDays === 1/, "age must be shown in words on the row");
});

test("last change is not mislabelled as an attempt", () => {
  const src = read(RECORDS);
  // There is no per-record attempt log. Calling `updatedAt` a retry would
  // describe a measurement nobody takes.
  assert.match(src, /header: "Last change"/, "the column must be honestly named");
  assert.doesNotMatch(
    src,
    /header: "Last attempt"/,
    "no attempt log exists, so no column may claim one",
  );
});

test("a non-retryable row states why", () => {
  const src = read(RECORDS);
  assert.match(
    src,
    /!r\.retryable && r\.notRetryableReason/,
    "the reason must render precisely when the row is refused",
  );
});

test("a row disposition follows the row, not the filter", () => {
  const src = read(RECORDS);
  // In the ALL_AFFECTED list the two halves need opposite handling, so the
  // badge must read the row's own field rather than the active filter.
  assert.match(src, /r\.retryable \? "Retryable" : "Manual"/);
  assert.doesNotMatch(
    src,
    /cohort === "RETRYABLE"[\s\S]{0,80}"Retryable"/,
    "the row badge must not be derived from the filter",
  );
});

test("the mixed population warns before bulk action", () => {
  const src = read(RECORDS);
  assert.match(
    src,
    /mixed\s+population/i,
    "ALL_AFFECTED must say it is mixed before an operator acts on it in bulk",
  );
  assert.match(src, /opposite\s+handling/i);
});

test("clearing every filter asks nothing, and explains itself", () => {
  const src = read(RECORDS);
  assert.match(
    src,
    /!evidenceId && !cohort && !signal/,
    "the page must not request an unbounded list",
  );
  assert.match(
    src,
    /Choose a cohort or a signal/,
    "the empty state must tell the operator what to do",
  );
});

// ===========================================================================
// The boundary that does not move.
// ===========================================================================

test("neither page can render evidence content", () => {
  for (const rel of [HEALTH, RECORDS]) {
    const src = read(rel);
    for (const forbidden of [
      "storageKey",
      "storageBucket",
      "fileSha256",
      "signatureBase64",
      "internalNotes",
      "downloadUrl",
    ]) {
      assert.doesNotMatch(
        src,
        new RegExp(forbidden),
        `${rel} references ${forbidden} — platform-operations visibility is not evidence-content authorization`,
      );
    }
  }
});

test("both pages route errors through toSafeUserError", () => {
  for (const rel of [HEALTH, RECORDS]) {
    assert.match(
      read(rel),
      /toSafeUserError/,
      `${rel} must not surface a raw error message`,
    );
  }
});
