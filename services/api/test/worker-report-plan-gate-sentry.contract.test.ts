/**
 * Phase CAPTURE-PLAN-GATE-FIX — P0 Bug 2 + P0 Bug 4 regression lock.
 *
 * The report worker can throw `REPORT_NOT_INCLUDED_IN_PLAN` if a plan
 * downgrade or stale entitlement read happens between API enqueue
 * and worker execution. This is a BUSINESS outcome, not an unhandled
 * server error:
 *
 *   - It MUST NOT call captureException (Sentry alerts).
 *   - It MUST still log at warn so operators can spot the divergence.
 *   - It MUST still discard the job + DLQ so it doesn't retry forever.
 *
 * Source-level contract on services/worker/src/processor.ts:
 *
 *   The catch block must branch on `error.message === "REPORT_NOT_
 *   INCLUDED_IN_PLAN"` and skip captureException in that branch only.
 *   Every other failure path keeps reporting to Sentry.
 *
 * This file locks the contract by reading the source and asserting
 * the branch is present in the exact shape that achieves it.
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
  it("source: `isPlanDenial` branch exists in the report-job catch", () => {
    expect(PROCESSOR_SRC).toMatch(
      /const isPlanDenial\s*=\s*error instanceof Error\s*&&\s*error\.message\s*===\s*"REPORT_NOT_INCLUDED_IN_PLAN"/,
    );
  });

  it("source: captureException is GUARDED by `!isPlanDenial`", () => {
    expect(PROCESSOR_SRC).toMatch(
      /if\s*\(\s*!isPlanDenial\s*\)\s*\{\s*captureException\(error,/,
    );
  });

  it("source: plan-denial branch logs at WARN, not error", () => {
    expect(PROCESSOR_SRC).toMatch(
      /logger\.warn\([\s\S]{0,300}?status:\s*"plan_gate_denied"/,
    );
  });

  it("source: still DLQs the job (so the failure is visible to operators)", () => {
    // The DLQ insert lives in the same catch but AFTER the
    // classifier. We just assert it still exists in the same handler.
    expect(PROCESSOR_SRC).toMatch(/reportDlqQueue\.add\(\s*"ReportDLQ"/);
  });

  it("source: catch block still calls captureException for OTHER errors (regression guard)", () => {
    // Make sure we haven't accidentally suppressed Sentry for every
    // error — only REPORT_NOT_INCLUDED_IN_PLAN is silenced.
    expect(PROCESSOR_SRC).toMatch(
      /captureException\(error,\s*\{\s*requestId,\s*evidenceId,\s*jobId:/,
    );
  });
});
