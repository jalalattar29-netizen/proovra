/**
 * AUD-011 — a report/package row whose stored file a HEAD of its RECORDED
 * version proved gone, and the AUD-027 operator budget constants.
 *
 *   * the derived state says ARTIFACT_MISSING (never READY / "available");
 *   * an entitled caller is offered ONE new verified version (RECOVER with
 *     operation NEW_VERSION) — never a re-issue of the gone version; a legal
 *     hold, a missing entitlement or a missing permission withdraws it; work in
 *     flight is IN_PROGRESS;
 *   * the download-failure authority offers RECOVER only to a caller the
 *     server says may recover, and never calls a permission failure "missing".
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveEvidenceOutputState,
  MAX_OPERATOR_SUPERSESSIONS_PER_WINDOW,
  MAX_TERMINAL_SUPERSESSIONS,
  OPERATOR_SUPERSESSION_INTENT,
  outputActionLabel,
  resolveArtifactDownloadFailure,
  resolveEvidenceOutputActions,
} from "../dist/index.js";

function facts(over = {}) {
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
    },
    callerMayGenerate: true,
    callerMaySupersede: false,
    newVersionFitsStorage: true,
    ...over,
  };
}

test("a proven-missing stored file derives ARTIFACT_MISSING, not READY; work in flight still reads as in flight", () => {
  const axes = { eligibility: "ELIGIBLE", generation: "SUCCEEDED", availability: "MISSING", record: "FINALIZED" };
  assert.equal(deriveEvidenceOutputState(axes), "ARTIFACT_MISSING");
  assert.equal(deriveEvidenceOutputState({ ...axes, eligibility: "NOT_INCLUDED" }), "ARTIFACT_MISSING");
  assert.equal(deriveEvidenceOutputState({ ...axes, generation: "QUEUED" }), "QUEUED");
  assert.equal(deriveEvidenceOutputState({ ...axes, availability: "READY" }), "READY");
});

test("missing REPORT file: the report offers ONE new verified version; the package follows it", () => {
  const a = resolveEvidenceOutputActions(facts({ storedOutputMissing: "REPORT" }));
  assert.deepEqual(a.report, { action: "RECOVER", reason: null, operation: "NEW_VERSION" });
  assert.deepEqual(a.verificationPackage, { action: "NONE", reason: "FOLLOWS_REPORT", operation: null });
});

test("missing PACKAGE file: the package offers ONE new verified version; the report stays as it is", () => {
  const a = resolveEvidenceOutputActions(facts({ storedOutputMissing: "PACKAGE" }));
  assert.deepEqual(a.verificationPackage, { action: "RECOVER", reason: null, operation: "NEW_VERSION" });
  assert.equal(a.report.reason, "NOT_REQUIRED");
});

test("the recovery is withdrawn by permission, entitlement, hold, storage, and in-flight work", () => {
  const m = { storedOutputMissing: "REPORT" };
  assert.equal(resolveEvidenceOutputActions(facts({ ...m, callerMayGenerate: false })).report.reason, "PERMISSION_DENIED");
  assert.equal(resolveEvidenceOutputActions(facts({ ...m, reportEligibility: "NOT_INCLUDED" })).report.reason, "NOT_INCLUDED");
  assert.equal(
    resolveEvidenceOutputActions(facts({ ...m, restrictions: { ...facts().restrictions, legalHold: true } })).report.reason,
    "LEGAL_HOLD_ACTIVE",
  );
  assert.equal(resolveEvidenceOutputActions(facts({ ...m, newVersionFitsStorage: false })).report.reason, "STORAGE_LIMIT");
  assert.equal(
    resolveEvidenceOutputActions(facts({ ...m, reportRequest: { state: "QUEUED", terminalReasonCode: null } })).report.reason,
    "IN_PROGRESS",
  );
  // Not proven missing (present, unknown, or the store did not answer): nothing to recover.
  assert.equal(resolveEvidenceOutputActions(facts({ storedOutputMissing: null })).report.reason, "NOT_REQUIRED");
});

test("the label names a new verified version, never a rebuild", () => {
  assert.equal(outputActionLabel("report", "RECOVER", "full", "NEW_VERSION"), "Issue a new verified version");
  assert.equal(outputActionLabel("verificationPackage", "RECOVER", "compact", "NEW_VERSION"), "Issue new version");
  assert.equal(outputActionLabel("verificationPackage", "RECOVER"), "Retry verification package");
});

test("download failures: missing offers RECOVER only when permitted; transient retries; permission is never 'missing'", () => {
  const missing = { statusCode: 410, code: "report_artifact_missing" };
  assert.equal(resolveArtifactDownloadFailure("report", missing).action, "NONE");
  assert.equal(resolveArtifactDownloadFailure("report", { ...missing, details: { recoveryPermitted: true } }).action, "RECOVER");
  assert.equal(resolveArtifactDownloadFailure("report", { ...missing, recoveryPermitted: true }).action, "RECOVER");
  const transient = resolveArtifactDownloadFailure("report", { statusCode: 503, code: "STORAGE_UNAVAILABLE" });
  assert.deepEqual([transient.action, transient.retryable], ["RETRY", true]);
  const denied = resolveArtifactDownloadFailure("verificationPackage", { statusCode: 503, code: "STORAGE_ACCESS_FAILED" });
  assert.deepEqual([denied.action, denied.retryable, denied.severity], ["NONE", false, "error"]);
  assert.doesNotMatch(denied.message, /missing/i);
});

test("AUD-027: the operator budget is separate, small and windowed", () => {
  assert.equal(MAX_TERMINAL_SUPERSESSIONS, 5);
  assert.ok(MAX_OPERATOR_SUPERSESSIONS_PER_WINDOW >= 1 && MAX_OPERATOR_SUPERSESSIONS_PER_WINDOW < MAX_TERMINAL_SUPERSESSIONS);
  assert.equal(OPERATOR_SUPERSESSION_INTENT, "OPERATOR_SUPERSEDE");
});
