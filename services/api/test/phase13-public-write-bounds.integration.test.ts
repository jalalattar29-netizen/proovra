/**
 * PHASE 13 §1.4 — FINAL-004 and PHASE1-002/003/005 RUNTIME PROOF.
 *
 * WHY THIS SUITE SPAWNS REAL PROCESSES INSTEAD OF USING `app.inject`
 * ---------------------------------------------------------------------------
 * The mandate requires the per-IP bound to hold ACROSS REPLICAS. That claim
 * cannot honestly be tested with two Fastify instances built inside one Node
 * process: `services/rate-limit.ts` keeps its bucket map and its Redis client
 * at MODULE scope, so two in-process instances share them and a purely
 * in-memory limiter would look perfectly "shared". The test would pass for the
 * wrong reason, and would keep passing if Redis were removed entirely.
 *
 * So this suite starts the API the way a deployment does — as separate OS
 * processes, listening on real ports, reached over real HTTP — and points them
 * at ONE Redis and ONE PostgreSQL. Three replicas run:
 *
 *   A, B : API_TRUST_PROXY unset (this service's documented safe default)
 *   P    : API_TRUST_PROXY=true, standing in for a deployment that has
 *          declared a trusted proxy in front of it
 *
 * A and B together are the cross-replica proof. P is the other half of the
 * client-IP contract: the header must be consulted when, and only when, the
 * deployment says a proxy rewrites it.
 *
 * WHAT EACH ROW CLAIMED
 * ---------------------------------------------------------------------------
 * FINAL-004  the citizen-intake routes promised "rate-limited by IP" in their
 *            own header and never implemented it.
 * PHASE1-002 the limiter FINAL-004 added keyed on a raw `x-forwarded-for`, so
 *            rotating one header produced a fresh bucket per request and the
 *            new bound did nothing on the surface it was added to protect.
 * PHASE1-003 the same bypass on `external-intake.routes.ts`, the surface
 *            PHASE1-002's limiter was copied from.
 * PHASE1-005 `POST /v1/contact-sales` and `POST /v1/demo-requests` — two
 *            unauthenticated public writes ending in a `prisma.create` with no
 *            request bound at all. The "IP-hammer" control both files cited is
 *            a SPAM SCORE: it sets `isSpam`, which changes how the row is
 *            filed, while the row is written regardless.
 *
 * THE ASSERTION THAT MATTERS MOST
 * ---------------------------------------------------------------------------
 * A 429 is not the point. The point is that a refused request writes NO ROW.
 * PHASE1-005's whole finding was a control that ran and changed nothing about
 * persistence, so every bound below is checked against the row count in the
 * database, not only against the status code.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { acquireIntegrationDatabase } from "./integration-harness.js";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The per-IP bound both PHASE1-005 surfaces declare, per minute. */
const PUBLIC_LEAD_LIMIT_PER_MIN = 5;

type Replica = { name: string; port: number; proc: ChildProcess; base: string };

/** A payload that passes `createContactSalesSchema` in full. */
const leadPayload = (marker: string) => ({
  fullName: "Phase Thirteen Prospect",
  workEmail: `phase13+${marker}@example.invalid`,
  organization: "Phase 13 Fixture Org",
  discussionTopic: "evidence-integrity",
  stage: "evaluating",
  currentChallenge:
    "This row exists only to let the Phase 13 bound be counted in the database.",
});

const demoPayload = (marker: string) => ({
  fullName: "Phase Thirteen Prospect",
  workEmail: `phase13demo+${marker}@example.invalid`,
  organization: "Phase 13 Fixture Org",
});

describe("FINAL-004 / PHASE1-002 / PHASE1-003 / PHASE1-005 — public writes are bounded, and the bound survives a rotating header and a second replica", () => {
  let database: Awaited<ReturnType<typeof acquireIntegrationDatabase>>;
  let redisUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let redis: import("ioredis").default;

  const replicas: Replica[] = [];
  const A = () => replicas[0] as Replica;
  const B = () => replicas[1] as Replica;
  const P = () => replicas[2] as Replica;

  /** Start one API process and wait until it answers /healthz. */
  const startReplica = async (
    name: string,
    port: number,
    extraEnv: Record<string, string>,
  ): Promise<Replica> => {
    const proc = spawn(
      "node",
      ["--import", "tsx", "src/index.ts"],
      {
        cwd: API_ROOT,
        env: {
          ...process.env,
          DATABASE_URL: database.url,
          REDIS_URL: redisUrl,
          PORT: String(port),
          NODE_ENV: "test",
          // Never a real provider from a spawned replica.
          EMAIL_TRANSPORT: "recording",
          AUTH_JWT_SECRET:
            process.env.AUTH_JWT_SECRET ??
            "integration-only-secret-0123456789abcdef",
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (Date.now() > deadline) {
        proc.kill();
        throw new Error(`replica ${name} did not become healthy on ${base}`);
      }
      try {
        const res = await fetch(`${base}/healthz`);
        if (res.ok) break;
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { name, port, proc, base };
  };

  beforeAll(async () => {
    database = await acquireIntegrationDatabase();
    redisUrl = process.env.REDIS_URL?.trim() ?? "";
    if (!redisUrl) {
      throw new Error(
        "This suite proves a CROSS-REPLICA bound, which requires a shared " +
          "Redis. REDIS_URL is unset, and running without it would prove the " +
          "opposite of what the suite claims.",
      );
    }

    // The client is built the way the application builds it — through
    // `src/db.ts`, which owns the pg adapter and the pool. Constructing a
    // second client here by hand would be a parallel database authority, and
    // it would not exercise the same connection semantics the replicas use.
    process.env.DATABASE_URL = database.url;
    prisma = (await import("../src/db.js")).prisma as unknown as
      import("@prisma/client").PrismaClient;
    const { default: IORedis } = await import("ioredis");
    redis = new IORedis(redisUrl, { maxRetriesPerRequest: 2 });

    replicas.push(
      await startReplica("A", 18181, { API_TRUST_PROXY_MODE: "off" }),
      await startReplica("B", 18182, { API_TRUST_PROXY_MODE: "off" }),
      // PHASE 13 §1 (NEW-022) — the explicit production policy: exactly one
      // trusted reverse-proxy hop (Caddy). `API_TRUST_PROXY=true` no longer
      // exists as a mode.
      await startReplica("P", 18183, {
        API_TRUST_PROXY_MODE: "hop",
        API_TRUSTED_PROXY_HOPS: "1",
      }),
    );
  }, 900_000);

  afterAll(async () => {
    for (const r of replicas) r.proc.kill("SIGTERM");
    await prisma?.contactSalesRequest
      .deleteMany({ where: { organization: "Phase 13 Fixture Org" } })
      .catch(() => undefined);
    await prisma?.demoRequest
      .deleteMany({ where: { organization: "Phase 13 Fixture Org" } })
      .catch(() => undefined);
    // PHASE 13 §4 — TEARDOWN ORDER.
    //
    // `$disconnect()` is not enough with a driver adapter: Prisma wraps a pool
    // that `src/db.ts` owns, and ending the client leaves that pool's idle
    // connections open. Stopping the container next made PostgreSQL terminate
    // them (`57P01`), `pg` raised asynchronously after the last assertion, and
    // the whole integration run exited 1 with every test passing.
    //
    // The pool is closed here, before the container, and its counters are
    // asserted so a still-borrowed connection names itself instead of
    // reappearing later as a mystery FATAL.
    const { closeDatabasePool } = await import("../src/db.js");
    const poolState = await closeDatabasePool();
    redis?.disconnect();
    if (poolState.totalCount !== 0 || poolState.waitingCount !== 0) {
      throw new Error(
        `teardown: database pool not released before container stop ` +
          `(total=${poolState.totalCount}, idle=${poolState.idleCount}, waiting=${poolState.waitingCount})`,
      );
    }
    await database?.release();
  }, 300_000);

  /**
   * Every case starts from an empty bucket AND an empty row set, so a count is
   * attributable to the case that produced it. Clearing Redis directly is the
   * honest reset here: it is the store the replicas actually share.
   */
  beforeEach(async () => {
    let cursor = "0";
    do {
      const [next, keys] = (await redis.scan(
        cursor,
        "MATCH",
        "ratelimit:*",
        "COUNT",
        500,
      )) as [string, string[]];
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== "0");

    await prisma.contactSalesRequest.deleteMany({
      where: { organization: "Phase 13 Fixture Org" },
    });
    await prisma.demoRequest.deleteMany({
      where: { organization: "Phase 13 Fixture Org" },
    });
  });

  const post = (
    replica: Replica,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${replica.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  const leadRows = () =>
    prisma.contactSalesRequest.count({
      where: { organization: "Phase 13 Fixture Org" },
    });

  // =========================================================================
  // POSITIVE CONTROL — the surfaces work.
  //
  // Without this, every 429 below could be a route that refuses everything,
  // and every "no rows" assertion could be a route that never writes at all.
  // =========================================================================
  it("POSITIVE CONTROL: a first request is accepted and persists exactly one row", async () => {
    const res = await post(A(), "/v1/contact-sales", leadPayload("control"));
    expect(res.status, await res.text().catch(() => "")).toBe(201);
    expect(await leadRows()).toBe(1);
  });

  // =========================================================================
  // PHASE1-005 — the bound exists at all, and refusal precedes the write.
  // =========================================================================
  it("refuses beyond the per-IP limit, and a refused request writes NO row", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < PUBLIC_LEAD_LIMIT_PER_MIN + 4; i++) {
      const res = await post(A(), "/v1/contact-sales", leadPayload(`burst-${i}`));
      statuses.push(res.status);
    }

    const accepted = statuses.filter((s) => s === 201).length;
    const refused = statuses.filter((s) => s === 429).length;

    expect(refused, `expected some refusals, got statuses ${statuses.join(",")}`)
      .toBeGreaterThan(0);
    expect(accepted).toBeLessThanOrEqual(PUBLIC_LEAD_LIMIT_PER_MIN);

    // THE ASSERTION PHASE1-005 IS ABOUT: rows equal ACCEPTED requests, not
    // total requests. A spam FLAG would have left all nine rows here.
    expect(await leadRows()).toBe(accepted);
  });

  it("bounds POST /v1/demo-requests the same way", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < PUBLIC_LEAD_LIMIT_PER_MIN + 4; i++) {
      const res = await post(A(), "/v1/demo-requests", demoPayload(`burst-${i}`));
      statuses.push(res.status);
    }
    const accepted = statuses.filter((s) => s >= 200 && s < 300).length;
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(accepted).toBeLessThanOrEqual(PUBLIC_LEAD_LIMIT_PER_MIN);
    expect(
      await prisma.demoRequest.count({
        where: { organization: "Phase 13 Fixture Org" },
      }),
    ).toBe(accepted);
  });

  // =========================================================================
  // PHASE1-002 / PHASE1-003 — the header bypass, on an UNTRUSTED deployment.
  // =========================================================================
  describe("API_TRUST_PROXY unset — a header the caller controls cannot select the bucket", () => {
    for (const header of [
      "x-forwarded-for",
      "x-real-ip",
      "forwarded",
      "cf-connecting-ip",
    ] as const) {
      it(`rotating ${header} on every request does NOT create a fresh bucket`, async () => {
        const statuses: number[] = [];
        for (let i = 0; i < PUBLIC_LEAD_LIMIT_PER_MIN + 4; i++) {
          // A different, plausible, PUBLIC address on every single request —
          // the exact shape that defeated the pre-fix limiter.
          const value =
            header === "forwarded" ? `for=203.0.113.${i + 1}` : `203.0.113.${i + 1}`;
          const res = await post(
            A(),
            "/v1/contact-sales",
            leadPayload(`rot-${header}-${i}`),
            { [header]: value },
          );
          statuses.push(res.status);
        }

        const accepted = statuses.filter((s) => s === 201).length;
        expect(
          statuses.filter((s) => s === 429).length,
          `rotating ${header} produced no refusals (${statuses.join(",")}) — the bound is bypassable`,
        ).toBeGreaterThan(0);
        expect(accepted).toBeLessThanOrEqual(PUBLIC_LEAD_LIMIT_PER_MIN);
        // And the rotation created no extra rows either.
        expect(await leadRows()).toBe(accepted);
      });
    }

    it("a multi-hop forged X-Forwarded-For chain is ignored entirely", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < PUBLIC_LEAD_LIMIT_PER_MIN + 4; i++) {
        const res = await post(
          A(),
          "/v1/contact-sales",
          leadPayload(`chain-${i}`),
          {
            "x-forwarded-for": `10.0.0.${i + 1}, 203.0.113.${i + 1}, 198.51.100.${i + 1}`,
          },
        );
        statuses.push(res.status);
      }
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
      expect(await leadRows()).toBe(statuses.filter((s) => s === 201).length);
    });
  });

  // =========================================================================
  // The other half of the contract — a DECLARED proxy IS consulted.
  //
  // This is not a weaker assertion; it is what makes the one above meaningful.
  // If the header were ignored unconditionally, the limiter would be correct by
  // accident and every real deployment behind a load balancer would share one
  // bucket for the whole internet.
  // =========================================================================
  describe("API_TRUST_PROXY_MODE=hop (hops=1) — the proxy-appended (rightmost) hop IS the client identity", () => {
    it("distinct clients (rightmost hop) get distinct buckets", async () => {
      // Under a single trusted hop the client is the address the proxy appended
      // — the RIGHTMOST X-Forwarded-For entry. Four distinct clients, each well
      // under the limit; if the header were ignored they would share one bucket
      // and the later requests would be refused.
      const statuses: number[] = [];
      for (let addr = 1; addr <= 4; addr++) {
        for (let i = 0; i < 3; i++) {
          const res = await post(
            P(),
            "/v1/contact-sales",
            leadPayload(`trusted-${addr}-${i}`),
            { "x-forwarded-for": `203.0.113.${addr}` },
          );
          statuses.push(res.status);
        }
      }
      expect(
        statuses.every((s) => s === 201),
        `a declared proxy must let each forwarded client have its own bucket, got ${statuses.join(",")}`,
      ).toBe(true);
      expect(await leadRows()).toBe(12);
    });

    it("one forwarded client is still bounded behind the proxy", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < PUBLIC_LEAD_LIMIT_PER_MIN + 4; i++) {
        const res = await post(
          P(),
          "/v1/contact-sales",
          leadPayload(`trusted-one-${i}`),
          { "x-forwarded-for": "203.0.113.200" },
        );
        statuses.push(res.status);
      }
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
      expect(await leadRows()).toBe(statuses.filter((s) => s === 201).length);
    });

    it("a spoof PREPENDED to the left cannot manufacture a fresh identity", async () => {
      // The attacker rotates the LEFT of the chain on every request while the
      // proxy-appended rightmost hop is constant. Under hop=1 only the rightmost
      // hop is the client, so every request lands in the SAME bucket and the
      // bound holds — this is exactly the NEW-022 defect's inverse.
      const statuses: number[] = [];
      for (let i = 0; i < PUBLIC_LEAD_LIMIT_PER_MIN + 4; i++) {
        const res = await post(
          P(),
          "/v1/contact-sales",
          leadPayload(`spoof-${i}`),
          { "x-forwarded-for": `203.0.113.${i + 1}, 198.51.100.50` },
        );
        statuses.push(res.status);
      }
      expect(
        statuses.filter((s) => s === 429).length,
        `a left-prepended spoof must not create fresh buckets, got ${statuses.join(",")}`,
      ).toBeGreaterThan(0);
    });

    it("the client is the rightmost hop whether presented bare or with a prepended spoof", async () => {
      // One authority, one answer. A bare `198.51.100.60` and a chain ending in
      // `198.51.100.60` must land in the SAME bucket — otherwise a caller could
      // escape its bound just by prepending noise.
      for (let i = 0; i < PUBLIC_LEAD_LIMIT_PER_MIN; i++) {
        await post(P(), "/v1/contact-sales", leadPayload(`hop-a-${i}`), {
          "x-forwarded-for": "198.51.100.60",
        });
      }
      const res = await post(P(), "/v1/contact-sales", leadPayload("hop-b"), {
        "x-forwarded-for": "10.1.2.3, 203.0.113.77, 198.51.100.60",
      });
      expect(
        res.status,
        "the rightmost hop must be the identity in both shapes",
      ).toBe(429);
    });
  });

  // =========================================================================
  // CROSS-REPLICA — the release-blocking gate.
  // =========================================================================
  describe("the bound is shared across replicas", () => {
    it("alternating requests between two replicas cannot exceed the limit in total", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < (PUBLIC_LEAD_LIMIT_PER_MIN + 4) * 2; i++) {
        const replica = i % 2 === 0 ? A() : B();
        const res = await post(
          replica,
          "/v1/contact-sales",
          leadPayload(`xrep-${i}`),
        );
        statuses.push(res.status);
      }

      const accepted = statuses.filter((s) => s === 201).length;
      expect(
        accepted,
        `two replicas accepted ${accepted} requests against a limit of ${PUBLIC_LEAD_LIMIT_PER_MIN} — the limiter is process-local`,
      ).toBeLessThanOrEqual(PUBLIC_LEAD_LIMIT_PER_MIN);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
      expect(await leadRows()).toBe(accepted);
    });

    it("PARALLEL requests across both replicas cannot exceed the limit", async () => {
      // Concurrency, not sequence. A read-then-write limiter passes the
      // alternating test above and fails this one, because every racer reads
      // the same count before any of them writes. Redis INCR is atomic, so the
      // count is allocated exactly once per request.
      const inFlight = Array.from({ length: 24 }, (_, i) =>
        post(
          i % 2 === 0 ? A() : B(),
          "/v1/contact-sales",
          leadPayload(`par-${i}`),
        ),
      );
      const statuses = (await Promise.all(inFlight)).map((r) => r.status);

      const accepted = statuses.filter((s) => s === 201).length;
      expect(
        accepted,
        `${accepted} concurrent requests were accepted against a limit of ${PUBLIC_LEAD_LIMIT_PER_MIN}`,
      ).toBeLessThanOrEqual(PUBLIC_LEAD_LIMIT_PER_MIN);
      expect(await leadRows()).toBe(accepted);
    });

    it("the shared bucket lives in Redis, and it carries an explicit TTL", async () => {
      await post(A(), "/v1/contact-sales", leadPayload("ttl"));
      const keys = (await redis.keys("ratelimit:contact-sales:ip:*")) as string[];
      expect(
        keys.length,
        "the bound must be recorded in the shared store, not only in a replica's memory",
      ).toBeGreaterThan(0);
      const ttl = await redis.pttl(keys[0] as string);
      // A key with no expiry (-1) would make one burst a permanent block; an
      // absent key (-2) would mean nothing was written.
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
    });
  });

  // =========================================================================
  // PHASE 13 §1.4 — the PUBLIC AUTH writes.
  //
  // `/v1/auth/*` is not one of the four surfaces the original rows named, but
  // it shares their rate-limit authority and it is where a header-rotatable
  // bound matters most: these limits are brute-force and flooding protection,
  // not spam scoring. Driving them found the sixth copy of the client-IP
  // decision (`readClientIp` keyed on `req.ip`), which is fixed and proven here.
  // =========================================================================
  describe("the public auth writes are bounded on the trusted address", () => {
    for (const surface of [
      { path: "/v1/auth/password-reset/request", body: { email: "phase13@example.invalid" } },
      { path: "/v1/auth/email/resend-verification", body: { email: "phase13@example.invalid" } },
    ] as const) {
      it(`${surface.path} refuses a LEFT-spoofed burst on a TRUSTING replica`, async () => {
        // Replica P trusts one hop. The client is the rightmost hop; a caller
        // who rotates the LEFT of the chain (the classic bypass shape) cannot
        // move its bucket. Rightmost held constant, left rotated per request.
        const statuses: number[] = [];
        for (let i = 0; i < 14; i++) {
          const res = await post(P(), surface.path, surface.body, {
            "x-forwarded-for": `10.0.0.${i + 1}, 198.51.100.90`,
          });
          statuses.push(res.status);
        }
        expect(
          statuses.filter((s) => s === 429).length,
          `${surface.path} accepted ${statuses.length} left-spoofed requests (${statuses.join(",")}) — the bound is header-rotatable`,
        ).toBeGreaterThan(0);
      });

      it(`${surface.path} refuses a rotated-header burst on an UNTRUSTING replica`, async () => {
        // Replica A trusts no proxy, so forwarded headers are ignored entirely
        // and every request keys on the socket peer. Rotating the header must
        // not create fresh buckets.
        const statuses: number[] = [];
        for (let i = 0; i < 14; i++) {
          const res = await post(A(), surface.path, surface.body, {
            "x-forwarded-for": `203.0.113.${i + 1}`,
          });
          statuses.push(res.status);
        }
        expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
      });
    }
  });

  // =========================================================================
  // PHASE 13 §1 (NEW-022) — client-IP resolution edge cases.
  //
  // These drive the resolver through the shapes the mandate enumerates, against
  // the real trusting (P) and untrusting (A) processes.
  // =========================================================================
  describe("client-IP resolution edge cases", () => {
    it("UNTRUSTED peer: a Cloudflare-like header from a non-trusted peer is ignored", async () => {
      // Replica A trusts no proxy. CF-Connecting-IP was the header the old
      // resolver honoured FIRST; it must now be inert without a trusted peer.
      const statuses: number[] = [];
      for (let i = 0; i < PUBLIC_LEAD_LIMIT_PER_MIN + 4; i++) {
        const res = await post(A(), "/v1/contact-sales", leadPayload(`cf-${i}`), {
          "cf-connecting-ip": `203.0.113.${i + 1}`,
          "x-forwarded-for": `198.51.100.${i + 1}`,
        });
        statuses.push(res.status);
      }
      expect(
        statuses.filter((s) => s === 429).length,
        `a CF-like header from an untrusted peer must not create buckets, got ${statuses.join(",")}`,
      ).toBeGreaterThan(0);
    });

    it("TRUSTED proxy: an IPv6 client hop is accepted and bucketed", async () => {
      // Distinct IPv6 clients (rightmost hop) get distinct buckets; each stays
      // under the limit. Proves v6 is parsed and normalised, not dropped.
      const statuses: number[] = [];
      for (let addr = 1; addr <= 4; addr++) {
        for (let i = 0; i < 3; i++) {
          const res = await post(P(), "/v1/contact-sales", leadPayload(`v6-${addr}-${i}`), {
            "x-forwarded-for": `2001:db8::${addr}`,
          });
          statuses.push(res.status);
        }
      }
      expect(
        statuses.every((s) => s === 201),
        `distinct IPv6 clients must each get a bucket, got ${statuses.join(",")}`,
      ).toBe(true);
    });

    it("TRUSTED proxy: an IPv4-mapped IPv6 client is bounded and not double-counted", async () => {
      // `::ffff:203.0.113.210` and `203.0.113.210` are the same host; the
      // normalisation must fold them into ONE bucket, so a burst across both
      // forms is still refused rather than getting two full allowances.
      const statuses: number[] = [];
      for (let i = 0; i < PUBLIC_LEAD_LIMIT_PER_MIN + 4; i++) {
        const form = i % 2 === 0 ? "203.0.113.210" : "::ffff:203.0.113.210";
        const res = await post(P(), "/v1/contact-sales", leadPayload(`mapped-${i}`), {
          "x-forwarded-for": form,
        });
        statuses.push(res.status);
      }
      expect(
        statuses.filter((s) => s === 429).length,
        `mapped and bare forms of one host must share a bucket, got ${statuses.join(",")}`,
      ).toBeGreaterThan(0);
    });

    it("TRUSTED proxy: a malformed forwarded token does not crash or bypass the bound", async () => {
      // Garbage in the header must never 5xx and must never mint a fresh bucket.
      const statuses: number[] = [];
      for (let i = 0; i < PUBLIC_LEAD_LIMIT_PER_MIN + 4; i++) {
        const res = await post(P(), "/v1/contact-sales", leadPayload(`malformed-${i}`), {
          "x-forwarded-for": `not-an-ip-${i}, 198.51.100.111`,
        });
        statuses.push(res.status);
      }
      expect(
        statuses.every((s) => s < 500),
        `a malformed chain must never 5xx, got ${statuses.join(",")}`,
      ).toBe(true);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    });

    it("TRUSTED proxy: an oversized forwarded chain is handled without crashing", async () => {
      const longChain =
        Array.from({ length: 60 }, (_, i) => `203.0.113.${(i % 250) + 1}`).join(", ") +
        ", 198.51.100.222";
      const statuses: number[] = [];
      for (let i = 0; i < PUBLIC_LEAD_LIMIT_PER_MIN + 4; i++) {
        const res = await post(P(), "/v1/contact-sales", leadPayload(`oversized-${i}`), {
          "x-forwarded-for": longChain,
        });
        statuses.push(res.status);
      }
      expect(
        statuses.every((s) => s < 500),
        `an oversized chain must never 5xx, got ${statuses.join(",")}`,
      ).toBe(true);
      // Rightmost is constant (198.51.100.222) → one bucket → bounded.
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // FINAL-004 — the citizen-intake surface the bound was originally missing on.
  // =========================================================================
  it("FINAL-004: the citizen-intake open-session route is bounded per IP and rotating the header does not lift the bound", async () => {
    const statuses: number[] = [];
    // 30/min per IP on this surface, so drive past it.
    for (let i = 0; i < 36; i++) {
      const res = await post(
        A(),
        "/v1/intake/citizen/sessions",
        {
          intakeTokenId: `phase13-nonexistent-${i}`,
          publicKeyHex: "a".repeat(64),
        },
        { "x-forwarded-for": `203.0.113.${(i % 250) + 1}` },
      );
      statuses.push(res.status);
    }
    expect(
      statuses.filter((s) => s === 429).length,
      `citizen intake accepted ${statuses.length} rotated-header requests with no refusal — the FINAL-004 bound is absent or bypassable`,
    ).toBeGreaterThan(0);
  });
});
