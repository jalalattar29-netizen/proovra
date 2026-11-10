/**
 * AUD-0017 — evidence create and complete under concurrency ABOVE the database
 * pool size. With the pool at 4, the audit saw every concurrent create fail with
 * P2028 after ~5 s and every concurrent completion hang ~120 s and fail: the
 * transactions held their connection while nested helpers read on the GLOBAL
 * client and waited for another one. Those reads now run on the transaction's
 * own client (or before the transaction opens), so demand above the pool queues
 * and succeeds.
 *
 * Real routes, PostgreSQL and the object store; the pool is set before the
 * client module is imported.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const POOL = 4;

describe("AUD-0017 evidence create/complete above the pool size (live PostgreSQL, pool 4)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const poolBefore = process.env.DATABASE_POOL_MAX;

  beforeAll(async () => {
    process.env.DATABASE_POOL_MAX = String(POOL);
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    for (const t of [h.fixtures.teamA, h.fixtures.teamB]) {
      await prisma.team.update({ where: { id: t.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    }
  }, 300_000);

  afterAll(async () => {
    if (poolBefore === undefined) delete process.env.DATABASE_POOL_MAX;
    else process.env.DATABASE_POOL_MAX = poolBefore;
    await h?.cleanup();
  }, 300_000);

  // Each test uses its own team owner: evidence creation is rate limited per user.
  let who: "teamA" | "teamB" = "teamA";
  const A = () => h.fixtures[who];
  const auth = () => ({ authorization: `Bearer ${A().ownerToken}` });

  async function create(label: string) {
    const bytes = Buffer.from(`aud-0017 ${label} ${randomUUID()}`);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/evidence",
      headers: auth(),
      payload: {
        type: "DOCUMENT",
        mimeType: "text/plain",
        originalFileName: `${label}.txt`,
        checksumSha256Base64: createHash("sha256").update(bytes).digest("base64"),
        teamId: A().teamId,
      },
    });
    return { res, bytes };
  }

  async function upload(id: string, label: string, bytes: Buffer) {
    const part = await h.app.inject({
      method: "POST",
      url: `/v1/evidence/${id}/parts`,
      headers: auth(),
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
    const results = await Promise.all(Array.from({ length: n }, (_, i) => create(`c-${i}`)));
    const elapsed = Date.now() - t0;
    const statuses = results.map((r) => r.res.statusCode);
    expect(statuses, results.map((r) => r.res.body.slice(0, 160)).join("\n")).toEqual(Array(n).fill(201));
    const ids = results.map((r) => (r.res.json() as { id: string }).id);
    expect(new Set(ids).size).toBe(n);
    expect(await prisma.evidence.count({ where: { id: { in: ids } } })).toBe(n);
    expect(elapsed).toBeLessThan(30_000);
  }, 120_000);

  it(`${POOL * 2} concurrent completions at pool ${POOL} all seal, each with exactly one completion custody event`, async () => {
    who = "teamB";
    const n = POOL * 2;
    const prepared: Array<{ id: string }> = [];
    for (let i = 0; i < n; i += 1) {
      const { res, bytes } = await create(`k-${i}`);
      expect(res.statusCode, res.body).toBe(201);
      const id = (res.json() as { id: string }).id;
      await upload(id, `k-${i}`, bytes);
      prepared.push({ id });
    }
    const t0 = Date.now();
    const done = await Promise.all(
      prepared.map((p) => h.app.inject({ method: "POST", url: `/v1/evidence/${p.id}/complete`, headers: auth(), payload: {} })),
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
    const again = await Promise.all(prepared.slice(0, POOL).map((p) => h.app.inject({ method: "POST", url: `/v1/evidence/${p.id}/complete`, headers: auth(), payload: {} })));
    // 200 (already finalized) or 429 (completion rate limit): either way nothing is re-done.
    expect(again.every((r) => r.statusCode === 200 || r.statusCode === 429), again.map((r) => r.statusCode).join(",")).toBe(true);
    for (const p of prepared.slice(0, POOL)) {
      expect(await prisma.custodyEvent.count({ where: { evidenceId: p.id, eventType: "EVIDENCE_COMPLETED" as never } })).toBe(1);
    }
  }, 300_000);
});
