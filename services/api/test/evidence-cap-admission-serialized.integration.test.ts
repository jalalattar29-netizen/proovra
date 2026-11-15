/**
 * ET-ACQ-06 — record-cap admission is serialized per capacity subject.
 * Live PostgreSQL 16, real HTTP.
 *
 * On a40ca76f the record count was read with no lock before the insert, so
 * concurrent creates at cap-1 were all admitted; a SHARED workspace was never
 * settled again at completion, so its overshoot stood.
 *
 * F-03 (Free-user audit 4d9b, capacity; 2026-11-15) — the wait for that lock
 * is bounded and a hot workspace cannot take the whole pool: creates beyond
 * EVIDENCE_CAPACITY_ADMISSION_CONCURRENCY per principal queue in memory (no
 * connection held), and a wait past EVIDENCE_CAPACITY_LOCK_WAIT_MS is answered
 * 429 RATE_LIMITED + Retry-After with nothing written.
 */
import { randomUUID } from "node:crypto";

import { Client as PgClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * q) - 1))] ?? 0;
};

describe("record-cap admission is serialized (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let poolStats: (typeof import("../src/db.js"))["databasePoolStats"];
  let clearRates: () => Promise<unknown>;
  let capacityKey: (ownerUserId: string, teamId: string) => Promise<string>;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma, databasePoolStats: poolStats } = await import("../src/db.js"));
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    const billing = await import("../src/services/billing-enforcement.service.js");
    const { commercialPrincipalOf } = await import("../src/services/workspace-billing.service.js");
    capacityKey = async (ownerUserId, teamId) =>
      `evidence-capacity:${commercialPrincipalOf(await billing.resolveEnforcementScopeForRequester({ ownerUserId, teamId }))}`;
  }, 180_000);

  beforeEach(async () => {
    await clearRates();
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  /** `draft`: the web Finish door — a capture draft id, so the route opens the transaction itself. */
  const create = (token: string, teamId?: string, draft = false) =>
    h.app.inject({
      method: "POST",
      url: "/v1/evidence",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: "PHOTO",
        mimeType: "image/jpeg",
        ...(teamId ? { teamId } : {}),
        ...(draft ? { captureSessionId: randomUUID() } : {}),
      },
    });

  async function race(token: string, teamId?: string): Promise<number[]> {
    const res = await Promise.all(Array.from({ length: 5 }, () => create(token, teamId)));
    return res.map((r) => r.statusCode).sort();
  }

  /** Another session holds the workspace's capacity lock (a long seal tail, a slow create). */
  async function holdCapacityLock(
    key: string,
  ): Promise<{ release: () => Promise<void>; waitersOnLock: () => Promise<number> }> {
    const holder = new PgClient({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
    return {
      // Sessions (= pooled API connections) parked inside BEGIN waiting for an
      // advisory lock — what one hot workspace used to take from everyone.
      waitersOnLock: async () =>
        Number(
          (await holder.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rows[0]
            .n,
        ),
      release: async () => {
        await holder.query("COMMIT").catch(() => undefined);
        await holder.end().catch(() => undefined);
      },
    };
  }

  /** Samples the API pool while `work` runs: peak connections out, peak waiters. */
  async function sampled<T>(work: Promise<T>): Promise<{ value: T; peakBusy: number; peakWaiting: number }> {
    let peakBusy = 0;
    let peakWaiting = 0;
    let done = false;
    const sampler = (async () => {
      while (!done) {
        const s = poolStats();
        peakBusy = Math.max(peakBusy, s.totalCount - s.idleCount);
        peakWaiting = Math.max(peakWaiting, s.waitingCount);
        await sleep(10);
      }
    })();
    try {
      const value = await work;
      return { value, peakBusy, peakWaiting };
    } finally {
      done = true;
      await sampler;
    }
  }

  async function runSaturation(door: "own transaction" | "draft binding") {
    const A = h.fixtures.teamA;
    const B = h.fixtures.teamB;
    for (const t of [A, B]) {
      await prisma.team.update({ where: { id: t.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    }
    const beforeA = await prisma.evidence.count({ where: { teamId: A.teamId } });
    const beforeB = await prisma.evidence.count({ where: { teamId: B.teamId } });
    const lock = await holdCapacityLock(await capacityKey(A.ownerUserId, A.teamId));
    const N = 20;
    const t0 = Date.now();
    let hot: Promise<Array<{ status: number; body: string; retryAfter: unknown; ms: number }>>;
    let other: { status: number; body: string; ms: number };
    let saturation: { peakBusy: number; peakWaiting: number };
    let peakLockWaiters = 0;
    try {
      hot = Promise.all(
        Array.from({ length: N }, () =>
          create(A.ownerToken, A.teamId, door === "draft binding").then((r) => ({
            status: r.statusCode,
            body: r.body,
            retryAfter: r.headers["retry-after"],
            ms: Date.now() - t0,
          })),
        ),
      );
      // Saturation established: the hot workspace's creates have reached its
      // lock (and the rest its admission queue) before the probe is sent.
      for (let i = 0; i < 250 && peakLockWaiters === 0; i++) {
        peakLockWaiters = Math.max(peakLockWaiters, await lock.waitersOnLock());
        if (peakLockWaiters === 0) await sleep(20);
      }
      await sleep(300);
      let sampling = true;
      const lockSampler = (async () => {
        while (sampling) {
          peakLockWaiters = Math.max(peakLockWaiters, await lock.waitersOnLock());
          await sleep(20);
        }
      })();
      const probe = await sampled(
        (async () => {
          const tb = Date.now();
          const r = await create(B.ownerToken, B.teamId);
          return { status: r.statusCode, body: r.body, ms: Date.now() - tb };
        })(),
      );
      other = probe.value;
      saturation = { peakBusy: probe.peakBusy, peakWaiting: probe.peakWaiting };
      sampling = false;
      await lockSampler;
    } finally {
      await lock.release();
    }
    const results = await hot;

    // The unrelated workspace was answered promptly while A was saturated.
    expect(other.status, other.body).toBe(201);
    expect(other.ms).toBeLessThan(2_000);
    expect(await prisma.evidence.count({ where: { teamId: B.teamId } })).toBe(beforeB + 1);
    // A parked at most its admission share of connections on the lock (the
    // default EVIDENCE_CAPACITY_ADMISSION_CONCURRENCY = 2), not the pool.
    expect(peakLockWaiters).toBeGreaterThan(0);
    expect(peakLockWaiters).toBeLessThanOrEqual(2);

    // The queued creates were admitted once the holder committed, or refused
    // with the busy shape — never a 5xx, and rows only for the admitted ones.
    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 201 || s === 429), JSON.stringify(statuses)).toBe(true);
    for (const r of results.filter((x) => x.status === 429)) {
      expect(r.retryAfter).toBe("2");
      expect(JSON.parse(r.body).error.code).toBe("RATE_LIMITED");
    }
    const admitted = statuses.filter((s) => s === 201).length;
    expect(admitted).toBeGreaterThan(0);
    expect(await prisma.evidence.count({ where: { teamId: A.teamId } })).toBe(beforeA + admitted);
    const hotMs = results.map((r) => r.ms);
    console.log(
      `[F-03 measurement, LOCAL, ${door}] hot workspace: ${N} concurrent creates behind a held capacity lock (released after the probe); ` +
        `statuses ${JSON.stringify(statuses.reduce<Record<number, number>>((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {}))}; ` +
        `hot p50 ${pct(hotMs, 0.5)} ms, p95 ${pct(hotMs, 0.95)} ms; ` +
        `unrelated workspace create ${other.ms} ms (status ${other.status}); ` +
        `connections parked on A's capacity lock: ${peakLockWaiters}; ` +
        `API pool during probe: peak busy ${saturation.peakBusy}/${poolStats().max}, peak pool waiters ${saturation.peakWaiting}`,
    );
  }

  it("F-03: one saturated workspace leaves an unrelated workspace responsive, then admits its queue when the holder commits (create on its own transaction)", () =>
    runSaturation("own transaction"));

  it("F-03: the same through the web Finish door (captureSessionId: the route opens the transaction)", () =>
    runSaturation("draft binding"));

  it("F-03: a create that cannot get its workspace's lock within the budget is refused 429 + Retry-After, writes nothing, and releases its connection", async () => {
    const A = h.fixtures.teamA;
    await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    const before = await prisma.evidence.count({ where: { teamId: A.teamId } });
    const previous = process.env.EVIDENCE_CAPACITY_LOCK_WAIT_MS;
    process.env.EVIDENCE_CAPACITY_LOCK_WAIT_MS = "400";
    const lock = await holdCapacityLock(await capacityKey(A.ownerUserId, A.teamId));
    try {
      const t0 = Date.now();
      const res = await Promise.all(Array.from({ length: 4 }, () => create(A.ownerToken, A.teamId)));
      const elapsed = Date.now() - t0;
      for (const r of res) {
        expect(r.statusCode, r.body).toBe(429);
        expect(r.headers["retry-after"]).toBe("2");
        expect(JSON.parse(r.body).error.code).toBe("RATE_LIMITED");
      }
      // Bounded: the budget (400 ms) plus request overhead, not Prisma's 5 s.
      expect(elapsed).toBeLessThan(3_000);
      expect(await prisma.evidence.count({ where: { teamId: A.teamId } })).toBe(before);
      // No connection is left checked out by the refused requests.
      await sleep(50);
      const s = poolStats();
      expect(s.totalCount - s.idleCount).toBe(0);
      expect(s.waitingCount).toBe(0);
      console.log(`[F-03 measurement, LOCAL] 4 creates behind a held lock, budget 400 ms: all 429 in ${elapsed} ms; pool busy after = ${s.totalCount - s.idleCount}`);
    } finally {
      await lock.release();
      if (previous === undefined) delete process.env.EVIDENCE_CAPACITY_LOCK_WAIT_MS;
      else process.env.EVIDENCE_CAPACITY_LOCK_WAIT_MS = previous;
    }
    // The workspace works again at once.
    const after = await create(A.ownerToken, A.teamId);
    expect(after.statusCode, after.body).toBe(201);
  });

  it("a SHARED TEAM workspace one record below its rolling allowance admits exactly one of five concurrent creates", async () => {
    const B = h.fixtures.teamB;
    await prisma.team.update({ where: { id: B.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    const team = await prisma.team.findUniqueOrThrow({ where: { id: B.teamId }, select: { organizationId: true } });
    const since = new Date(Date.now() - 30 * 24 * 3600_000);
    const existing = await prisma.evidence.count({ where: { teamId: B.teamId, deletedAt: null, createdAt: { gte: since } } });
    const toSeed = 499 - existing;
    expect(toSeed).toBeGreaterThan(0);
    await prisma.evidence.createMany({
      data: Array.from({ length: toSeed }, (_, i) => ({
        title: `cap-${i}`,
        type: "PHOTO",
        status: "SIGNED",
        teamId: B.teamId,
        organizationId: team.organizationId,
        ownerUserId: B.ownerUserId,
      })) as never,
    });

    const statuses = await race(B.ownerToken, B.teamId);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s !== 201).every((s) => s === 409 || s === 402)).toBe(true);
  });

  it("a FREE Personal Space one record below its lifetime cap admits exactly one of five concurrent creates", async () => {
    const P = h.fixtures.personal;
    const personalTeam = await prisma.team.findUniqueOrThrow({ where: { id: P.teamId }, select: { organizationId: true } });
    const existing = await prisma.evidence.count({ where: { ownerUserId: P.userId, deletedAt: null } });
    const toSeed = 2 - existing;
    if (toSeed > 0) {
      await prisma.evidence.createMany({
        data: Array.from({ length: toSeed }, (_, i) => ({
          title: `cap-p-${i}`,
          type: "PHOTO",
          status: "SIGNED",
          teamId: P.teamId,
          organizationId: personalTeam.organizationId,
          ownerUserId: P.userId,
        })) as never,
      });
    }

    const statuses = await race(P.token);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
  });
});
