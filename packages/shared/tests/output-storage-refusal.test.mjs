/**
 * F-02 (2026-11-13) — A STORAGE REFUSAL IS SAID AS ONE, AND THE FIRST ISSUANCE
 * A RECORD EARNED IS NEVER REFUSED FOR STORAGE.
 *
 * Defect: a package the worker refused for storage was settled NOT_APPLICABLE
 * (NOT_APPLICABLE_STORAGE_LIMIT), which projects to "not requested", and the
 * package action fell through to a bare RECOVER — each click rebuilt the
 * package for the worker to refuse it again, and nothing said why.
 *
 *   * refused for storage and a new attempt would not fit → NONE / STORAGE_LIMIT
 *     (copy names the allowance and the step: free up or add storage);
 *   * room made since (fits) or the fit unknown → RECOVER (the worker re-checks);
 *   * the latest pair is the record's EARNED first issuance → RECOVER (the
 *     worker does not refuse it for storage any more);
 *   * the exemption rule: first report version + earned at finalization only.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  firstIssuanceExemptFromStorageLimit,
  outputNoteCopy,
  resolveEvidenceOutputActions,
} from "../dist/index.js";

const STORAGE_REFUSED = { state: "NOT_APPLICABLE", terminalReasonCode: "NOT_APPLICABLE_STORAGE_LIMIT" };

function facts(over = {}) {
  return {
    record: "FINALIZED",
    reportEligibility: "ELIGIBLE",
    packageEligibility: "ELIGIBLE",
    latestReportVersion: 2,
    packageAtLatestReport: false,
    latestPackageVersion: 1,
    packageBlockedByGovernance: false,
    reportRequest: null,
    packageRequest: STORAGE_REFUSED,
    restrictions: {
      lifecycleState: "ACTIVE",
      legalHold: false,
      workspaceSuspended: false,
      workspaceClosed: false,
      workspaceResolved: true,
    },
    callerMayGenerate: true,
    callerMaySupersede: false,
    newVersionFitsStorage: false,
    ...over,
  };
}

test("refused for storage and still no room: NONE with the storage reason, never a bare RECOVER", () => {
  const pkg = resolveEvidenceOutputActions(facts()).verificationPackage;
  assert.deepEqual(pkg, { action: "NONE", reason: "STORAGE_LIMIT", operation: null });
  const copy = outputNoteCopy({ actionUnavailableReason: pkg.reason });
  assert.match(copy, /storage allowance/);
  assert.match(copy, /Free up storage or add storage/);
});

test("room made since, or the fit unknown: RECOVER (the worker re-checks)", () => {
  for (const newVersionFitsStorage of [true, null]) {
    const pkg = resolveEvidenceOutputActions(facts({ newVersionFitsStorage })).verificationPackage;
    assert.equal(pkg.action, "RECOVER");
    assert.equal(pkg.operation, "PACKAGE_RECOVERY");
  }
});

test("an earned first issuance refused before the fix is recoverable whatever the allowance says", () => {
  const pkg = resolveEvidenceOutputActions(
    facts({ latestReportVersion: 1, latestPackageVersion: null, firstIssuanceStorageExempt: true }),
  ).verificationPackage;
  assert.equal(pkg.action, "RECOVER");
});

test("any other refusal or failure is unchanged by the storage rule", () => {
  const notEntitled = resolveEvidenceOutputActions(
    facts({ packageRequest: { state: "NOT_APPLICABLE", terminalReasonCode: "NOT_APPLICABLE_NOT_ENTITLED" } }),
  ).verificationPackage;
  assert.equal(notEntitled.action, "RECOVER");
  const noRequest = resolveEvidenceOutputActions(facts({ packageRequest: null })).verificationPackage;
  assert.equal(noRequest.action, "RECOVER");
});

test("the exemption: first report version AND earned at finalization (stored fact or credit) only", () => {
  const yes = (basis) => firstIssuanceExemptFromStorageLimit({ decision: "ENTITLED", basis, isFirstReportVersion: true });
  assert.equal(yes("EARNED_AT_FINALIZATION"), true);
  assert.equal(yes("EVIDENCE_CREDIT"), true);
  for (const basis of ["PAID_SUBSCRIPTION", "TRIAL", "PAYMENT_GRACE", "FREE_ALLOWANCE", "UNKNOWN", null]) {
    assert.equal(yes(basis), false, String(basis));
  }
  assert.equal(
    firstIssuanceExemptFromStorageLimit({ decision: "ENTITLED", basis: "EARNED_AT_FINALIZATION", isFirstReportVersion: false }),
    false,
  );
  assert.equal(
    firstIssuanceExemptFromStorageLimit({ decision: "UNRESOLVED", basis: "EARNED_AT_FINALIZATION", isFirstReportVersion: true }),
    false,
  );
});
