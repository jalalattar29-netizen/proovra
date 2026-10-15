/**
 * ET-COM-02 / ET-COM-04 — the shared sentences web and native both show.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PLAN_LAPSE_STATES,
  TRASH_KEEPS_PLAN_CAPACITY_COPY,
  TRASH_LIFECYCLE_COPY,
  planLapseCopy,
  recordsInTrashAllowanceCopy,
} from "../dist/index.js";

test("the trash sentence says deleting never restores an evidence slot — purge included", () => {
  assert.match(TRASH_KEEPS_PLAN_CAPACITY_COPY, /does not restore an evidence slot/);
  assert.match(TRASH_KEEPS_PLAN_CAPACITY_COPY, /final purge included/);
  assert.doesNotMatch(TRASH_KEEPS_PLAN_CAPACITY_COPY, /until it is permanently destroyed/);
});

test("the lifecycle sentence states Trash, the retention archive and the purge barrier, never 'permanently deleted' as done", () => {
  assert.match(TRASH_LIFECYCLE_COPY, /90 days/);
  assert.match(TRASH_LIFECYCLE_COPY, /retention archive/);
  assert.match(TRASH_LIFECYCLE_COPY, /cannot be permanently deleted before every retention period and legal hold ends/);
  // The actual policy (owner decision 2026-10-15): eight years, never a year.
  assert.match(TRASH_LIFECYCLE_COPY, /2,920 days \(eight years\) from sealing/);
  assert.doesNotMatch(TRASH_LIFECYCLE_COPY, /calendar|Governance/i);
  assert.doesNotMatch(TRASH_LIFECYCLE_COPY, /365|one year|12 months/i);
});

test("the Billing trash line appears only for a real positive count", () => {
  assert.equal(recordsInTrashAllowanceCopy(0), null);
  assert.equal(recordsInTrashAllowanceCopy(null), null);
  assert.equal(recordsInTrashAllowanceCopy(undefined), null);
  assert.equal(recordsInTrashAllowanceCopy(Number.NaN), null);
  assert.equal(
    recordsInTrashAllowanceCopy(1),
    "Includes 1 record in Trash — deleting a record does not restore an evidence slot.",
  );
  assert.equal(
    recordsInTrashAllowanceCopy(4),
    "Includes 4 records in Trash — deleting a record does not restore an evidence slot.",
  );
});

test("each lapse state is worded distinctly, and none reads as a lockout", () => {
  const copy = Object.fromEntries(
    PLAN_LAPSE_STATES.map((state) => [
      state,
      planLapseCopy({ state, lapsedPlanLabel: "Pro", freeAllowanceRemaining: 2, creditsAvailable: 3 }),
    ]),
  );
  assert.equal(new Set(Object.values(copy).map((c) => c.nextRecord)).size, PLAN_LAPSE_STATES.length);
  for (const c of Object.values(copy)) {
    assert.equal(c.headline, "Your Pro plan has lapsed.");
    // What stays, what a credit buys, and what needs a renewal.
    assert.match(c.outputs, /stay available/);
    assert.match(c.outputs, /funded by a credit includes its report and package/);
    assert.match(c.outputs, /Renew the plan for plan-included reports/);
    assert.doesNotMatch(`${c.headline} ${c.nextRecord} ${c.outputs}`, /suspend|locked|blocked/i);
  }
  assert.equal(
    copy.FREE_ALLOWANCE_AVAILABLE.nextRecord,
    "New records use the Free allowance: 2 more records included.",
  );
  assert.equal(
    copy.FREE_ALLOWANCE_EXHAUSTED_CREDIT_AVAILABLE.nextRecord,
    "The Free allowance is used up. The next record uses 1 of your 3 credits.",
  );
  assert.match(copy.FREE_ALLOWANCE_EXHAUSTED_NO_CREDIT.nextRecord, /Renew your plan or buy a credit/);
});
