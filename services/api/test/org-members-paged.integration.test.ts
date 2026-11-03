/**
 * CAP-10 — `GET /v1/orgs/:id/members` pages. It returned every membership in
 * one response (1,500 rows, 556 kB on the capacity fixture). Positive control:
 * the owner walks every page and sees each member exactly once, with whole-org
 * counts on every page. Negative controls: a cursor from another organization,
 * and a non-admin caller of another organization.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";

describe("CAP-10 — the organization member list is paged", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let orgA: string;
  let orgB: string;
  let foreignMembershipId: string;
  const created: string[] = [];

  const get = (url: string, token: string) =>
    h.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    orgA = (await prisma.team.findUniqueOrThrow({ where: { id: h.fixtures.teamA.teamId }, select: { organizationId: true } })).organizationId;
    orgB = (await prisma.team.findUniqueOrThrow({ where: { id: h.fixtures.teamB.teamId }, select: { organizationId: true } })).organizationId;
    // 120 more members of org A, with a suspended one among them.
    for (let i = 0; i < 120; i += 1) {
      const user = await prisma.user.create({
        data: {
          provider: "EMAIL",
          providerUserId: `cap10-${i}-${randomUUID()}@example.test`,
          email: `cap10-${i}-${randomUUID()}@example.test`,
          displayName: `Cap Ten ${String(i).padStart(3, "0")}`,
        },
        select: { id: true },
      });
      created.push(user.id);
      await prisma.organizationMembership.create({
        data: { organizationId: orgA, userId: user.id, role: "ORG_MEMBER", ...(i === 7 ? { status: "SUSPENDED", suspendedAtUtc: new Date(), statusChangedAtUtc: new Date() } : {}) },
      });
    }
    foreignMembershipId = (
      await prisma.organizationMembership.findFirstOrThrow({ where: { organizationId: orgB }, select: { id: true } })
    ).id;
  }, 900_000);

  afterAll(async () => {
    await prisma?.organizationMembership.deleteMany({ where: { userId: { in: created } } });
    await prisma?.user.deleteMany({ where: { id: { in: created } } });
    await h?.cleanup();
  }, 300_000);

  it("walks every member once, page by page, with whole-organization counts", async () => {
    const total = await prisma.organizationMembership.count({ where: { organizationId: orgA } });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(
        `/v1/orgs/${orgA}/members?limit=50${cursor ? `&cursor=${cursor}` : ""}`,
        h.fixtures.teamA.ownerToken,
      );
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.members.length).toBeLessThanOrEqual(50);
      expect(body.summary.totalMembers).toBe(total);
      expect(body.summary.byStatus.SUSPENDED).toBeGreaterThanOrEqual(1);
      seen.push(...body.members.map((m: { membershipId: string }) => m.membershipId));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    expect(pages).toBe(Math.ceil(total / 50));
    expect(new Set(seen).size).toBe(total);
    expect(seen.length).toBe(total);
  });

  it("a default read is one bounded page, and a search counts its matches", async () => {
    const page = (await get(`/v1/orgs/${orgA}/members`, h.fixtures.teamA.ownerToken)).json();
    expect(page.members).toHaveLength(50);
    expect(page.nextCursor).toEqual(expect.any(String));
    const hit = (await get(`/v1/orgs/${orgA}/members?q=Cap%20Ten%20007`, h.fixtures.teamA.ownerToken)).json();
    expect(hit.members.map((m: { displayName: string }) => m.displayName)).toEqual(["Cap Ten 007"]);
    expect(hit.summary.matchingMembers).toBe(1);
    expect(hit.members[0].status).toBe("SUSPENDED");
  });

  it("refuses a cursor that belongs to another organization, and a caller from another organization", async () => {
    const foreignCursor = await get(`/v1/orgs/${orgA}/members?cursor=${foreignMembershipId}`, h.fixtures.teamA.ownerToken);
    expect(foreignCursor.statusCode).toBe(400);
    expect(foreignCursor.json().error.code).toBe("INVALID_CURSOR");
    const outsider = await get(`/v1/orgs/${orgA}/members`, h.fixtures.teamB.memberToken);
    expect([403, 404]).toContain(outsider.statusCode);
    expect(JSON.stringify(outsider.json())).not.toContain("Cap Ten");
  });
});
