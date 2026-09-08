/**
 * Phase CAPTURE-PLAN-GATE-FIX — P0 Bug 2 + P0 Bug 4 regression lock.
 *
 * The report worker can throw a commercial denial if a plan downgrade or a
 * stale entitlement read happens between API enqueue and worker execution.
 * This is a BUSINESS outcome, not an unhandled server error:
 *
 *   - It MUST NOT call captureException (Sentry alerts).
 *   - It MUST still log at warn so operators can spot the divergence.
 *   - It MUST still discard the job so it does not retry forever.
 *
 * ---------------------------------------------------------------------------
 * COMMERCIAL + EVIDENCE OUTPUT LIFECYCLE CLOSURE (2026-09-08) — TWO CHANGES
 * ---------------------------------------------------------------------------
 * 1. THE DLQ + INCIDENT REQUIREMENT IS WITHDRAWN, deliberately.
 *
 *    "Still DLQs the job (so the failure is visible to operators)" was the
 *    half of this contract that did not survive contact with production. The
 *    DLQ move carried `recordReportFailureIncident({ severity: "CRITICAL" })`
 *    with it, so every workspace on a plan without reports acquired a
 *    permanent critical incident titled "Report generation failure" — for the
 *    product working exactly as sold — offering a Regenerate remediation that
 *    would fail identically. The visibility this asked for was real; the place
 *    it was taken from was wrong. The DURABLE REQUEST ROW records
 *    FAILED_TERMINAL with the bounded reason, the artifact projection turns
 *    that into NOT_INCLUDED for the customer, and the generation authority
 *    treats it as commercially obsolete so a later upgrade supersedes it.
 *
 * 2. THE CLASSIFIER IS SHARED, not a literal message comparison.
 *
 *    `error.message === "REPORT_NOT_INCLUDED_IN_PLAN"` matched exactly one
 *    code and missed `VERIFICATION_PACKAGE_NOT_INCLUDED`, which the package
 *    gate throws with no `retriable` flag — so a package denial was classified
 *    RETRYABLE and burned the whole retry budget on a decision that cannot
 *    change. The set now lives in `isCommerciallyObsoleteTerminalReason`
 *    (@proovra/shared), so the worker's idea of a commercial denial and the
 *    API's — which decides what may be superseded after an upgrade — cannot
 *    drift.
 *
 * The Sentry contract itself is UNCHANGED and still locked below.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROCESSOR_SRC = readFileSync(
  resolve(
    __dirname,
    "..",
    "..",
    "..",
    "services",
    "worker",
    "src",
    "processor.ts",
  ),
  "utf8",
);

describe("worker report plan-gate — Sentry classifier", () => {
  it("source: the denial branch exists in the report-job catch", () => {
    expect(PROCESSOR_SRC).toMatch(/const isPlanDenial\s*=\s*isCommercialDenialError\(error\)/);
    expect(PROCESSOR_SRC).toMatch(/if \(isPlanDenial\) \{/);
  });

  it("source: the classifier is the SHARED one, so it cannot drift from the API's", () => {
    // A literal message comparison matched one code and missed the package
    // denial entirely, which was then classified retryable.
    expect(PROCESSOR_SRC).toMatch(/isCommerciallyObsoleteTerminalReason/);
    expect(PROCESSOR_SRC).not.toMatch(
      /error\.message\s*===\s*"REPORT_NOT_INCLUDED_IN_PLAN"/,
    );
  });

  it("source: captureException is NOT reached by the denial branch", () => {
    const denialAt = PROCESSOR_SRC.indexOf("if (isPlanDenial) {");
    const captureAt = PROCESSOR_SRC.indexOf("captureException(error", denialAt);
    expect(denialAt).toBeGreaterThan(-1);
    expect(captureAt).toBeGreaterThan(denialAt);
    // The branch returns control before the failure path begins.
    expect(PROCESSOR_SRC.slice(denialAt, captureAt)).toMatch(/throw error/);
  });

  it("source: plan-denial branch logs at WARN, not error", () => {
    expect(PROCESSOR_SRC).toMatch(
      /logger\.warn\([\s\S]{0,400}?status:\s*"plan_gate_denied"/,
    );
  });

  it("source: the denial discards the job so it cannot retry a decision that will not change", () => {
    const denialAt = PROCESSOR_SRC.indexOf("if (isPlanDenial) {");
    const captureAt = PROCESSOR_SRC.indexOf("captureException(error", denialAt);
    const branch = PROCESSOR_SRC.slice(denialAt, captureAt);
    expect(branch).toMatch(/job\.discard\(\)/);
  });

  it("source: the denial does NOT DLQ and does NOT open an operational incident", () => {
    // The withdrawn half of the old contract — see the header. A commercial
    // decision is not an outage, and an operator has nothing to acknowledge.
    const denialAt = PROCESSOR_SRC.indexOf("if (isPlanDenial) {");
    const captureAt = PROCESSOR_SRC.indexOf("captureException(error", denialAt);
    const branch = PROCESSOR_SRC.slice(denialAt, captureAt);
    expect(branch).not.toMatch(/reportDlqQueue/);
    expect(branch).not.toMatch(/recordReportFailureIncident/);
  });

  it("source: OTHER failures still DLQ (the DLQ path is intact for real faults)", () => {
    expect(PROCESSOR_SRC).toMatch(/reportDlqQueue\.add\(\s*"ReportDLQ"/);
    expect(PROCESSOR_SRC).toMatch(/recordReportFailureIncident\(\{/);
  });

  it("source: catch block still calls captureException for OTHER errors (regression guard)", () => {
    // Make sure we haven't accidentally suppressed Sentry for every
    // error — only REPORT_NOT_INCLUDED_IN_PLAN is silenced.
    expect(PROCESSOR_SRC).toMatch(
      /captureException\(error,\s*\{\s*requestId,\s*evidenceId,\s*jobId:/,
    );
  });
});
