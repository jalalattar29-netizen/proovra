/**
 * PHASE 2 — A BUSINESS REFUSAL IS NOT A FAILURE (2026-10-20, AUD-03 / AUD-41).
 *
 * Production (AUD-03): a plan refusal was `job.discard(); throw`, and BullMQ's
 * `failed` event reached the binding every worker shares — `captureException`
 * plus a CRITICAL `operational.alert` for an expected answer. The regex pin
 * that claimed to cover it read processor.ts and never saw this binding.
 *
 * These cases drive the REAL `bindWorkerEvents` (extracted from index.ts):
 *   1. through its own handlers, always — the binding's decisions;
 *   2. through a REAL BullMQ Worker on Redis when P7_TEST_REDIS_URL is
 *      set (local disposable Redis; CI runs it in the infrastructure step with
 *      a fail-on-zero guard) — the queue's own delivery of `failed`.
 */
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ captured: [] as unknown[] }));
vi.mock("../src/sentry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sentry.js")>();
  return { ...actual, captureException: (err: unknown) => void sentry.captured.push(err) };
});

import { logger } from "../src/logger.js";
import { OutputProductionRefusedError } from "../src/output-production-refusal.js";
import { bindWorkerEvents } from "../src/worker-events.js";

function alertsFrom(spy: ReturnType<typeof vi.spyOn>): number {
  return spy.mock.calls.filter((c) => c[1] === "operational.alert").length;
}

const job = (attemptsMade = 1) => ({
  id: "job-1",
  attemptsMade,
  opts: { attempts: 5 },
  data: { commandId: "req-1" },
  finishedOn: Date.now(),
  processedOn: Date.now() - 5,
});

afterEach(() => {
  sentry.captured.length = 0;
  vi.restoreAllMocks();
});

describe("the worker event binding (real handlers)", () => {
  it("a business refusal reaching `failed` is not captured and raises no critical alert", () => {
    const error = vi.spyOn(logger, "error");
    const emitter = new EventEmitter();
    bindWorkerEvents(emitter as never, "report");
    emitter.emit("failed", job(), new OutputProductionRefusedError("NOT_APPLICABLE_NOT_ENTITLED"));
    emitter.emit("failed", job(), new OutputProductionRefusedError("NOT_APPLICABLE_STORAGE_LIMIT"));
    emitter.emit("failed", job(), new OutputProductionRefusedError("NOT_APPLICABLE_ARCHIVED"));
    expect(sentry.captured).toEqual([]);
    expect(alertsFrom(error)).toBe(0);
  });

  it("a genuine technical failure is still captured and alerted", () => {
    const error = vi.spyOn(logger, "error");
    const emitter = new EventEmitter();
    bindWorkerEvents(emitter as never, "report");
    const technical = Object.assign(new Error("REPORT_PDF_VERIFICATION_FAILED"), { code: "REPORT_PDF_VERIFICATION_FAILED" });
    emitter.emit("failed", job(5), technical);
    expect(sentry.captured).toEqual([technical]);
    expect(alertsFrom(error)).toBe(1);
  });
});

describe("PHASE 3 — a transient database error in the OTS job (P2028 / AUD-41)", () => {
  const p2028 = () => Object.assign(new Error("Transaction API error: Unable to start a transaction in the given time."), { code: "P2028" });

  it("is retried quietly before the last attempt: no Sentry event, no critical alert", () => {
    const error = vi.spyOn(logger, "error");
    const emitter = new EventEmitter();
    bindWorkerEvents(emitter as never, "ots-upgrade");
    for (let attemptsMade = 1; attemptsMade < 20; attemptsMade += 1) {
      emitter.emit("failed", { ...job(attemptsMade), opts: { attempts: 20 } }, p2028());
    }
    expect(sentry.captured).toEqual([]);
    expect(alertsFrom(error)).toBe(0);
  });

  it("escalates exactly once, on retry exhaustion", () => {
    const error = vi.spyOn(logger, "error");
    const emitter = new EventEmitter();
    bindWorkerEvents(emitter as never, "ots-upgrade");
    emitter.emit("failed", { ...job(20), opts: { attempts: 20 } }, p2028());
    expect(sentry.captured).toHaveLength(1);
    expect(alertsFrom(error)).toBe(1);
  });

  it("the OTS retry policy is bounded exponential WITH jitter", async () => {
    const { RETRY_POLICIES } = await import("@proovra/shared");
    const policy = RETRY_POLICIES.TIMESTAMP_AUTHORITY as { attempts: number; backoff: string; backoffJitter?: number };
    expect(policy.backoff).toBe("exponential");
    expect(policy.attempts).toBeLessThanOrEqual(20);
    expect(policy.backoffJitter ?? 0).toBeGreaterThan(0);
  });
});

const REDIS_URL = process.env.P7_TEST_REDIS_URL;

describe.runIf(Boolean(REDIS_URL))("the worker event binding (real BullMQ on Redis)", () => {
  it("BullMQ delivers `failed` for a refusal and for a technical error; only the technical one escalates", async () => {
    const { Queue, Worker } = await import("bullmq");
    const url = new URL(REDIS_URL!);
    const connection = { host: url.hostname, port: Number(url.port || 6379) };
    const name = `phase2-events-${Date.now()}`;
    const queue = new Queue(name, { connection });
    const error = vi.spyOn(logger, "error");
    let failedEvents = 0;
    const worker = new Worker(
      name,
      async (j) => {
        await j.discard();
        if (j.name === "refusal") throw new OutputProductionRefusedError("NOT_APPLICABLE_NOT_ENTITLED");
        throw Object.assign(new Error("RENDERER_CRASHED"), { code: "RENDERER_CRASHED" });
      },
      { connection },
    );
    worker.on("failed", () => {
      failedEvents += 1;
    });
    bindWorkerEvents(worker, "report");
    try {
      await queue.add("refusal", {}, { attempts: 3 });
      await queue.add("technical", {}, { attempts: 3 });
      const deadline = Date.now() + 15_000;
      while (failedEvents < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(failedEvents).toBe(2);
      expect(sentry.captured).toHaveLength(1);
      expect((sentry.captured[0] as { code?: string }).code).toBe("RENDERER_CRASHED");
      expect(alertsFrom(error)).toBe(1);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  }, 30_000);
});

describe("AUD-41 (2026-10-20) — a retryable failure escalates once, on exhaustion", () => {
  const technical = () => Object.assign(new Error("STORAGE_WRITE_FAILED"), { code: "STORAGE_WRITE_FAILED" });

  it("attempts before the last are logged as retries: no Sentry event, no critical alert", () => {
    const error = vi.spyOn(logger, "error");
    const warn = vi.spyOn(logger, "warn");
    const emitter = new EventEmitter();
    bindWorkerEvents(emitter as never, "report");
    for (let attemptsMade = 1; attemptsMade < 5; attemptsMade += 1) emitter.emit("failed", job(attemptsMade), technical());
    expect(sentry.captured).toEqual([]);
    expect(alertsFrom(error)).toBe(0);
    expect(warn.mock.calls.filter((c) => c[1] === "report.job.attempt_failed_will_retry").length).toBe(4);
  });

  it("the last attempt is captured and alerted exactly once", () => {
    const error = vi.spyOn(logger, "error");
    const emitter = new EventEmitter();
    bindWorkerEvents(emitter as never, "report");
    for (let attemptsMade = 1; attemptsMade <= 5; attemptsMade += 1) emitter.emit("failed", job(attemptsMade), technical());
    expect(sentry.captured).toHaveLength(1);
    expect(alertsFrom(error)).toBe(1);
  });

  it("a job the processor discarded (non-retryable) escalates on its first attempt", () => {
    const error = vi.spyOn(logger, "error");
    const emitter = new EventEmitter();
    bindWorkerEvents(emitter as never, "report");
    emitter.emit("failed", { ...job(1), discarded: true }, technical());
    expect(sentry.captured).toHaveLength(1);
    expect(alertsFrom(error)).toBe(1);
  });
});

describe("AUD-50 (2026-10-20) — the attempt budget is observed, never enforced", () => {
  it("a completed attempt that overran its queue's budget is reported", async () => {
    const { QUEUE_NAMES } = await import("@proovra/shared");
    const warn = vi.spyOn(logger, "warn");
    const emitter = Object.assign(new EventEmitter(), { name: QUEUE_NAMES.REPORT });
    bindWorkerEvents(emitter as never, "report");
    emitter.emit("completed", { ...job(1), processedOn: 1, finishedOn: 1 + 24 * 60 * 60 * 1000 });
    expect(warn.mock.calls.filter((c) => c[1] === "report.job.attempt_over_budget")).toHaveLength(1);
  });

  it("an attempt within its budget is not reported", async () => {
    const { QUEUE_NAMES } = await import("@proovra/shared");
    const warn = vi.spyOn(logger, "warn");
    const emitter = Object.assign(new EventEmitter(), { name: QUEUE_NAMES.REPORT });
    bindWorkerEvents(emitter as never, "report");
    emitter.emit("completed", { ...job(1), processedOn: 1, finishedOn: 1001 });
    expect(warn.mock.calls.filter((c) => c[1] === "report.job.attempt_over_budget")).toHaveLength(0);
  });
});
