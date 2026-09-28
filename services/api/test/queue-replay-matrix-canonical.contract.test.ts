/**
 * The replay matrix speaks the canonical queue and job names (2026-09-29).
 *
 * Seven entries once named job kinds no producer emits, so every lookup fell
 * to `unknown` and report replay could never succeed; two queues were absent.
 * This pins the matrix to `QUEUE_NAMES` / `JOB_NAMES` in both directions.
 */
import { describe, expect, it } from "vitest";
import { JOB_NAMES, QUEUE_NAMES } from "@proovra/shared";

import {
  getJobReplayCategory,
  getReplaySafetyMatrix,
  KNOWN_QUEUE_NAMES,
} from "../src/services/operations/queue-replay-safety.service.js";

const JOB_VALUES = new Set<string>(Object.values(JOB_NAMES));

describe("queue replay matrix ↔ canonical registry", () => {
  it("every live-queue entry names a job kind a producer actually emits", () => {
    for (const e of getReplaySafetyMatrix()) {
      if (e.queueName.endsWith("-dlq")) continue; // DLQ entries are triage records
      expect(JOB_VALUES.has(e.jobKind), `${e.queueName}:${e.jobKind}`).toBe(true);
    }
  });

  it("every canonical queue is known to Operations", () => {
    for (const q of Object.values(QUEUE_NAMES)) {
      expect(KNOWN_QUEUE_NAMES, q).toContain(q);
    }
  });

  it("report generation is replayable under step-up; a DLQ triage record is not", () => {
    expect(getJobReplayCategory(QUEUE_NAMES.REPORT, JOB_NAMES.GENERATE_REPORT)).toBe("requires_step_up");
    expect(getJobReplayCategory(QUEUE_NAMES.REPORT_DLQ, "ReportDLQ")).toBe("forbidden");
    expect(getJobReplayCategory(QUEUE_NAMES.EVIDENCE_PURGE, JOB_NAMES.PURGE_DELETED_EVIDENCE)).toBe("forbidden");
  });
});
