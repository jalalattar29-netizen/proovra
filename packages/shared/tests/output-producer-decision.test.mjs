/**
 * THE OUTPUT-PRODUCER DECISION (2026-10-20, forward remediation AUD-01/02/35).
 *
 * One table, every producer: lifecycle first, then entitlement, then the
 * historical first-issuance rule. Executed against the BUILT module.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { decideOutputProduction, outputLifecycleRefusal, OUTPUT_PRODUCTION_REFUSALS, isOutputProductionRefusal } from "../dist/index.js";

const live = { status: "SIGNED", lifecycleState: "ACTIVE", deletedAt: null };
const entitled = { decision: "ENTITLED", reportsIncluded: true, verificationPackageIncluded: true, mayIssueHistoricalFirstOutputs: true };

test("lifecycle: every retired state is refused, whatever the entitlement", () => {
  const cases = {
    ARCHIVED: "NOT_APPLICABLE_ARCHIVED",
    RETENTION_ARCHIVED: "NOT_APPLICABLE_RETENTION_ARCHIVED",
    TRASHED: "NOT_APPLICABLE_TRASHED",
    PENDING_DESTRUCTION: "NOT_APPLICABLE_PENDING_DESTRUCTION",
    DESTROYED: "NOT_APPLICABLE_DESTROYED",
  };
  for (const [lifecycleState, refusal] of Object.entries(cases)) {
    assert.deepEqual(
      decideOutputProduction({ subject: { ...live, lifecycleState }, artifactType: "REPORT", entitlement: entitled }),
      { produce: false, refusal },
      lifecycleState,
    );
  }
});

test("lifecycle: a deleted or unknown-state record is refused; live states produce; status is not decided here", () => {
  assert.equal(outputLifecycleRefusal({ ...live, deletedAt: new Date() }), "NOT_APPLICABLE_DELETED");
  // The seal status is the worker integrity gates' business, never a business refusal.
  assert.equal(outputLifecycleRefusal({ ...live, status: "CREATED" }), null);
  assert.equal(outputLifecycleRefusal({ ...live, status: "FAILED_HASH_MISMATCH" }), null);
  assert.equal(outputLifecycleRefusal({ ...live, lifecycleState: "SOMETHING_NEW" }), "NOT_APPLICABLE_ARCHIVED");
  for (const lifecycleState of ["ACTIVE", "UNDER_REVIEW", "ON_HOLD", "RETENTION_LOCKED", null]) {
    assert.equal(outputLifecycleRefusal({ ...live, lifecycleState }), null, String(lifecycleState));
    assert.equal(outputLifecycleRefusal({ ...live, status: "REPORTED", lifecycleState }), null, String(lifecycleState));
  }
});

test("entitlement: a REPORT request needs the report AND the package; a package request needs the package", () => {
  const noPackage = { ...entitled, verificationPackageIncluded: false };
  assert.deepEqual(decideOutputProduction({ subject: live, artifactType: "REPORT", entitlement: noPackage }), {
    produce: false,
    refusal: "NOT_APPLICABLE_NOT_ENTITLED",
  });
  assert.deepEqual(decideOutputProduction({ subject: live, artifactType: "VERIFICATION_PACKAGE", entitlement: noPackage }), {
    produce: false,
    refusal: "NOT_APPLICABLE_NOT_ENTITLED",
  });
  const noReport = { ...entitled, reportsIncluded: false };
  assert.deepEqual(decideOutputProduction({ subject: live, artifactType: "VERIFICATION_PACKAGE", entitlement: noReport }), { produce: true });
  assert.deepEqual(decideOutputProduction({ subject: live, artifactType: "REPORT", entitlement: { ...entitled, decision: "NOT_ENTITLED" } }), {
    produce: false,
    refusal: "NOT_APPLICABLE_NOT_ENTITLED",
  });
});

test("entitlement: unreadable is not a refusal — nothing now, decide again later", () => {
  for (const entitlement of [null, { ...entitled, decision: "UNRESOLVED" }]) {
    assert.deepEqual(decideOutputProduction({ subject: live, artifactType: "REPORT", entitlement }), {
      produce: false,
      refusal: null,
      unresolved: true,
    });
  }
  // Lifecycle still wins over an unreadable entitlement.
  assert.deepEqual(decideOutputProduction({ subject: { ...live, lifecycleState: "ARCHIVED" }, artifactType: "REPORT", entitlement: null }), {
    produce: false,
    refusal: "NOT_APPLICABLE_ARCHIVED",
  });
});

test("the historical first-issuance rule applies only when asked for", () => {
  const trial = { ...entitled, mayIssueHistoricalFirstOutputs: false };
  assert.deepEqual(decideOutputProduction({ subject: live, artifactType: "REPORT", entitlement: trial, historicalFirstIssuance: true }), {
    produce: false,
    refusal: "NOT_APPLICABLE_FIRST_ISSUANCE_AWAITS_CONFIRMED_PAYMENT",
  });
  assert.deepEqual(decideOutputProduction({ subject: live, artifactType: "REPORT", entitlement: trial }), { produce: true });
});

test("every refusal is in the bounded vocabulary and fits the 64-char terminal reason", () => {
  for (const r of OUTPUT_PRODUCTION_REFUSALS) {
    assert.ok(isOutputProductionRefusal(r));
    assert.ok(r.length <= 64, r);
    assert.match(r, /^NOT_APPLICABLE_[A-Z_]+$/);
  }
  assert.equal(isOutputProductionRefusal("REPORT_NOT_INCLUDED_IN_PLAN"), false);
  assert.equal(isOutputProductionRefusal(null), false);
});
