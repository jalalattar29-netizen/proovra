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
    expect(src).toMatch(/import \{[^}]*\bisExpectedOtsPendingError\b[^}]*\bjobCommandId\b[^}]*\} from "\.\/job-event-context\.js";/);
    expect(src).toContain("isExpectedOtsPendingError(jobKind, err, job)");
    expect(src).not.toMatch(/evidenceId: \(job\.data as JobData \| undefined\)\?\.evidenceId/);
  });
});

describe("dead-letter records (ET-Q-08)", () => {
  it("a final attempt is recognised, and a DLQ code never carries a message or stack", async () => {
    const { isFinalAttempt, boundedErrorCode } = await import("../src/job-event-context.js");
    expect(isFinalAttempt({ attemptsMade: 3, opts: { attempts: 3 } })).toBe(true);
    expect(isFinalAttempt({ attemptsMade: 1, opts: { attempts: 3 } })).toBe(false);
    expect(boundedErrorCode(Object.assign(new Error("s3://bucket/key failed"), { code: "STORAGE_READ_FAILED" }))).toBe("STORAGE_READ_FAILED");
    expect(boundedErrorCode(new Error("OTS_UPGRADE_ATTEMPT_FAILED"))).toBe("OTS_UPGRADE_ATTEMPT_FAILED");
    expect(boundedErrorCode(new Error("could not read /var/app/evidence/secret.bin"))).toBe("Error");
  });

  it("the report DLQ holds terminal failures only and no raw stack; the MI DLQ is written", async () => {
    const { readFileSync } = await import("node:fs");
    const proc = readFileSync(new URL("../src/processor.ts", import.meta.url), "utf8");
    const adds = proc.match(/reportDlqQueue\.add\(/g) ?? [];
    expect(adds.length, "only the non-retriable (terminal) branch writes the report DLQ").toBe(1);
    expect(proc).not.toMatch(/errorStack:/);
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/mediaIntelligenceDlqQueue\s*\.add\(\s*"MediaIntelligenceDLQ"/);
  });
});
