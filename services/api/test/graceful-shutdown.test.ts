/**
 * F-21 — the API drains on SIGTERM: Fastify's close() (stop accepting, finish
 * in-flight requests), then the pool it owns, then exit 0; a drain that cannot
 * finish exits 1 before Docker's 10 s SIGKILL.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { installGracefulShutdown, SHUTDOWN_DEADLINE_MS } from "../src/graceful-shutdown.js";

function harness(close: () => Promise<unknown>) {
  const order: string[] = [];
  const handlers = new Map<string, () => void>();
  const exit = vi.fn((code: number) => order.push(`exit:${code}`));
  const app = {
    close: async () => {
      order.push("close:start");
      await close();
      order.push("close:end");
    },
    log: { info: vi.fn(), warn: vi.fn() },
  };
  const closePool = vi.fn(async () => order.push("pool"));
  const ctl = installGracefulShutdown(app, {
    closePool,
    exit,
    on: (signal, handler) => handlers.set(signal, handler),
    deadlineMs: 50,
  });
  return { order, handlers, exit, closePool, ctl, app };
}

describe("installGracefulShutdown", () => {
  afterEach(() => vi.useRealTimers());

  it("the deadline stays below Docker's default 10 s stop timeout", () => {
    expect(SHUTDOWN_DEADLINE_MS).toBeLessThan(10_000);
  });

  it("SIGTERM closes the server (waiting for in-flight work), then the pool, then exits 0", async () => {
    let finishInFlight!: () => void;
    const inFlight = new Promise<void>((r) => (finishInFlight = r));
    const h = harness(() => inFlight);
    expect([...h.handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);

    h.handlers.get("SIGTERM")!();
    await Promise.resolve();
    expect(h.order).toEqual(["close:start"]);
    expect(h.closePool).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();

    finishInFlight();
    await h.ctl.shutdown("SIGTERM");
    expect(h.order).toEqual(["close:start", "close:end", "pool", "exit:0"]);
  });

  it("a second signal does not start a second drain", async () => {
    const h = harness(async () => undefined);
    const a = h.ctl.shutdown("SIGTERM");
    const b = h.ctl.shutdown("SIGINT");
    expect(a).toBe(b);
    await a;
    expect(h.order.filter((s) => s === "close:start")).toHaveLength(1);
    expect(h.exit).toHaveBeenCalledTimes(1);
  });

  it("a drain that never finishes exits 1 at the deadline", async () => {
    vi.useFakeTimers();
    const h = harness(() => new Promise(() => undefined));
    void h.ctl.shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(60);
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.closePool).not.toHaveBeenCalled();
  });

  it("a failing close exits 1", async () => {
    const h = harness(async () => {
      throw new Error("boom");
    });
    await h.ctl.shutdown("SIGTERM");
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("exit waits for the telemetry flush after the pool closes", async () => {
    const order: string[] = [];
    const handlers = new Map<string, () => void>();
    let finishFlush!: () => void;
    installGracefulShutdown(
      { close: async () => { order.push("close"); }, log: { info: vi.fn(), warn: vi.fn() } },
      {
        closePool: async () => { order.push("pool"); },
        flushTelemetry: () => new Promise<void>((resolve) => { order.push("flush:start"); finishFlush = () => { order.push("flush:end"); resolve(); }; }),
        exit: (code) => { order.push(`exit:${code}`); },
        on: (signal, handler) => handlers.set(signal, handler),
        deadlineMs: 5_000,
      },
    );
    handlers.get("SIGTERM")!();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["close", "pool", "flush:start"]);
    finishFlush();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["close", "pool", "flush:start", "flush:end", "exit:0"]);
  });
});
