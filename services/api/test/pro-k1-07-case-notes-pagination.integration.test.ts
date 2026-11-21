/**
 * PRO-K1-07 — older case notes are reachable page by page, and every page is
 * filtered by the canonical note read rule (EVID-011), not only the first.
 *
 * Real routes, real PostgreSQL: GET /v1/cases/:id/matter-workspace (first page
 * + cursor) and GET /v1/cases/:id/comments?cursor= (older pages).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = import("@prisma/client").PrismaClient;
type Note = { id: string; createdAt: string; visibility: string; authorUserId: string; body: string };
type Page = { comments: Note[]; nextCursor: string | null; hasMore: boolean };

describe("PRO-K1-07 — case notes cursor pagination (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;

  let caseId: string;
  let restrictedCaseId: string;
  const allIds: string[] = [];
  const memberVisible = new Set<string>();
  const hiddenFromMember = new Set<string>();

  const A = () => h.fixtures.teamA;
  const B = () => h.fixtures.teamB;
  const get = (url: string, token: string) =>
    h.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  async function allPages(token: string, limit: number): Promise<{ pages: Note[][]; cursors: (string | null)[] }> {
    const pages: Note[][] = [];
    const cursors: (string | null)[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const res = await get(
        `/v1/cases/${caseId}/comments?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        token,
      );
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as Page;
      pages.push(body.comments);
      cursors.push(body.nextCursor);
      expect(body.hasMore).toBe(body.nextCursor !== null);
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
    }
    return { pages, cursors };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;

    const teamId = A().teamId;
    caseId = (
      await prisma.case.create({
        data: { name: `k107-${randomUUID().slice(0, 6)}`, teamId, ownerUserId: A().ownerUserId },
        select: { id: true },
      })
    ).id;

    // 47 notes, one second apart, newest last; every third an INTERNAL note by
    // the owner (closed to a plain member); two notes share a timestamp so the
    // id tie-breaker sits on a page boundary; one INTERNAL note is the
    // member's own (an author always reads their own note).
    const base = Date.now() - 3_600_000;
    for (let i = 0; i < 47; i++) {
      const internal = i % 3 === 0;
      const own = i === 10;
      const createdAt = new Date(base + (i === 21 ? 20 : i) * 1000);
      const row = await prisma.caseComment.create({
        data: {
          teamId,
          caseId,
          authorUserId: own ? A().memberUserId : A().ownerUserId,
          body: `k107 note ${i}`,
          visibility: internal || own ? "INTERNAL" : "ALL_MEMBERS",
          createdAt,
        },
        select: { id: true },
      });
      allIds.push(row.id);
      if (internal && !own) hiddenFromMember.add(row.id);
      else memberVisible.add(row.id);
    }

    restrictedCaseId = (
      await prisma.case.create({
        data: { name: `k107-r-${randomUUID().slice(0, 6)}`, teamId, ownerUserId: A().ownerUserId, restrictedAtUtc: new Date() } as never,
        select: { id: true },
      })
    ).id;
    await prisma.caseComment.create({
      data: { teamId, caseId: restrictedCaseId, authorUserId: A().ownerUserId, body: "k107 restricted", visibility: "ALL_MEMBERS" },
    });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("page boundaries: every note once, newest first, stable order across pages (owner sees all)", async () => {
    const { pages, cursors } = await allPages(A().ownerToken, 10);
    expect(pages.map((p) => p.length)).toEqual([10, 10, 10, 10, 7]);
    expect(cursors.at(-1)).toBeNull();
    const flat = pages.flat();
    expect(new Set(flat.map((n) => n.id)).size).toBe(flat.length);
    expect(new Set(flat.map((n) => n.id))).toEqual(new Set(allIds));
    for (let i = 1; i < flat.length; i++) {
      const prev = flat[i - 1]!;
      const cur = flat[i]!;
      const ordered = prev.createdAt > cur.createdAt || (prev.createdAt === cur.createdAt && prev.id > cur.id);
      expect(ordered, `${prev.id}@${prev.createdAt} before ${cur.id}@${cur.createdAt}`).toBe(true);
    }
  });

  it("restricted notes are filtered on EVERY page for a plain member, not just the first", async () => {
    const { pages } = await allPages(A().memberToken, 7);
    expect(pages.length).toBeGreaterThan(2);
    for (const page of pages) {
      for (const note of page) expect(hiddenFromMember.has(note.id), `hidden note ${note.id} on a page`).toBe(false);
    }
    const flat = pages.flat();
    expect(new Set(flat.map((n) => n.id))).toEqual(memberVisible);
    expect(flat.length).toBe(memberVisible.size);
    // Full pages until the last: the boundary is computed after the filter.
    for (const page of pages.slice(0, -1)) expect(page).toHaveLength(7);
  });

  it("the matter workspace's first page hands over a cursor that continues without overlap", async () => {
    const ws = await get(`/v1/cases/${caseId}/matter-workspace`, A().memberToken);
    expect(ws.statusCode, ws.body).toBe(200);
    const notes = (ws.json() as {
      sections: { notes: { caseComments: Note[]; caseCommentsTotal: number; caseCommentsNextCursor: string | null } };
    }).sections.notes;
    expect(notes.caseComments).toHaveLength(25);
    expect(notes.caseCommentsTotal).toBe(memberVisible.size);
    expect(notes.caseCommentsNextCursor).toEqual(expect.any(String));
    const next = await get(
      `/v1/cases/${caseId}/comments?cursor=${encodeURIComponent(notes.caseCommentsNextCursor!)}`,
      A().memberToken,
    );
    expect(next.statusCode, next.body).toBe(200);
    const older = (next.json() as Page).comments;
    expect(older.length).toBe(memberVisible.size - 25);
    const firstIds = new Set(notes.caseComments.map((n) => n.id));
    for (const n of older) {
      expect(firstIds.has(n.id)).toBe(false);
      expect(hiddenFromMember.has(n.id)).toBe(false);
    }
    expect((next.json() as Page).nextCursor).toBeNull();
  });

  it("a forged cursor cannot widen reach, and a malformed one is refused", async () => {
    const forged = Buffer.from(`v1|${new Date(Date.now() + 60_000).toISOString()}|${randomUUID()}`, "utf8").toString("base64url");
    const res = await get(`/v1/cases/${caseId}/comments?limit=100&cursor=${forged}`, A().memberToken);
    expect(res.statusCode, res.body).toBe(200);
    const ids = (res.json() as Page).comments.map((n) => n.id);
    expect(new Set(ids)).toEqual(memberVisible);
    const bad = await get(`/v1/cases/${caseId}/comments?cursor=not-a-cursor`, A().memberToken);
    expect(bad.statusCode, bad.body).toBe(400);
  });

  it("outside reach: another tenant and a member without case reach get not-found, with no note text", async () => {
    const cross = await get(`/v1/cases/${caseId}/comments`, B().ownerToken);
    expect(cross.statusCode, cross.body).toBe(404);
    expect(cross.body).not.toContain("k107 note");
    const closed = await get(`/v1/cases/${restrictedCaseId}/comments`, A().memberToken);
    expect(closed.statusCode, closed.body).toBe(404);
    expect(closed.body).not.toContain("k107 restricted");
    const owner = await get(`/v1/cases/${restrictedCaseId}/comments`, A().ownerToken);
    expect(owner.statusCode, owner.body).toBe(200);
    expect(owner.body).toContain("k107 restricted");
  });
});
