/**
 * WS-REL / PRO-S1-02 — detached audit appends are counted when they fail and
 * drained by graceful shutdown before the pool closes.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { installGracefulShutdown } from "../src/graceful-shutdown.js";
import {
  __resetDetachedAuditTrackerForTests,
  detachedAuditStats,
  drainPendingAuditAppends,
  trackAuditAppend,
} from "../src/services/audit/detached-audit-tracker.js";
import { readCounter } from "../src/services/ops/metrics.service.js";

beforeEach(() => {
  __resetDetachedAuditTrackerForTests();
});

describe("PRO-S1-02 detached audit tracker", () => {
  it("a swallowed append failure is still counted", async () => {
    const before = readCounter("platform_audit_append_failed_total");
    // The call-site pattern: void emitX(...).catch(() => null)
    void trackAuditAppend(Promise.reject(new Error("pool timeout"))).catch(() => null);
    await new Promise((r) => setTimeout(r, 0));
    expect(readCounter("platform_audit_append_failed_total")).toBe(before + 1);
    expect(detachedAuditStats().failed).toBe(1);
  });

  it("drain waits for a pending append, within its deadline", async () => {
    let done = false;
    void trackAuditAppend(
      new Promise<void>((r) =>
        setTimeout(() => {
          done = true;
          r();
        }, 50),
      ),
    );
    const result = await drainPendingAuditAppends(1_000);
    expect(done).toBe(true);
    expect(result).toEqual({ drained: true, stillPending: 0 });
  });

  it("drain gives up at the deadline and reports what was cut", async () => {
    void trackAuditAppend(new Promise<void>(() => undefined));
    const result = await drainPendingAuditAppends(20);
    expect(result).toEqual({ drained: false, stillPending: 1 });
  });

  it("graceful shutdown drains background work after close and before the pool ends", async () => {
    const order: string[] = [];
    let exitCode: number | null = null;
    const { shutdown } = installGracefulShutdown(
      {
        close: async () => {
          order.push("close");
        },
        log: { info: () => undefined, warn: () => undefined },
      },
      {
        drainBackground: async () => {
          order.push("drain");
        },
        closePool: async () => {
          order.push("pool");
        },
        exit: (code) => {
          exitCode = code;
        },
        on: () => undefined,
      },
    );
    await shutdown("SIGTERM");
    expect(order).toEqual(["close", "drain", "pool"]);
    expect(exitCode).toBe(0);
  });
});
