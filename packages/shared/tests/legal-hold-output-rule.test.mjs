/**
 * THE LEGAL-HOLD RULE FOR OUTPUTS (2026-09-29).
 *
 * A hold PRESERVES. It refuses every destructive or REPLACING action and every
 * release of bytes (export eligibility at the download gate); it never refuses
 * creating a first missing output, which replaces and destroys nothing.
 *
 * Pinned on the one resolver every surface reads:
 *   * allowed under a hold: a missing package is still RECOVER, a record with
 *     no report still GENERATE;
 *   * refused under a hold: an updated report (NEW_VERSION) — LEGAL_HOLD_ACTIVE;
 *   * without the hold the updated report is available again (the refusal is
 *     the hold's, not something else's).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { NEW_VERSION_ACTION, resolveEvidenceOutputActions } from "../dist/index.js";

function facts(over = {}, restrictions = {}) {
  return {
    record: "FINALIZED",
    reportEligibility: "ELIGIBLE",
    packageEligibility: "ELIGIBLE",
    latestReportVersion: 1,
    packageAtLatestReport: true,
    latestPackageVersion: 1,
    packageBlockedByGovernance: false,
    reportRequest: null,
    packageRequest: null,
    restrictions: {
      lifecycleState: "ACTIVE",
      legalHold: false,
      workspaceSuspended: false,
      workspaceClosed: false,
      workspaceResolved: true,
      ...restrictions,
    },
    callerMayGenerate: true,
    newVersionFitsStorage: true,
    ...over,
  };
}

test("under a hold, a missing package is still RECOVER — creating it replaces nothing", () => {
  const a = resolveEvidenceOutputActions(
    facts({ packageAtLatestReport: false, latestPackageVersion: null }, { legalHold: true }),
  );
  assert.equal(a.verificationPackage.action, "RECOVER");
});

test("under a hold, a record with no report is still GENERATE", () => {
  const a = resolveEvidenceOutputActions(
    facts(
      { latestReportVersion: null, packageAtLatestReport: false, latestPackageVersion: null },
      { legalHold: true },
    ),
  );
  assert.equal(a.report.action, "GENERATE");
});

test("under a hold, an updated report (a replacement) is refused as LEGAL_HOLD_ACTIVE", () => {
  const held = resolveEvidenceOutputActions(facts({}, { legalHold: true }));
  assert.equal(held.newVersion.action, "NONE");
  assert.equal(held.newVersion.reason, "LEGAL_HOLD_ACTIVE");
  const free = resolveEvidenceOutputActions(facts());
  assert.equal(free.newVersion.action, NEW_VERSION_ACTION);
});

test("a complete pair offers no recovery verb, held or not", () => {
  for (const legalHold of [false, true]) {
    const a = resolveEvidenceOutputActions(facts({}, { legalHold }));
    assert.equal(a.report.action, "NONE");
    assert.equal(a.verificationPackage.action, "NONE");
  }
});
