/**
 * OPS closure (2026-11-21) — a refusing or crash-looping worker leaves a trace.
 *
 * In production the worker restarted 306 times over ~25 h, each time exiting at
 * the schema-head gate (HEAD_NOT_APPLIED) before it wrote a lease or a
 * heartbeat, so nothing the API reads changed. The boot record and the refusal
 * reason are now written to the shared Redis before the gate can exit; the
 * API's outage watchdog reads them (services/api/src/services/operations/
 * outage-watchdog.service.ts).
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { OPS_WORKER_BOOT_EVENTS_KEY, OPS_WORKER_SCHEMA_REFUSAL_KEY } from "@proovra/shared";

import {
  BOOT_EVENTS_RETAIN_MS,
  clearSchemaRefusal,
  recordSchemaRefusal,
  recordWorkerBoot,
  type BootSignalRedis,
} from "../src/boot-signal.js";
import { EXPECTED_MIGRATION_HEAD, enforceSchemaHeadBeforeConsumers } from "../src/schema-head.js";

class FakeRedis implements BootSignalRedis {
  zset: Array<{ score: number; member: string }> = [];
  kv = new Map<string, { value: string; ex: number }>();
  expires = new Map<string, number>();
  async zadd(key: string, score: number, member: string) {
    expect(key).toBe(OPS_WORKER_BOOT_EVENTS_KEY);
    this.zset.push({ score, member });
    return 1;
  }
  async zremrangebyscore(_key: string, min: number | string, max: number | string) {
    const lo = min === "-inf" ? -Infinity : Number(min);
    const hi = Number(max);
    this.zset = this.zset.filter((e) => !(e.score >= lo && e.score <= hi));
    return 0;
  }
  async expire(key: string, seconds: number) {
    this.expires.set(key, seconds);
    return 1;
  }
  async set(key: string, value: string, _mode: "EX", seconds: number) {
    this.kv.set(key, { value, ex: seconds });
    return "OK";
  }
  async del(key: string) {
    return this.kv.delete(key) ? 1 : 0;
  }
}

const NOW = Date.parse("2026-11-21T12:00:00Z");

describe("boot records", () => {
  it("each start adds one member; records older than 24 h are trimmed; the key expires", async () => {
    const r = new FakeRedis();
    r.zset.push({ score: NOW - BOOT_EVENTS_RETAIN_MS - 1, member: `old|1|${NOW - BOOT_EVENTS_RETAIN_MS - 1}` });
    expect(await recordWorkerBoot(r, { workerId: "abc123-1", pid: 1, nowMs: NOW - 5 * 60_000 })).toBe(true);
    expect(await recordWorkerBoot(r, { workerId: "abc123-1", pid: 1, nowMs: NOW })).toBe(true);
    expect(r.zset.map((e) => e.member)).toEqual([`abc123-1|1|${NOW - 300_000}`, `abc123-1|1|${NOW}`]);
    expect(r.expires.get(OPS_WORKER_BOOT_EVENTS_KEY)).toBeGreaterThan(24 * 3600);
  });

  it("an unreachable or hanging Redis never stops the boot (false, bounded)", async () => {
    const throwing = new FakeRedis();
    throwing.zadd = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await recordWorkerBoot(throwing, { workerId: "w", pid: 1 })).toBe(false);
    const hanging = new FakeRedis();
    hanging.set = () => new Promise(() => undefined);
    const started = Date.now();
    expect(await recordSchemaRefusal(hanging, { kind: "HEAD_NOT_APPLIED", expected: "x", workerId: "w" })).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);
});

describe("the schema-head gate records why it refused, and clears it once current", () => {
  it("a refusal is recorded (kind + expected head) BEFORE the process exits", async () => {
    const r = new FakeRedis();
    const order: string[] = [];
    const ok = await enforceSchemaHeadBeforeConsumers({
      readRows: async () => [],
      log: () => {},
      exit: () => void order.push("exit"),
      sleep: async () => {},
      attempts: 2,
      onRefused: async (problem) => {
        await recordSchemaRefusal(r, { kind: problem.kind, expected: problem.expected, workerId: "abc123-1", nowMs: NOW });
        order.push("recorded");
      },
    });
    expect(ok).toBe(false);
    expect(order).toEqual(["recorded", "exit"]);
    const stored = r.kv.get(OPS_WORKER_SCHEMA_REFUSAL_KEY)!;
    expect(JSON.parse(stored.value)).toEqual({
      kind: "HEAD_NOT_APPLIED",
      expected: EXPECTED_MIGRATION_HEAD,
      workerId: "abc123-1",
      atMs: NOW,
    });
    expect(stored.ex).toBeGreaterThan(0);
  });

  it("a current head clears an earlier refusal and starts; a throwing hook changes neither outcome", async () => {
    const r = new FakeRedis();
    await recordSchemaRefusal(r, { kind: "HEAD_NOT_APPLIED", expected: EXPECTED_MIGRATION_HEAD, workerId: "w" });
    const ok = await enforceSchemaHeadBeforeConsumers({
      readRows: async () => [{ migration_name: EXPECTED_MIGRATION_HEAD, finished_at: new Date(), rolled_back_at: null }],
      log: () => {},
      exit: () => {
        throw new Error("must not exit");
      },
      onCurrent: () => clearSchemaRefusal(r),
    });
    expect(ok).toBe(true);
    expect(r.kv.has(OPS_WORKER_SCHEMA_REFUSAL_KEY)).toBe(false);

    const exits: number[] = [];
    expect(
      await enforceSchemaHeadBeforeConsumers({
        readRows: async () => [],
        log: () => {},
        exit: (c) => void exits.push(c),
        sleep: async () => {},
        attempts: 1,
        onRefused: () => {
          throw new Error("redis gone");
        },
      }),
    ).toBe(false);
    expect(exits).toEqual([1]);
  });

  it("the worker records its boot before the gate, and wires both hooks", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const boot = src.indexOf("await recordWorkerBoot(redisConnection");
    const gate = src.indexOf("await enforceSchemaHeadBeforeConsumers(");
    expect(boot).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(boot);
    const gateCall = src.slice(gate, src.indexOf("});", gate));
    expect(gateCall).toContain("onRefused: (problem) =>");
    expect(gateCall).toContain("recordSchemaRefusal(redisConnection");
    expect(gateCall).toContain("onCurrent: () => clearSchemaRefusal(redisConnection)");
  });
});
