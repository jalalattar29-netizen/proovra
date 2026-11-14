/**
 * F-21 (Free-user audit) — GET /v1/cases pages with a keyset cursor instead of
 * stopping at the newest 200. Live PostgreSQL 16, real HTTP.
 *
 * On 2c84cad83 both branches (the bare list and `?eligibleForEvidenceId=`)
 * returned `take: 200` with nothing to say more existed, so an older
 * accessible case could not be chosen in the evidence filter or the attach
 * selector. A client that sends no cursor still gets the first 200.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("GET /v1/cases keyset pagination (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const made: string[] = [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const P = h.fixtures.personal;
    // Two share one createdAt so the id tiebreak is exercised.
    const same = new Date(Date.now() - 60_000);
    for (let i = 0; i < 5; i += 1) {
      const row = await prisma.case.create({
        data: { name: `Cursor case ${i}`, teamId: P.teamId, ownerUserId: P.userId, ...(i < 2 ? { createdAt: same } : {}) },
        select: { id: true },
      });
      made.push(row.id);
    }
  }, 180_000);

  afterAll(async () => {
    if (made.length) await prisma?.case.deleteMany({ where: { id: { in: made } } }).catch(() => undefined);
    await h?.cleanup();
  });

  const get = (url: string, token = h.fixtures.personal.token) =>
    h.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  async function walk(base: string, limit: number): Promise<{ ids: string[]; pages: number }> {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const sep = base.includes("?") ? "&" : "?";
      const res = await get(`${base}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { items: Array<{ id: string }>; nextCursor: string | null; hasMore: boolean };
      expect(body.items.length).toBeLessThanOrEqual(limit);
      expect(body.hasMore).toBe(body.nextCursor !== null);
      ids.push(...body.items.map((c) => c.id));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 50);
    return { ids, pages };
  }

  it("the bare list: every accessible case exactly once across pages, same set as one large page", async () => {
    const all = (await get("/v1/cases")).json() as { items: Array<{ id: string }>; hasMore: boolean; nextCursor: string | null };
    expect(all.hasMore).toBe(false);
    expect(all.nextCursor).toBeNull();
    const paged = await walk("/v1/cases", 2);
    expect(paged.pages).toBeGreaterThan(1);
    expect(new Set(paged.ids).size).toBe(paged.ids.length);
    expect(paged.ids).toEqual(all.items.map((c) => c.id));
    expect(paged.ids).toEqual(expect.arrayContaining(made));
  });

  it("the attach selector pages the same way", async () => {
    const P = h.fixtures.personal;
    const base = `/v1/cases?eligibleForEvidenceId=${P.evidenceId}`;
    const one = (await get(base)).json() as { items: Array<{ id: string }> };
    const paged = await walk(base, 2);
    expect(paged.ids).toEqual(one.items.map((c) => c.id));
    expect(paged.ids).toEqual(expect.arrayContaining(made));
  });

  it("a malformed cursor or limit is refused 400, never silently restarted", async () => {
    expect((await get("/v1/cases?cursor=not-a-cursor")).statusCode).toBe(400);
    expect((await get("/v1/cases?limit=0")).statusCode).toBe(400);
    expect((await get("/v1/cases?limit=201")).statusCode).toBe(400);
  });

  it("another account's cases never appear on any page", async () => {
    const paged = await walk("/v1/cases", 2);
    expect(paged.ids).not.toContain(h.fixtures.teamA.caseId);
    expect(paged.ids).not.toContain(h.fixtures.teamB.caseId);
  });
});
