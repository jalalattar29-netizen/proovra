/**
 * ET-Q-09 — job-event logging reads the canonical commandId, OTS transient
 * failures are pending retries until the last attempt, and a rejected payload
 * is not retried.
 */
import { UnrecoverableError } from "bullmq";
import { describe, expect, it } from "vitest";

import { UnprocessableJobPayload } from "../src/canonical-job.js";
import { isExpectedOtsPendingError, jobCommandId } from "../src/job-event-context.js";

describe("worker job-event context (ET-Q-09)", () => {
  it("logs the canonical commandId (a legacy evidenceId only as a fallback)", () => {
    expect(jobCommandId({ data: { commandId: "run-1", traceId: "t", schemaVersion: 1 } })).toBe("run-1");
    expect(jobCommandId({ data: { evidenceId: "ev-1" } })).toBe("ev-1");
    expect(jobCommandId({ data: {} })).toBeUndefined();
  });

  it("an OTS transient attempt failure is a pending retry, except on the last attempt", () => {
    const err = new Error("OTS_UPGRADE_ATTEMPT_FAILED");
    expect(isExpectedOtsPendingError("ots-upgrade", err, { attemptsMade: 3, opts: { attempts: 20 } })).toBe(true);
    expect(isExpectedOtsPendingError("ots-upgrade", err, { attemptsMade: 20, opts: { attempts: 20 } })).toBe(false);
    expect(isExpectedOtsPendingError("ots-upgrade", new Error("MALFORMED_PROOF"), { attemptsMade: 1, opts: { attempts: 20 } })).toBe(false);
    expect(isExpectedOtsPendingError("report", err, { attemptsMade: 1, opts: { attempts: 5 } })).toBe(false);
  });

  it("a rejected payload is an UnrecoverableError, so BullMQ does not retry it", () => {
    const e = new UnprocessableJobPayload("malformed", "bad payload");
    expect(e).toBeInstanceOf(UnrecoverableError);
    expect(e.name).toBe("UnprocessableJobPayload");
    expect(e.retryable).toBe(false);
  });
});

describe("the worker's event handlers use these rules (ET-Q-09)", () => {
  it("index.ts classifies and logs through job-event-context, not payload.evidenceId", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(src).toContain('import { isExpectedOtsPendingError, jobCommandId } from "./job-event-context.js";');
    expect(src).toContain("isExpectedOtsPendingError(jobKind, err, job)");
    expect(src).not.toMatch(/evidenceId: \(job\.data as JobData \| undefined\)\?\.evidenceId/);
  });
});
