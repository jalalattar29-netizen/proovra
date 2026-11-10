/**
 * AUD-0017 — evidence create and complete under concurrency ABOVE the database
 * pool size. With the pool at 4, the audit saw every concurrent create fail with
 * P2028 after ~5 s and every concurrent completion hang ~120 s and fail: the
 * transactions held their connection while nested helpers read on the GLOBAL
 * client and waited for another one. Those reads now run on the transaction's
 * own client (or before the transaction opens), so demand above the pool queues
 * and succeeds.
 *
 * The audit asked for the reproduction at pool 4 and pool 10. The pool size is
 * `AUD0017_POOL` (default 4). Each burst is spread over enough members of the
 * workspace that no one person exceeds 8 requests, because evidence creation is
 * rate limited per user (10 a minute on a personal FREE plan): at pool 10 the
 * rate limit, not the pool, would otherwise answer.
 *
 * Real routes, PostgreSQL and the object store; the pool is set before the
 * client module is imported.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps } from "./point7/product-fixtures.js";

const POOL = Number(process.env.AUD0017_POOL ?? 4);
const PER_ACTOR = 8;

type Actor = { userId: string; token: string };

describe(`AUD-0017 evidence create/complete above the pool size (live PostgreSQL, pool ${POOL})`, () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const poolBefore = process.env.DATABASE_POOL_MAX;
  const actors: Record<"teamA" | "teamB", Actor[]> = { teamA: [], teamB: [] };

  beforeAll(async () => {
    process.env.DATABASE_POOL_MAX = String(POOL);
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const fx = await import("./point7/product-fixtures.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const deps: FixtureDeps = {
      prisma: prisma as never,
      tag: `pool-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt({ sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never, process.env.AUTH_JWT_SECRET!, 3600),
    };
    const largestBurst = POOL * 2 + 2;
    for (const key of ["teamA", "teamB"] as const) {
      const t = h.fixtures[key];
      await prisma.team.update({ where: { id: t.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE", includedSeats: 100 } });
      actors[key].push({ userId: t.ownerUserId, token: t.ownerToken });
      while (actors[key].length * PER_ACTOR < largestBurst) {
        const u = await fx.seedUser(deps, `${key}-${actors[key].length}`);
        await prisma.teamMember.create({ data: { teamId: t.teamId, userId: u.userId, role: "ADMIN", status: "ACTIVE" } });
        actors[key].push({ userId: u.userId, token: u.token });
      }
    }
  }, 300_000);

  afterAll(async () => {
    if (poolBefore === undefined) delete process.env.DATABASE_POOL_MAX;
    else process.env.DATABASE_POOL_MAX = poolBefore;
    await h?.cleanup();
  }, 300_000);

  const auth = (a: Actor) => ({ authorization: `Bearer ${a.token}` });
  const actorFor = (key: "teamA" | "teamB", i: number) => actors[key][i % actors[key].length]!;

  async function create(key: "teamA" | "teamB", a: Actor, label: string) {
    const bytes = Buffer.from(`aud-0017 ${label} ${randomUUID()}`);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/evidence",
      headers: auth(a),
      payload: {
        type: "DOCUMENT",
        mimeType: "text/plain",
        originalFileName: `${label}.txt`,
        checksumSha256Base64: createHash("sha256").update(bytes).digest("base64"),
        teamId: h.fixtures[key].teamId,
      },
    });
    return { res, bytes };
  }

  async function upload(a: Actor, id: string, label: string, bytes: Buffer) {
    const part = await h.app.inject({
      method: "POST",
      url: `/v1/evidence/${id}/parts`,
      headers: auth(a),
      payload: { partIndex: 0, mimeType: "text/plain", sizeBytes: bytes.length, originalFileName: `${label}.txt` },
    });
    expect(part.statusCode, part.body).toBeLessThan(300);
    const up = (part.json() as { upload: { putUrl: string; headers?: Record<string, string> } }).upload;
    const put = await fetch(up.putUrl, { method: "PUT", body: bytes, headers: { "content-type": "text/plain", ...(up.headers ?? {}) } });
    expect(put.status).toBe(200);
  }

  it(`${POOL * 2 + 2} concurrent creates at pool ${POOL} all succeed promptly, one row each`, async () => {
    const n = POOL * 2 + 2;
    const t0 = Date.now();
    const results = await Promise.all(Array.from({ length: n }, (_, i) => create("teamA", actorFor("teamA", i), `c-${i}`)));
    const elapsed = Date.now() - t0;
    const statuses = results.map((r) => r.res.statusCode);
    expect(statuses, results.map((r) => r.res.body.slice(0, 160)).join("\n")).toEqual(Array(n).fill(201));
    const ids = results.map((r) => (r.res.json() as { id: string }).id);
    expect(new Set(ids).size).toBe(n);
    expect(await prisma.evidence.count({ where: { id: { in: ids } } })).toBe(n);
    expect(elapsed).toBeLessThan(30_000);
  }, 120_000);

  it(`${POOL * 2} concurrent completions at pool ${POOL} all seal, each with exactly one completion custody event`, async () => {
    const n = POOL * 2;
    const prepared: Array<{ id: string; a: Actor }> = [];
    for (let i = 0; i < n; i += 1) {
      const a = actorFor("teamB", i);
      const { res, bytes } = await create("teamB", a, `k-${i}`);
      expect(res.statusCode, res.body).toBe(201);
      const id = (res.json() as { id: string }).id;
      await upload(a, id, `k-${i}`, bytes);
      prepared.push({ id, a });
    }
    const t0 = Date.now();
    const done = await Promise.all(
      prepared.map((p) => h.app.inject({ method: "POST", url: `/v1/evidence/${p.id}/complete`, headers: auth(p.a), payload: {} })),
    );
    const elapsed = Date.now() - t0;
    expect(done.map((r) => r.statusCode), done.map((r) => r.body.slice(0, 160)).join("\n")).toEqual(Array(n).fill(200));
    expect(elapsed).toBeLessThan(60_000);
    const rows = await prisma.evidence.findMany({ where: { id: { in: prepared.map((p) => p.id) } }, select: { id: true, status: true, fileSha256: true } });
    expect(rows.every((r) => (r.status === "SIGNED" || r.status === "REPORTED") && !!r.fileSha256)).toBe(true);
    for (const p of prepared) {
      const completed = await prisma.custodyEvent.count({ where: { evidenceId: p.id, eventType: "EVIDENCE_COMPLETED" as never } });
      expect(completed).toBe(1);
    }
    // a duplicate concurrent completion of the same record changes nothing
    const again = await Promise.all(prepared.slice(0, POOL).map((p) => h.app.inject({ method: "POST", url: `/v1/evidence/${p.id}/complete`, headers: auth(p.a), payload: {} })));
    // 200 (already finalized) or 429 (completion rate limit): either way nothing is re-done.
    expect(again.every((r) => r.statusCode === 200 || r.statusCode === 429), again.map((r) => r.statusCode).join(",")).toBe(true);
    for (const p of prepared.slice(0, POOL)) {
      expect(await prisma.custodyEvent.count({ where: { evidenceId: p.id, eventType: "EVIDENCE_COMPLETED" as never } })).toBe(1);
    }
  }, 300_000);

  // TXP-004 — a create bound to a web capture draft runs `createEvidence` inside
  // the route's transaction; every pre-write read (owner, membership, scope,
  // allowance) used the global client while that transaction held a connection.
  it(`${POOL * 2} concurrent draft-bound creates at pool ${POOL} all succeed, each bound to its draft (TXP-004)`, async () => {
    const A = h.fixtures.teamA;
    const n = POOL * 2;
    // Workspace A's members already created records above within this minute;
    // the drafts belong to fresh members so the per-user limit is not what answers.
    const fx = await import("./point7/product-fixtures.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const deps: FixtureDeps = {
      prisma: prisma as never,
      tag: `pool-d-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt({ sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never, process.env.AUTH_JWT_SECRET!, 3600),
    };
    const drafters: Actor[] = [];
    while (drafters.length * PER_ACTOR < n) {
      const u = await fx.seedUser(deps, `draft-${drafters.length}`);
      await prisma.teamMember.create({ data: { teamId: A.teamId, userId: u.userId, role: "ADMIN", status: "ACTIVE" } });
      drafters.push({ userId: u.userId, token: u.token });
    }
    const drafts: Array<{ id: string; a: Actor }> = [];
    for (let i = 0; i < n; i += 1) {
      const a = drafters[i % drafters.length]!;
      const d = await prisma.captureSession.create({
        data: { ownerUserId: a.userId, teamId: A.teamId, status: "DRAFT" },
        select: { id: true },
      });
      drafts.push({ id: d.id, a });
    }
    const t0 = Date.now();
    const results = await Promise.all(
      drafts.map((d) =>
        h.app.inject({
          method: "POST",
          url: "/v1/evidence",
          headers: auth(d.a),
          payload: { type: "PHOTO", mimeType: "image/jpeg", teamId: A.teamId, captureSessionId: d.id },
        }),
      ),
    );
    const elapsed = Date.now() - t0;
    const statuses = results.map((r) => r.statusCode);
    expect(statuses.filter((s) => s >= 500), results.map((r) => r.body.slice(0, 160)).join("\n")).toEqual([]);
    expect(statuses.every((s) => s === 200 || s === 201), statuses.join(",")).toBe(true);
    const bound = await prisma.captureSession.findMany({
      where: { id: { in: drafts.map((d) => d.id) } },
      select: { finalizedEvidenceId: true },
    });
    expect(bound.every((b) => !!b.finalizedEvidenceId)).toBe(true);
    expect(new Set(bound.map((b) => b.finalizedEvidenceId)).size).toBe(n);
    expect(elapsed).toBeLessThan(30_000);
  }, 120_000);
});
