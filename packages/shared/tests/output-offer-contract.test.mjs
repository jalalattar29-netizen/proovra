/**
 * THE UPDATED-REPORT CONTRACT — offer binding, freshness, durable progress and
 * the typed operation-error authority (RGA-01 / RGA-02 / Artifacts & Versions).
 *
 * Executed against the BUILT module, the same file the API, web and native load.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  OUTPUT_OFFER_BINDING_FIELDS,
  OUTPUT_OPERATION_ERROR_KEYS,
  OUTPUT_OPERATION_ERRORS,
  canonicalizeOutputOfferBinding,
  deriveReportFreshness,
  diffOutputOfferBindings,
  outputOfferChangeCopy,
  outputOperationErrorForReason,
  outputOperationErrorForTerminal,
  projectOutputProgress,
  resolveOutputOperationError,
} from "../dist/output-offer.js";

const binding = (over = {}) => ({
  evidenceId: "e1",
  workspaceId: "w1",
  callerUserId: "u1",
  latestReportVersion: 1,
  pairedPackageVersion: 1,
  latestPackageVersion: 1,
  reportableFacts: "status:REPORTED|tsa:FAILED:-:x|ots:PENDING:-:-|custody:4|verified:-",
  tsa: "FAILED|not-validated",
  ots: "PENDING|-",
  reportAction: "NONE:NOT_REQUIRED",
  packageAction: "NONE:NOT_REQUIRED",
  newVersionAction: "CREATE_NEW_VERSION:-:v2",
  targetVersion: 2,
  activeRequest: "r1:SUCCEEDED",
  callerMayGenerate: true,
  eligibility: "ELIGIBLE|ELIGIBLE",
  creditEffect: "NONE",
  storageEffect: "2048|yes",
  reasonRequired: true,
  ...over,
});

test("an unchanged binding has no changes and a stable canonical form", () => {
  assert.deepEqual(diffOutputOfferBindings(binding(), binding()), []);
  assert.equal(canonicalizeOutputOfferBinding(binding()), canonicalizeOutputOfferBinding(binding()));
  // Every field is part of the canonical form.
  const canon = JSON.parse(canonicalizeOutputOfferBinding(binding()));
  assert.deepEqual(canon.map(([k]) => k), [...OUTPUT_OFFER_BINDING_FIELDS]);
});

test("each bound fact maps to its own change code", () => {
  const cases = [
    [{ tsa: "STAMPED|validated", reportableFacts: "changed" }, ["TSA_CHANGED"]],
    [{ ots: "ANCHORED|PROOF_STRUCTURE", reportableFacts: "changed" }, ["OTS_CHANGED"]],
    [{ latestReportVersion: 2, targetVersion: 3 }, ["LATEST_REPORT_CHANGED"]],
    [{ activeRequest: "r2:QUEUED" }, ["REQUEST_STATE_CHANGED"]],
    [{ callerMayGenerate: false }, ["PERMISSION_CHANGED"]],
    [{ eligibility: "NOT_INCLUDED|NOT_INCLUDED" }, ["ELIGIBILITY_CHANGED"]],
    [{ storageEffect: "2048|no" }, ["STORAGE_CHANGED"]],
    [{ newVersionAction: "NONE:IN_PROGRESS:v2" }, ["ACTIONS_CHANGED"]],
    [{ evidenceId: "e2" }, ["SUBJECT_MISMATCH"]],
    [{ workspaceId: "w2" }, ["SUBJECT_MISMATCH"]],
    [{ reportableFacts: "custody changed" }, ["REPORTABLE_FACTS_CHANGED"]],
  ];
  for (const [over, expected] of cases) {
    assert.deepEqual(diffOutputOfferBindings(binding(), binding(over)), expected, JSON.stringify(over));
  }
  for (const code of ["TSA_CHANGED", "OFFER_EXPIRED", "SUBJECT_MISMATCH"]) {
    assert.ok(outputOfferChangeCopy(code).length > 10);
  }
});

test("freshness: TSA validated and OTS anchored after the report are reported; nothing is invented", () => {
  const base = {
    reportVersion: 1,
    reportGeneratedAtUtc: "2026-10-06T10:00:00.000Z",
    tsa: { status: "STAMPED", validatedAtUtc: "2026-10-06T11:00:00.000Z" },
    ots: { status: "ANCHORED", anchoredAtUtc: "2026-10-06T12:00:00.000Z", upgradedAtUtc: null },
    custodyAfterReport: { count: 0, latestAtUtc: null },
    integrity: { lastVerifiedAtUtc: null, reportLastVerifiedAtUtc: null },
  };
  const fresh = deriveReportFreshness(base);
  assert.equal(fresh.hasNewerFacts, true);
  assert.deepEqual(fresh.changes.map((c) => c.code), ["TSA_VALIDATED_AFTER_REPORT", "OTS_ANCHORED_AFTER_REPORT"]);

  // Validated BEFORE the report: no false freshness.
  const before = deriveReportFreshness({
    ...base,
    tsa: { status: "STAMPED", validatedAtUtc: "2026-10-06T09:00:00.000Z" },
    ots: { status: "PENDING", anchoredAtUtc: null, upgradedAtUtc: null },
  });
  assert.equal(before.hasNewerFacts, false);
  assert.deepEqual(before.changes, []);

  // A FAILED timestamp is not "validated", whatever its time fields say.
  const failed = deriveReportFreshness({ ...base, tsa: { status: "FAILED", validatedAtUtc: null }, ots: { status: "PENDING", anchoredAtUtc: null, upgradedAtUtc: null } });
  assert.equal(failed.hasNewerFacts, false);

  // No report → nothing is newer than it.
  assert.equal(deriveReportFreshness({ ...base, reportVersion: null, reportGeneratedAtUtc: null }).hasNewerFacts, false);

  // Custody changes carry their count.
  const custody = deriveReportFreshness({
    ...base,
    tsa: { status: "STAMPED", validatedAtUtc: null },
    ots: { status: "PENDING", anchoredAtUtc: null, upgradedAtUtc: null },
    custodyAfterReport: { count: 2, latestAtUtc: "2026-10-06T13:00:00.000Z" },
  });
  assert.deepEqual(custody.changes, [{ code: "CUSTODY_CHANGED_AFTER_REPORT", atUtc: "2026-10-06T13:00:00.000Z", count: 2 }]);
});

test("progress is derived only from persisted columns", () => {
  const p = (state, stage, progressStage, artifactType = "REPORT") =>
    projectOutputProgress({ state, stage, progressStage, artifactType });
  const statusOf = (v, key) => v.steps.find((s) => s.key === key).status;

  const queued = p("QUEUED", null, null);
  assert.equal(queued.currentStep, "QUEUED");
  assert.equal(statusOf(queued, "ACCEPTED"), "done");
  assert.equal(statusOf(queued, "QUEUED"), "current");

  // A re-queued retry is waiting again, not "verifying".
  assert.equal(p("QUEUED", "REPORT_RESERVED", "VERIFYING_REPORT").currentStep, "QUEUED");

  assert.equal(p("PROCESSING", null, null).currentStep, "GENERATING_REPORT");
  assert.equal(p("PROCESSING", "REPORT_RESERVED", "RENDERING_REPORT").currentStep, "GENERATING_REPORT");
  assert.equal(p("PROCESSING", "REPORT_RESERVED", "VERIFYING_REPORT").currentStep, "VERIFYING_REPORT");
  assert.equal(p("PROCESSING", "REPORT_COMMITTED", "VERIFYING_REPORT").currentStep, "BUILDING_PACKAGE");
  assert.equal(p("PROCESSING", "REPORT_COMMITTED", "VERIFYING_PACKAGE").currentStep, "VERIFYING_PACKAGE");

  const done = p("SUCCEEDED", "PACKAGE_PUBLISHED", "VERIFYING_PACKAGE");
  assert.equal(done.outcome, "SUCCEEDED");
  assert.ok(done.steps.every((s) => s.status === "done"));

  const failed = p("FAILED_TERMINAL", "REPORT_COMMITTED", "BUILDING_PACKAGE");
  assert.equal(failed.outcome, "FAILED");
  assert.equal(statusOf(failed, "BUILDING_PACKAGE"), "failed");
  assert.equal(statusOf(failed, "COMPLETE"), "pending");
  assert.equal(statusOf(failed, "GENERATING_REPORT"), "done");

  // A package-only recovery skips the report steps.
  const pkg = p("PROCESSING", null, "VERIFYING_PACKAGE", "VERIFICATION_PACKAGE");
  assert.equal(statusOf(pkg, "GENERATING_REPORT"), "skipped");
  assert.equal(statusOf(pkg, "VERIFYING_REPORT"), "skipped");
  assert.equal(pkg.currentStep, "VERIFYING_PACKAGE");
});

test("every operation error carries a safe title, description, severity, retryability and action", () => {
  for (const key of OUTPUT_OPERATION_ERROR_KEYS) {
    const e = OUTPUT_OPERATION_ERRORS[key];
    assert.ok(e.title && e.description, key);
    assert.ok(["info", "warning", "error"].includes(e.severity), key);
    assert.equal(typeof e.retryable, "boolean");
    assert.ok(["RETRY", "RECOVER", "REFRESH", "CONTACT_SUPPORT", "NONE"].includes(e.action), key);
    assert.equal(typeof e.showSupportReference, "boolean");
    // Never a storage key, bucket, URL or stack-like text.
    assert.doesNotMatch(`${e.title} ${e.description}`, /s3:|bucket|https?:|stack|Error:|\/reports\//i, key);
  }
});

test("the response resolver maps the endpoint's bounded answers", () => {
  const k = (input) => resolveOutputOperationError(input).key;
  assert.equal(k({ status: 409, code: "OUTPUT_OFFER_STALE" }), "OFFER_STALE");
  assert.equal(k({ status: 409, code: "OUTPUT_OFFER_REQUIRED" }), "OFFER_STALE");
  assert.equal(k({ status: 400, code: "UPDATED_REPORT_REASON_REQUIRED" }), "REASON_INVALID");
  assert.equal(k({ status: 403, code: "GENERATION_NOT_PERMITTED" }), "PERMISSION_REFUSED");
  assert.equal(k({ status: 404 }), "MEMBERSHIP_REFUSED");
  assert.equal(k({ status: 409, code: "OUTPUT_ACTION_UNAVAILABLE", reason: "IN_PROGRESS" }), "REQUEST_ACTIVE");
  assert.equal(k({ status: 409, code: "OUTPUT_ACTION_UNAVAILABLE", reason: "STORAGE_LIMIT" }), "STORAGE_REFUSED");
  assert.equal(k({ status: 409, code: "OUTPUT_ACTION_UNAVAILABLE", reason: "NOT_INCLUDED" }), "PLAN_REFUSED");
  assert.equal(k({ status: 409, code: "OUTPUT_ACTION_UNAVAILABLE", reason: "LEGAL_HOLD_ACTIVE" }), "LEGAL_HOLD");
  assert.equal(k({ status: 409, code: "EVIDENCE_INTEGRITY_FAILED" }), "INTEGRITY_TERMINAL");
  assert.equal(k({ status: 429, code: "RATE_LIMITED" }), "RATE_LIMITED");
  assert.equal(k({ status: 503 }), "QUEUE_UNAVAILABLE");
  assert.equal(k({ status: 410, code: "report_artifact_missing" }), "REPORT_OBJECT_MISSING");
  assert.equal(k({ status: 410, code: "verification_package_artifact_missing" }), "PACKAGE_OBJECT_MISSING");
  assert.equal(k({ network: true }), "OFFER_LOAD_FAILED");
  assert.equal(k({ status: 500, code: "SOMETHING_NEW" }), "UNKNOWN");
  assert.equal(outputOperationErrorForReason("ESCALATED_TO_OPERATOR").key, "RETRY_BUDGET_EXHAUSTED");
  assert.equal(outputOperationErrorForReason("NOT_REQUIRED"), null);
});

test("a terminal request maps to the step it failed in; integrity never offers a retry", () => {
  const t = (code, failedStep, budgetExhausted) =>
    outputOperationErrorForTerminal({ terminalReasonCode: code, failedStep, budgetExhausted });
  assert.equal(t("REPORT_INTEGRITY_MISMATCH", "BUILDING_PACKAGE").key, "INTEGRITY_TERMINAL");
  assert.equal(t("REPORT_INTEGRITY_MISMATCH", "BUILDING_PACKAGE").retryable, false);
  assert.equal(t("RENDER_TIMEOUT", "GENERATING_REPORT").key, "REPORT_RENDER_FAILED");
  assert.equal(t("S3_PUT_FAILED", "VERIFYING_REPORT").key, "REPORT_PUBLICATION_FAILED");
  assert.equal(t("CHECKSUM_MISMATCH", "VERIFYING_PACKAGE").key, "PACKAGE_READBACK_FAILED");
  assert.equal(t("ZIP_FAILED", "BUILDING_PACKAGE").key, "PACKAGE_RENDER_FAILED");
  assert.equal(t("ANYTHING", "GENERATING_REPORT", true).key, "RETRY_BUDGET_EXHAUSTED");
  assert.equal(t("LEGAL_HOLD_ACTIVE", null).key, "LEGAL_HOLD");
});
