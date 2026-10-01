/**
 * A GLOBAL bound stays global when the shared store comes and goes.
 *
 * The limiter counts in Redis so that every API replica shares one bucket. It
 * also had a fallback: when Redis could not answer, a replica counted in its
 * own memory for a cooldown. For a limit that is only a cost control that is a
 * reasonable degradation. For a public write — an unauthenticated request that
 * creates a row, sends an email or tests a credential — it is not a bound at
 * all: each replica starts its own count from zero, so an outage multiplies
 * the allowance by the number of replicas, and a store that flaps splits one
 * window across Redis and memory.
 *
 * `bound: "global"` is the caller saying "this limit is only meaningful if it
 * is shared". With Redis configured, such a limit is decided by Redis or it is
 * REFUSED — never counted per process.
 *
 * The harness: three module instances (three replicas) over ONE fake Redis
 * whose availability the test controls. No network, no timers slept through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Backend = {
  down: boolean;
  store: Map<string, { value: number; members: Set<string>; expiresAt: number | null }>;
  commands: number;
};
const backend = (): Backend => (globalThis as unknown as { __FAKE_REDIS__: Backend }).__FAKE_REDIS__;

vi.mock("ioredis", () => {
  const be = () => (globalThis as unknown as { __FAKE_REDIS__: Backend }).__FAKE_REDIS__;
  const live = (key: string) => {
    const row = be().store.get(key);
    if (row && row.expiresAt !== null && row.expiresAt <= Date.now()) {
      be().store.delete(key);
      return undefined;
    }
    return row;
  };
  const ensure = (key: string) => {
    let row = live(key);
    if (!row) {
      row = { value: 0, members: new Set(), expiresAt: null };
      be().store.set(key, row);
    }
    return row;
  };
  const refuse = () => new Error("Stream isn't writeable and enableOfflineQueue options is false");
  class FakeRedis {
    status = "wait";
    private handlers = new Map<string, Array<(e?: unknown) => void>>();
    on(event: string, cb: (e?: unknown) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
      return this;
    }
    private emit(event: string, arg?: unknown) {
      for (const cb of this.handlers.get(event) ?? []) cb(arg);
    }
    private guard() {
      if (be().down) {
        if (this.status === "ready") {
          this.status = "reconnecting";
          this.emit("close");
        }
        throw refuse();
      }
      if (this.status !== "ready") this.status = "ready";
      be().commands += 1;
    }
    async connect() {
      if (be().down) {
        this.emit("error", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
        throw new Error("connect ECONNREFUSED");
      }
      this.status = "ready";
    }
    pipeline() {
      const ops: Array<() => unknown> = [];
      const guard = () => this.guard();
      const p = {
        incr(key: string) {
          ops.push(() => (ensure(key).value += 1));
          return p;
        },
        pttl(key: string) {
          ops.push(() => {
            const row = live(key);
            if (!row) return -2;
            return row.expiresAt === null ? -1 : row.expiresAt - Date.now();
          });
          return p;
        },
        async exec() {
          guard();
          return ops.map((op) => [null, op()]);
        },
      };
      return p;
    }
    async pexpire(key: string, ms: number) {
      this.guard();
      const row = live(key);
      if (row) row.expiresAt = Date.now() + Number(ms);
      return row ? 1 : 0;
    }
    async eval(_script: string, _n: number, key: string, member: string, max: string, windowMs: string) {
      this.guard();
      const row = ensure(key);
      const ttl = () => (row.expiresAt === null ? -1 : row.expiresAt - Date.now());
      if (row.members.has(member)) return [1, row.members.size, ttl()];
      if (row.members.size >= Number(max)) return [0, row.members.size, ttl()];
      row.members.add(member);
      if (row.expiresAt === null) row.expiresAt = Date.now() + Number(windowMs);
      return [1, row.members.size, ttl()];
    }
  }
  return { default: FakeRedis };
});

type Limiter = typeof import("../src/services/rate-limit.js");

/** A fresh module instance: its own memory store, its own Redis client. */
async function replica(): Promise<Limiter> {
  vi.resetModules();
  return (await import("../src/services/rate-limit.js")) as Limiter;
}

const LIMIT = 5;
const WINDOW_SEC = 60;
const COOLDOWN_MS = 15_000;
const KEY = "contact-sales:ip:test-client";

const hit = (l: Limiter, bound: "global" | "process" = "global", key = KEY) =>
  l.enforceRateLimit({ key, max: LIMIT, windowSec: WINDOW_SEC, bound } as Parameters<Limiter["enforceRateLimit"]>[0]);

const saved = { url: process.env.REDIS_URL, cooldown: process.env.RATE_LIMIT_REDIS_COOLDOWN_MS };

beforeEach(() => {
  (globalThis as unknown as { __FAKE_REDIS__: Backend }).__FAKE_REDIS__ = { down: false, store: new Map(), commands: 0 };
  process.env.REDIS_URL = "redis://fake.invalid:6379";
  process.env.RATE_LIMIT_REDIS_COOLDOWN_MS = String(COOLDOWN_MS);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  if (saved.url === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = saved.url;
  if (saved.cooldown === undefined) delete process.env.RATE_LIMIT_REDIS_COOLDOWN_MS;
  else process.env.RATE_LIMIT_REDIS_COOLDOWN_MS = saved.cooldown;
});

describe("a global bound across three replicas", () => {
  it("Redis available: exactly LIMIT are admitted in total, and the first refusal is request LIMIT + 1", async () => {
    const replicas = [await replica(), await replica(), await replica()];
    const outcomes: boolean[] = [];
    for (let i = 0; i < LIMIT + 4; i += 1) {
      outcomes.push((await hit(replicas[i % 3]!)).allowed);
    }
    expect(outcomes.filter(Boolean).length).toBe(LIMIT);
    expect(outcomes.indexOf(false)).toBe(LIMIT);
    expect(outcomes.slice(LIMIT).every((a) => a === false)).toBe(true);
  });

  it("Redis unavailable before the first request: every replica refuses, and nothing is counted per process", async () => {
    backend().down = true;
    const replicas = [await replica(), await replica(), await replica()];
    const results = [];
    for (let i = 0; i < 9; i += 1) results.push(await hit(replicas[i % 3]!));

    expect(results.filter((r) => r.allowed).length).toBe(0);
    expect(results.every((r) => r.store === "unavailable")).toBe(true);
    // A refusal names when to come back, and it is soon — not a full window.
    const now = Date.now();
    expect(results.every((r) => r.resetAtMs > now && r.resetAtMs <= now + COOLDOWN_MS)).toBe(true);

    // The store returns: the window starts from ZERO. Nothing was counted in
    // any replica's memory while it was away.
    backend().down = false;
    vi.setSystemTime(Date.now() + COOLDOWN_MS + 1);
    const after: boolean[] = [];
    for (let i = 0; i < LIMIT + 2; i += 1) after.push((await hit(replicas[i % 3]!)).allowed);
    expect(after.filter(Boolean).length).toBe(LIMIT);
    expect(after.indexOf(false)).toBe(LIMIT);
  });

  it("Redis fails in the middle of a window: no replica opens a second, private allowance", async () => {
    const replicas = [await replica(), await replica(), await replica()];
    let admitted = 0;
    for (let i = 0; i < 3; i += 1) if ((await hit(replicas[i]!)).allowed) admitted += 1;
    expect(admitted).toBe(3);

    backend().down = true;
    const during = [];
    for (let i = 0; i < 12; i += 1) during.push(await hit(replicas[i % 3]!));
    expect(during.filter((r) => r.allowed).length).toBe(0);
    expect(during.every((r) => r.store === "unavailable")).toBe(true);
  });

  it("Redis recovers in the middle of a window: the count resumes where Redis left it, with no double counting", async () => {
    const replicas = [await replica(), await replica(), await replica()];
    for (let i = 0; i < 3; i += 1) await hit(replicas[i]!);

    backend().down = true;
    for (let i = 0; i < 6; i += 1) await hit(replicas[i % 3]!);

    backend().down = false;
    vi.setSystemTime(Date.now() + COOLDOWN_MS + 1);
    const outcomes: boolean[] = [];
    for (let i = 0; i < 6; i += 1) outcomes.push((await hit(replicas[i % 3]!)).allowed);

    // 3 were admitted before the outage; exactly 2 remain in this window.
    expect(outcomes.filter(Boolean).length).toBe(LIMIT - 3);
    expect(outcomes.indexOf(false)).toBe(LIMIT - 3);
    // The refused outage requests were never written anywhere: Redis holds the
    // 3 before and the 6 after, and nothing else.
    expect(backend().store.get(`ratelimit:${KEY}`)?.value).toBe(3 + 6);
  });

  it("a store that flaps cannot split one window between Redis and memory", async () => {
    const replicas = [await replica(), await replica(), await replica()];
    let admitted = 0;
    for (let round = 0; round < 6; round += 1) {
      backend().down = round % 2 === 1;
      for (let i = 0; i < 4; i += 1) if ((await hit(replicas[i % 3]!)).allowed) admitted += 1;
      vi.setSystemTime(Date.now() + 2_000);
    }
    expect(admitted).toBeLessThanOrEqual(LIMIT);
  });

  it("a replica whose connection is healthy is not held back by another's cooldown", async () => {
    const a = await replica();
    backend().down = true;
    expect((await hit(a)).store).toBe("unavailable");
    backend().down = false;
    // Inside A's cooldown a replica that never saw the failure still decides.
    const b = await replica();
    const r = await hit(b);
    expect(r.allowed).toBe(true);
    expect(r.store).toBe("redis");
  });

  it("the distinct-client limit follows the same rule", async () => {
    const replicas = [await replica(), await replica(), await replica()];
    const call = (l: Limiter, member: string) =>
      l.enforceDistinctClientLimit({ key: "verify:clients:rec", member, max: 2, windowSec: 60, bound: "global" } as Parameters<
        Limiter["enforceDistinctClientLimit"]
      >[0]);
    expect((await call(replicas[0]!, "c1")).allowed).toBe(true);
    backend().down = true;
    const during = [await call(replicas[1]!, "c2"), await call(replicas[2]!, "c3"), await call(replicas[0]!, "c4")];
    expect(during.filter((r) => r.allowed).length).toBe(0);
    backend().down = false;
    vi.setSystemTime(Date.now() + COOLDOWN_MS + 1);
    expect((await call(replicas[1]!, "c2")).allowed).toBe(true);
    expect((await call(replicas[2]!, "c3")).allowed).toBe(false);
  });
});

describe("what did NOT change", () => {
  it("a process-scoped limit still degrades to the replica's own memory during an outage, and says so", async () => {
    backend().down = true;
    const l = await replica();
    const results = [];
    for (let i = 0; i < LIMIT + 2; i += 1) results.push(await hit(l, "process", "ratelimit:evidence:create:PRO:user-1"));
    expect(results.filter((r) => r.allowed).length).toBe(LIMIT);
    expect(results.every((r) => r.store === "memory")).toBe(true);
  });

  it("with no Redis configured the one process IS the deployment: memory is the bound, exact at the boundary", async () => {
    delete process.env.REDIS_URL;
    const l = await replica();
    const outcomes: boolean[] = [];
    for (let i = 0; i < LIMIT + 2; i += 1) outcomes.push((await hit(l)).allowed);
    expect(outcomes.indexOf(false)).toBe(LIMIT);
    expect(backend().commands).toBe(0);
  });

  it("the window still ends: after it, the bound admits again", async () => {
    const l = await replica();
    for (let i = 0; i < LIMIT + 1; i += 1) await hit(l);
    expect((await hit(l)).allowed).toBe(false);
    vi.setSystemTime(Date.now() + WINDOW_SEC * 1000 + 1);
    expect((await hit(l)).allowed).toBe(true);
  });
});

describe("every public write declares its bound global", () => {
  it("the unauthenticated write surfaces, and the credential-guessing ones, pass bound: \"global\"", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
    const GLOBAL_KEYS: Array<[string, string]> = [
      ["routes/contact-sales.routes.ts", "contact-sales:ip:"],
      ["routes/demo-requests.routes.ts", "demo-requests:ip:"],
      ["routes/citizen-capture.routes.ts", "citizen-intake:ip:"],
      ["routes/citizen-capture.routes.ts", "citizen-intake:token:"],
      ["routes/external-intake.routes.ts", "external-intake:ip:"],
      ["routes/external-intake.routes.ts", "external-intake:token:"],
      ["routes/auth.routes.ts", "mfa-verify:"],
      ["routes/auth.routes.ts", "auth:email-register:ip:"],
      ["routes/auth.routes.ts", "auth:email-availability:ip:"],
      ["routes/auth.routes.ts", "auth:email-login:ip:"],
      ["routes/auth.routes.ts", "auth:password-reset:ip:"],
      ["routes/auth.routes.ts", "auth:email-verify:ip:"],
      ["routes/auth.routes.ts", "auth:email-resend:ip:"],
      ["routes/teams.routes.ts", "workspace-invite-lookup:"],
      ["routes/identity-security.routes.ts", "identity-security:password-change:user:"],
      ["routes/identity-security.routes.ts", "identity-security:password-change:ip:"],
      ["routes/identity-security-contact-factors.routes.ts", "contact-factor-enroll:"],
      ["services/external-review/portal-mfa-challenge.service.ts", "portal:mfa-code:grant:"],
    ];
    const missing: string[] = [];
    for (const [file, key] of GLOBAL_KEYS) {
      const src = read(file);
      const at = src.indexOf("`" + key);
      if (at < 0) {
        missing.push(`${file}: key ${key} not found`);
        continue;
      }
      // The call's argument object: from the key to the closing `})`.
      const call = src.slice(at, src.indexOf("})", at));
      if (!/bound:\s*"global"/.test(call)) missing.push(`${file}: ${key}`);
    }
    expect(missing).toEqual([]);
  });
});

describe("UC-SEC-006 — the anonymous verify surface and the capture/presign limiters are global", () => {
  it("each declares bound: \"global\"", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
    const GLOBAL_KEYS: Array<[string, string]> = [
      ["routes/evidence.routes.ts", "ratelimit:verify:ip:"],
      ["routes/evidence.routes.ts", "ratelimit:verify:evidence-clients:"],
      ["routes/evidence.routes.ts", "ratelimit:evidence-part-presign:user:"],
      ["routes/capture-trust.routes.ts", "ratelimit:capture:direct-session:open:"],
    ];
    const missing: string[] = [];
    for (const [file, key] of GLOBAL_KEYS) {
      const src = read(file);
      const at = src.indexOf("`" + key);
      if (at < 0) {
        missing.push(`${file}: key ${key} not found`);
        continue;
      }
      // The verify IP key is built into a variable first; follow it to its call.
      const callStart = key === "ratelimit:verify:ip:" ? src.indexOf("enforceRateLimit({", at) : at;
      const call = src.slice(callStart, src.indexOf("})", callStart));
      if (!/bound:\s*"global"/.test(call)) missing.push(`${file}: ${key}`);
    }
    expect(missing).toEqual([]);
  });
});
