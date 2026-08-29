/**
 * BILLING SURFACE CORRECTION — the evidence allowance, said truthfully.
 *
 * The live PRO account that prompted this held 176 records against an enforced
 * cap of 127 with 0 credits, and the page told it:
 *
 *     176 lifetime records
 *     49 over the 127 your plan includes. Nothing has been removed.
 *     Moving up a plan, or buying an evidence credit, is what makes room for
 *     the next record.
 *     Evidence credits — 0 available
 *
 * Three separate untruths in four lines: 127 is not what PRO includes (100 is);
 * the 49 is not a quantity of anything the customer must buy or clear; and a
 * plan move is not guaranteed to raise a grandfathered limit past where the
 * account already sits.
 *
 * These are behaviour tests over `describeEvidenceAdmission` — the formatter
 * itself, given the server's projection — not a scan of the source text.
 *
 * `node:test`, matching this package's convention.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  describeEvidenceAdmission,
  type EvidencePresentation,
} from "../app/(app)/billing/_sections/format";
import type { EvidenceAdmission } from "../lib/api/billing-accounts";

const OFFERED = { canBuyCredits: true, hasPlanOffer: true };

/** The live fixture, parameterised by the two numbers that move. */
const grandfathered = (
  recordsHeld: number,
  creditsAvailable: number,
): EvidenceAdmission => ({
  planIncludedLifetime: 100,
  effectiveLifetimeCap: 127,
  capSource: "LEGACY_RECORD_CAP_OVERRIDE",
  recordsHeld,
  creditsAvailable,
  planCapacityRemaining: Math.max(0, 127 - recordsHeld),
  overCap: recordsHeld > 127,
  next:
    recordsHeld < 127
      ? { allowed: true, funding: "PLAN" }
      : creditsAvailable >= 1
        ? { allowed: true, funding: "EVIDENCE_CREDIT" }
        : { allowed: false, reason: "PLAN_ALLOWANCE_EXHAUSTED_NO_CREDITS" },
});

const all = (p: EvidencePresentation): string =>
  [p.headline, p.breakdown, p.next].filter(Boolean).join(" ");

// ===========================================================================
// 1. The 176 / 127 / 0 fixture
// ===========================================================================

test("never calls a grandfathered limit what the plan includes", () => {
  const p = describeEvidenceAdmission(grandfathered(176, 0), OFFERED);

  // The sentence that was wrong, in the exact shape it was wrong in.
  assert.ok(!all(p).includes("the 127 your plan includes"));
  assert.ok(!/127[^.]*your plan includes/.test(all(p)));

  // Both numbers are present, each attributed to the right thing.
  assert.match(p.breakdown ?? "", /Your plan includes 100 records\./);
  assert.match(p.breakdown ?? "", /higher agreed limit of 127/);
});

test("states the overage as a fact, not as a quantity to clear", () => {
  const p = describeEvidenceAdmission(grandfathered(176, 0), OFFERED);

  assert.match(p.breakdown ?? "", /49 more than that/);
  assert.match(p.breakdown ?? "", /Nothing has been removed\./);

  // What actually permits the next record: ONE credit. The 49 must not be
  // attached to the remedy.
  assert.match(p.next, /One evidence credit covers the next record/);
  assert.ok(!/49[^.]*credit/i.test(p.next));
});

test("the same account with one credit is told the credit works", () => {
  const p = describeEvidenceAdmission(grandfathered(176, 1), OFFERED);

  assert.match(p.next, /uses 1 of your 1 credit\b/);
  assert.match(p.next, /one credit per record/);
});

test("49 over and 1 over are described with the same remedy", () => {
  const far = describeEvidenceAdmission(grandfathered(176, 0), OFFERED);
  const near = describeEvidenceAdmission(grandfathered(128, 0), OFFERED);
  assert.equal(far.next, near.next);
});

test("the headline never renders the impossible-looking ratio", () => {
  const p = describeEvidenceAdmission(grandfathered(176, 0), OFFERED);
  assert.equal(p.headline, "176 lifetime records");
  assert.ok(!p.headline.includes("176 of 127"));
});

// ===========================================================================
// 2. Tone: a warning with a remedy, never the destructive tone
// ===========================================================================

test("being past the allowance is a warning, and the warning is in words", () => {
  const p = describeEvidenceAdmission(grandfathered(176, 0), OFFERED);

  // `risk` is the tone this product paints deletion in. Nothing is being
  // deleted, and the meter used to be painted in it.
  assert.equal(p.tone, "pending");
  assert.notEqual(p.tone as string, "risk");

  // Colour is never the only signal.
  assert.ok(p.next.length > 0);
});

test("a comfortable account is neutral", () => {
  const p = describeEvidenceAdmission(grandfathered(40, 0), OFFERED);
  assert.equal(p.tone, "neutral");
  assert.equal(p.headline, "40 of 127 included lifetime records");
  assert.match(p.next, /87 more records included\./);
});

test("approaching the allowance warns before it is reached", () => {
  const p = describeEvidenceAdmission(grandfathered(120, 0), OFFERED);
  assert.equal(p.tone, "pending");
  assert.match(p.next, /7 more records included\./);
});

test("the last included record is singular", () => {
  const p = describeEvidenceAdmission(grandfathered(126, 0), OFFERED);
  assert.match(p.next, /1 more record included\./);
});

// ===========================================================================
// 3. FREE, and the plain plan cap
// ===========================================================================

const free = (
  recordsHeld: number,
  creditsAvailable: number,
): EvidenceAdmission => ({
  planIncludedLifetime: 3,
  effectiveLifetimeCap: 3,
  capSource: "PLAN_DEFAULT",
  recordsHeld,
  creditsAvailable,
  planCapacityRemaining: Math.max(0, 3 - recordsHeld),
  overCap: recordsHeld > 3,
  next:
    recordsHeld < 3
      ? { allowed: true, funding: "PLAN" }
      : creditsAvailable >= 1
        ? { allowed: true, funding: "EVIDENCE_CREDIT" }
        : { allowed: false, reason: "PLAN_ALLOWANCE_EXHAUSTED_NO_CREDITS" },
});

test("FREE says N of 3, with no grandfather sentence to explain", () => {
  const p = describeEvidenceAdmission(free(1, 0), OFFERED);
  assert.equal(p.headline, "1 of 3 included lifetime records");
  assert.equal(p.breakdown, null);
  assert.match(p.next, /2 more records included\./);
});

test("a plain plan cap that is exceeded names the plan's own number", () => {
  const p = describeEvidenceAdmission(free(5, 0), OFFERED);
  assert.match(p.breakdown ?? "", /2 more than the 3 your plan includes/);
});

// ===========================================================================
// 4. The action comes from the server's offers, never from the plan name
// ===========================================================================

test("offers credits only when the server says credits may be bought", () => {
  const withCredits = describeEvidenceAdmission(grandfathered(176, 0), OFFERED);
  assert.equal(withCredits.action, "BUY_CREDITS");

  const noCredits = describeEvidenceAdmission(grandfathered(176, 0), {
    canBuyCredits: false,
    hasPlanOffer: true,
  });
  assert.equal(noCredits.action, "SEE_PLANS");

  const nothingOffered = describeEvidenceAdmission(grandfathered(176, 0), {
    canBuyCredits: false,
    hasPlanOffer: false,
  });
  assert.equal(nothingOffered.action, null);
});

test("an account inside its allowance is offered nothing", () => {
  const p = describeEvidenceAdmission(grandfathered(40, 0), OFFERED);
  assert.equal(p.action, null);
});

// ===========================================================================
// 5. An uncapped allowance
// ===========================================================================

test("an uncapped plan has no bar and no remedy", () => {
  const p = describeEvidenceAdmission(
    {
      planIncludedLifetime: null,
      effectiveLifetimeCap: null,
      capSource: "PLAN_DEFAULT",
      recordsHeld: 4_210,
      creditsAvailable: 0,
      planCapacityRemaining: null,
      overCap: false,
      next: { allowed: true, funding: "PLAN" },
    },
    OFFERED,
  );

  assert.equal(p.headline, "4,210 lifetime records");
  assert.equal(p.ratio, null);
  assert.equal(p.next, "No record limit on your plan.");
  assert.equal(p.action, null);
});
