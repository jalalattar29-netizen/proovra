/**
 * ET-COM-02 / ET-COM-04 — the shared sentences web and native both show.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PLAN_LAPSE_STATES,
  TRASH_KEEPS_PLAN_CAPACITY_COPY,
  planLapseCopy,
  recordsInTrashAllowanceCopy,
} from "../dist/index.js";

test("the trash sentence says trash frees no plan capacity, and what does", () => {
  assert.match(TRASH_KEEPS_PLAN_CAPACITY_COPY, /does not free plan capacity/);
  assert.match(TRASH_KEEPS_PLAN_CAPACITY_COPY, /until it is permanently destroyed/);
});

test("the Billing trash line appears only for a real positive count", () => {
  assert.equal(recordsInTrashAllowanceCopy(0), null);
  assert.equal(recordsInTrashAllowanceCopy(null), null);
  assert.equal(recordsInTrashAllowanceCopy(undefined), null);
  assert.equal(recordsInTrashAllowanceCopy(Number.NaN), null);
  assert.equal(
    recordsInTrashAllowanceCopy(1),
    "Includes 1 record in Trash — trash does not free plan capacity.",
  );
  assert.equal(
    recordsInTrashAllowanceCopy(4),
    "Includes 4 records in Trash — trash does not free plan capacity.",
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
