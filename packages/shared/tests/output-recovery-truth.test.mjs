/**
 * OUTPUT RECOVERY TRUTH (2026-10-12) — what the Artifacts tab is offered and
 * told, for the failures that cannot be fixed by trying again and for the
 * refusals the request authority makes.
 *
 *   * deterministic worker refusals (an unreadable original, an output that
 *     failed its own verification) are INTEGRITY, never a Retry;
 *   * a first report that awaits confirmed payment (trial / grace, nothing
 *     earned at finalization) is withheld with its own reason, not offered as
 *     Generate and then refused;
 *   * a declined request with no bounded reason is read by its OUTCOME, never
 *     as "a newer version already exists".
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyTerminalReason,
  MAX_TERMINAL_SUPERSESSIONS,
  outputNoteCopy,
  outputTerminalReasonCopy,
  outputUnavailableReasonCopy,
  outputUnavailableReasonShort,
  resolveEvidenceOutputActions,
  resolveOutputOperationError,
} from "../dist/index.js";

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

// A confirmed missing original: no retry or release brings it back.
const DETERMINISTIC = ["EVIDENCE_ORIGINAL_NOT_FOUND"];
// The product's own render/seal check: a corrected release removes the cause,
// and the bounded, audited supersession is the canonical recovery.
const OUTPUT_VERIFICATION = ["REPORT_OUTPUT_INCONSISTENT", "PACKAGE_OUTPUT_INCONSISTENT", "REPORT_RENDER_INPUT_INCONSISTENT"];

test("a confirmed missing original classifies INTEGRITY (any case)", () => {
  for (const code of DETERMINISTIC) {
    assert.equal(classifyTerminalReason(code), "INTEGRITY", code);
    assert.equal(classifyTerminalReason(code.toLowerCase()), "INTEGRITY", code);
  }
  assert.equal(classifyTerminalReason("REPORT_RENDER_FAILED"), "TECHNICAL");
});

test("output-verification refusals stay TECHNICAL: the supersession-right holder is offered the bounded Retry", () => {
  for (const code of OUTPUT_VERIFICATION) {
    assert.equal(classifyTerminalReason(code), "TECHNICAL", code);
    const terminal = { state: "FAILED_TERMINAL", terminalReasonCode: code };
    const first = resolveEvidenceOutputActions(facts({ reportRequest: terminal, packageRequest: terminal }));
    assert.equal(first.report.action, "RETRY", code);
  }
});

test("a deterministic refusal is never offered as Retry, even to the supersession-right holder", () => {
  for (const code of DETERMINISTIC) {
    const terminal = { state: "FAILED_TERMINAL", terminalReasonCode: code };
    const first = resolveEvidenceOutputActions(facts({ reportRequest: terminal, packageRequest: terminal }));
    assert.equal(first.report.action, "NONE", code);
    assert.equal(first.report.reason, "INTEGRITY_FAILED", code);
    const pkg = resolveEvidenceOutputActions(
      facts({ latestReportVersion: 1, packageRequest: terminal }),
    );
    assert.equal(pkg.verificationPackage.action, "NONE", code);
  }
});

test("an output that failed its own verification says so, and not that the record failed integrity", () => {
  for (const code of OUTPUT_VERIFICATION) {
    const copy = outputNoteCopy({ actionUnavailableReason: "ESCALATED_TO_OPERATOR", terminalReasonCode: code });
    assert.ok(copy, code);
    assert.match(copy, /did not pass its check/);
    assert.match(copy, /fingerprint, signature and custody history are unchanged/);
    assert.doesNotMatch(copy, /retries were exhausted/i);
    assert.ok(outputTerminalReasonCopy(code)?.short);
  }
});

test("the writer's budget, spent, settles to ESCALATED_TO_OPERATOR — no Retry loop", () => {
  const at = (ordinal) =>
    resolveEvidenceOutputActions(
      facts({
        reportRequest: { state: "FAILED_TERMINAL", terminalReasonCode: "REPORT_RENDER_FAILED", supersessionOrdinal: ordinal },
      }),
    ).report;
  assert.equal(at(MAX_TERMINAL_SUPERSESSIONS - 1).action, "RETRY");
  assert.deepEqual(at(MAX_TERMINAL_SUPERSESSIONS), { action: "NONE", reason: "ESCALATED_TO_OPERATOR", operation: null });
});

test("a first report awaiting confirmed payment is withheld with its own reason", () => {
  const a = resolveEvidenceOutputActions(facts({ firstIssuanceAwaitsConfirmedPayment: true }));
  assert.deepEqual(a.report, { action: "NONE", reason: "AWAITING_CONFIRMED_PAYMENT", operation: null });
  assert.equal(a.verificationPackage.action, "NONE");
  assert.match(outputUnavailableReasonCopy("AWAITING_CONFIRMED_PAYMENT") ?? "", /payment is confirmed/);
  assert.equal(outputUnavailableReasonShort("AWAITING_CONFIRMED_PAYMENT"), "Awaiting confirmed payment");
});

test("awaiting payment withholds a supersession (a new first-issuance request) but not a re-run", () => {
  const technical = { state: "FAILED_TERMINAL", terminalReasonCode: "REPORT_RENDER_FAILED" };
  const superseded = resolveEvidenceOutputActions(
    facts({ firstIssuanceAwaitsConfirmedPayment: true, reportRequest: technical }),
  );
  assert.equal(superseded.report.reason, "AWAITING_CONFIRMED_PAYMENT");
  const retryable = resolveEvidenceOutputActions(
    facts({ firstIssuanceAwaitsConfirmedPayment: true, reportRequest: { state: "FAILED_RETRYABLE", terminalReasonCode: null } }),
  );
  assert.equal(retryable.report.action, "RETRY");
});

test("the fact is inert once a report exists, or when absent", () => {
  const withReport = resolveEvidenceOutputActions(
    facts({ firstIssuanceAwaitsConfirmedPayment: true, latestReportVersion: 1, packageAtLatestReport: false }),
  );
  assert.equal(withReport.verificationPackage.action, "RECOVER");
  assert.equal(resolveEvidenceOutputActions(facts()).report.action, "GENERATE");
});

test("a declined request is read by reason, then OUTCOME, before the 409 fallback", () => {
  const k = (input) => resolveOutputOperationError(input).key;
  const base = { status: 409, code: "OUTPUT_ACTION_UNAVAILABLE" };
  assert.equal(k({ ...base, reason: "AWAITING_CONFIRMED_PAYMENT" }), "PAYMENT_CONFIRMATION_REQUIRED");
  assert.equal(k({ ...base, reason: "WORKSPACE_UNRESOLVED" }), "WORKSPACE_UNRESOLVED");
  assert.equal(k({ ...base, reason: null, outcome: "NOT_INCLUDED" }), "PLAN_REFUSED");
  assert.equal(k({ ...base, reason: null, outcome: "WORKSPACE_UNRESOLVED" }), "WORKSPACE_UNRESOLVED");
  assert.equal(k({ ...base, reason: null, outcome: "RECOVERABLE_BLOCKED" }), "POLICY_REFUSED");
  // No reason and no outcome: the previous fallback is unchanged.
  assert.equal(k({ ...base, reason: null }), "VERSION_CONFLICT");
});
