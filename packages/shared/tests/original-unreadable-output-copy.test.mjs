/**
 * AN UNREADABLE SIGNED ORIGINAL — WHAT EVERY SURFACE SAYS (2026-09-29).
 *
 * The worker stops on the FIRST confirmed store 404 for an original and
 * records the terminal code EVIDENCE_ORIGINAL_NOT_FOUND. The lifecycle
 * resolves it as operator escalation (no routine verb), whose reason copy says
 * "Automatic retries were exhausted" — false here. Surfaces that hold the
 * bounded terminal code read `outputNoteCopy` / `outputNoteShort`, which name
 * the real condition.
 *
 * Pinned:
 *   * no Recover / Retry / Generate is offered for the output;
 *   * the note is distinct, operator-visible, and never says retries were
 *     exhausted, that the original was destroyed, or that its hash/signature
 *     failed;
 *   * nothing storage-identifying is in the copy;
 *   * every other code keeps its existing copy (no regression).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ORIGINAL_NOT_READABLE_TERMINAL_CODE,
  outputNoteCopy,
  outputNoteShort,
  outputTerminalReasonCopy,
  outputUnavailableReasonCopy,
  outputUnavailableReasonShort,
  resolveEvidenceOutputActions,
} from "../dist/index.js";

const CODE = "EVIDENCE_ORIGINAL_NOT_FOUND";

function facts(over = {}) {
  return {
    record: "FINALIZED",
    reportEligibility: "ELIGIBLE",
    packageEligibility: "ELIGIBLE",
    latestReportVersion: 1,
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
    newVersionFitsStorage: true,
    ...over,
  };
}

test("the terminal code constant matches the worker's", () => {
  assert.equal(ORIGINAL_NOT_READABLE_TERMINAL_CODE, CODE);
});

test("a package recovery stopped by an unreadable original offers NO routine verb", () => {
  const a = resolveEvidenceOutputActions(
    facts({ packageRequest: { state: "FAILED_TERMINAL", terminalReasonCode: CODE } }),
  );
  assert.equal(a.verificationPackage.action, "NONE");
  assert.notEqual(a.verificationPackage.operation, "PACKAGE_RECOVERY");
});

test("a first report stopped by an unreadable original offers NO routine verb", () => {
  const a = resolveEvidenceOutputActions(
    facts({
      latestReportVersion: null,
      reportRequest: { state: "FAILED_TERMINAL", terminalReasonCode: CODE },
      packageRequest: { state: "FAILED_TERMINAL", terminalReasonCode: CODE },
    }),
  );
  assert.equal(a.report.action, "NONE");
  assert.equal(a.verificationPackage.action, "NONE");
});

test("the note names the real condition, not exhausted retries", () => {
  const a = resolveEvidenceOutputActions(
    facts({ packageRequest: { state: "FAILED_TERMINAL", terminalReasonCode: CODE } }),
  );
  const output = {
    actionUnavailableReason: a.verificationPackage.reason,
    terminalReasonCode: CODE,
  };
  const copy = outputNoteCopy(output);
  const short = outputNoteShort(output);
  assert.ok(copy && short);
  assert.match(copy, /signed original cannot currently be read from storage/);
  assert.match(copy, /No report or package was built from replacement bytes/);
  assert.match(copy, /sent for operator review/);
  assert.match(short, /operator review/);
  for (const text of [copy, short]) {
    assert.doesNotMatch(text, /retries were exhausted/i);
    assert.doesNotMatch(text, /destroy|deleted|lost|tamper/i);
    assert.doesNotMatch(text, /integrity check|hash (did not|does not) match|signature (failed|invalid)/i);
    // Nothing storage-identifying.
    assert.doesNotMatch(text, /evidence\/|s3:|bucket|\.jpg|\.png|parts\//i);
  }
  // …and the copy it replaces is the one that would have been wrong.
  assert.match(outputUnavailableReasonCopy(a.verificationPackage.reason) ?? "", /retries were exhausted/);
});

test("matching is exact and case-insensitive on the bounded code only", () => {
  assert.ok(outputTerminalReasonCopy(CODE.toLowerCase()));
  assert.equal(outputTerminalReasonCopy("EVIDENCE_OBJECT_NOT_FOUND"), null);
  assert.equal(outputTerminalReasonCopy("NotFound"), null);
  assert.equal(outputTerminalReasonCopy(null), null);
});

test("every other terminal code keeps its existing reason copy", () => {
  for (const reason of ["ESCALATED_TO_OPERATOR", "REPORT_INTEGRITY_REVIEW", "LEGAL_HOLD_ACTIVE", "NOT_REQUIRED"]) {
    for (const code of [null, "retry_budget_exhausted", "REPORT_OBJECT_MISSING"]) {
      const output = { actionUnavailableReason: reason, terminalReasonCode: code };
      assert.equal(outputNoteCopy(output), outputUnavailableReasonCopy(reason), `${reason}/${code}`);
      assert.equal(outputNoteShort(output), outputUnavailableReasonShort(reason), `${reason}/${code}`);
    }
  }
});
