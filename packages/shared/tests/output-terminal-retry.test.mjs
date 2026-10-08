/**
 * RETRY OF AN EXHAUSTED TECHNICAL FAILURE FROM THE RECORD (2026-10-08).
 *
 * A Report v1 that failed terminally for a TECHNICAL reason used to leave the
 * record with no action at all (ESCALATED_TO_OPERATOR), even for the person
 * who holds the operator's supersession right. The one resolver now offers
 * that person the retry — the same supersession Operations performs — and
 * keeps the three outputs' verbs distinct:
 *
 *   no report + technical terminal   → report RETRY, FULL_GENERATION (v1 again)
 *   report + newer facts             → newVersion CREATE_NEW_VERSION only
 *   report + package technical fail  → package RETRY, PACKAGE_RECOVERY
 *   integrity / policy terminal      → never offered, whoever asks
 *   no supersession right            → still escalated, stated read-only
 *   work in flight                   → nothing offered
 *   writer budget spent              → escalated again (no endless loop)
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_TERMINAL_SUPERSESSIONS,
  NEW_VERSION_ACTION,
  NEW_VERSION_LABEL,
  outputActionLabel,
  resolveEvidenceOutputActions,
} from "../dist/index.js";

const TECHNICAL = { state: "FAILED_TERMINAL", terminalReasonCode: "REPORT_RENDER_FAILED", afterLatestReport: false };

function facts(over = {}) {
  return {
    record: "FINALIZED",
    reportEligibility: "ELIGIBLE",
    packageEligibility: "ELIGIBLE",
    latestReportVersion: null,
    packageAtLatestReport: false,
    latestPackageVersion: null,
    packageBlockedByGovernance: false,
    reportRequest: null,
    packageRequest: null,
    restrictions: {
      lifecycleState: "ACTIVE",
      legalHold: false,
      workspaceSuspended: false,
      workspaceClosed: false,
      workspaceResolved: true,
    },
    callerMayGenerate: true,
    callerMaySupersede: true,
    newVersionFitsStorage: true,
    ...over,
  };
}

test("no report + technical terminal: the right holder is offered RETRY of the first issuance", () => {
  const a = resolveEvidenceOutputActions(facts({ reportRequest: TECHNICAL, packageRequest: TECHNICAL }));
  assert.deepEqual(a.report, {
    action: "RETRY",
    reason: null,
    operation: "FULL_GENERATION",
    supersedesTechnicalTerminal: true,
  });
  // The package follows the report; it is never a separate verb here.
  assert.equal(a.verificationPackage.action, "NONE");
  assert.equal(a.verificationPackage.reason, "FOLLOWS_REPORT");
  // Never a "new version" when v1 never existed.
  assert.equal(a.newVersion.action, "NONE");
  assert.equal(outputActionLabel("report", a.report.action), "Retry report generation");
});

test("without the supersession right the failure stays escalated — no executable verb", () => {
  for (const over of [{ callerMaySupersede: false }, { callerMaySupersede: undefined }]) {
    const a = resolveEvidenceOutputActions(facts({ reportRequest: TECHNICAL, packageRequest: TECHNICAL, ...over }));
    assert.equal(a.report.action, "NONE");
    assert.equal(a.report.reason, "ESCALATED_TO_OPERATOR");
  }
});

test("a caller without the domain right is refused even with the operator right", () => {
  const a = resolveEvidenceOutputActions(
    facts({ reportRequest: TECHNICAL, packageRequest: TECHNICAL, callerMayGenerate: false }),
  );
  assert.equal(a.report.action, "NONE");
  assert.equal(a.report.reason, "PERMISSION_DENIED");
});

test("integrity, policy and report-integrity terminals are never offered, whoever asks", () => {
  for (const code of ["EVIDENCE_INTEGRITY_FAILED", "SIGNING_KEY_NOT_FOUND", "REPORT_INTEGRITY_MISMATCH", "WORKSPACE_MISMATCH", "NO_PRINCIPAL"]) {
    const req = { state: "FAILED_TERMINAL", terminalReasonCode: code };
    const a = resolveEvidenceOutputActions(facts({ reportRequest: req, packageRequest: req }));
    assert.equal(a.report.action, "NONE", code);
    assert.notEqual(a.report.reason, null, code);
    assert.notEqual(a.report.reason, "ESCALATED_TO_OPERATOR", code);
    assert.equal(a.report.supersedesTechnicalTerminal, undefined, code);
  }
});

test("a lifecycle or workspace restriction withdraws the retry", () => {
  for (const restriction of [{ lifecycleState: "TRASHED" }, { workspaceSuspended: true }, { workspaceClosed: true }]) {
    const f = facts({ reportRequest: TECHNICAL, packageRequest: TECHNICAL });
    f.restrictions = { ...f.restrictions, ...restriction };
    const a = resolveEvidenceOutputActions(f);
    assert.equal(a.report.action, "NONE", JSON.stringify(restriction));
  }
});

test("work in flight offers no second retry", () => {
  for (const state of ["QUEUED", "PROCESSING"]) {
    const live = { state, terminalReasonCode: null };
    const a = resolveEvidenceOutputActions(facts({ reportRequest: live, packageRequest: live }));
    assert.equal(a.report.action, "NONE");
    assert.equal(a.report.reason, "IN_PROGRESS");
  }
});

test("the writer's budget is the ceiling: at MAX supersessions the record is an operator matter again", () => {
  const spent = { ...TECHNICAL, supersessionOrdinal: MAX_TERMINAL_SUPERSESSIONS };
  const a = resolveEvidenceOutputActions(facts({ reportRequest: spent, packageRequest: spent }));
  assert.equal(a.report.action, "NONE");
  assert.equal(a.report.reason, "ESCALATED_TO_OPERATOR");
  const last = { ...TECHNICAL, supersessionOrdinal: MAX_TERMINAL_SUPERSESSIONS - 1 };
  assert.equal(resolveEvidenceOutputActions(facts({ reportRequest: last, packageRequest: last })).report.action, "RETRY");
});

test("report + package technical terminal: a package-only retry, never the report", () => {
  const pkgFailed = { state: "FAILED_TERMINAL", terminalReasonCode: "PACKAGE_RENDER_FAILED", afterLatestReport: false };
  const a = resolveEvidenceOutputActions(
    facts({
      latestReportVersion: 1,
      packageAtLatestReport: false,
      reportRequest: null,
      packageRequest: pkgFailed,
    }),
  );
  assert.equal(a.report.action, "NONE");
  assert.equal(a.report.reason, "NOT_REQUIRED");
  assert.deepEqual(a.verificationPackage, {
    action: "RETRY",
    reason: null,
    operation: "PACKAGE_RECOVERY",
    supersedesTechnicalTerminal: true,
  });
  assert.equal(outputActionLabel("verificationPackage", "RETRY"), "Retry verification package");
  assert.equal(outputActionLabel("verificationPackage", "RECOVER"), "Retry verification package");
});

test("a missing package beside a report is the same package-only verb", () => {
  const a = resolveEvidenceOutputActions(facts({ latestReportVersion: 1, packageAtLatestReport: false }));
  assert.equal(a.verificationPackage.action, "RECOVER");
  assert.equal(a.verificationPackage.operation, "PACKAGE_RECOVERY");
  assert.equal(a.verificationPackage.supersedesTechnicalTerminal, undefined);
});

test("report exists + a failed updated-report attempt: Generate updated report, never a v1 retry", () => {
  const failedUpdate = { ...TECHNICAL, afterLatestReport: true };
  const a = resolveEvidenceOutputActions(
    facts({
      latestReportVersion: 1,
      packageAtLatestReport: true,
      latestPackageVersion: 1,
      reportRequest: failedUpdate,
      packageRequest: failedUpdate,
    }),
  );
  // The report is downloadable; its own decision stays the disclosed escalation.
  assert.equal(a.report.action, "NONE");
  assert.equal(a.report.reason, "ESCALATED_TO_OPERATOR");
  assert.equal(a.newVersion.action, NEW_VERSION_ACTION);
  assert.equal(a.newVersion.nextVersion, 2);
  assert.equal(NEW_VERSION_LABEL, "Generate updated report");
});

test("a retryable failure is still a plain re-run of that request, not a supersession", () => {
  const retryable = { state: "FAILED_RETRYABLE", terminalReasonCode: "REPORT_RENDER_FAILED" };
  const a = resolveEvidenceOutputActions(facts({ reportRequest: retryable, packageRequest: retryable }));
  assert.equal(a.report.action, "RETRY");
  assert.equal(a.report.operation, "RETRY_REQUEST");
  assert.equal(a.report.supersedesTechnicalTerminal, undefined);
});
