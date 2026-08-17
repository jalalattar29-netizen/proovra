/**
 * PHASE 13 §1.4 — NEW-023 RUNTIME PROOF: status-blind workspace administration.
 *
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * `teams.routes.ts` resolved the acting member through `getActorMembership`,
 * which loaded the `TeamMember` row with NO status predicate. All twelve call
 * sites then tested only `!actor` and `actor.role`; the word `status` appeared
 * nowhere in the file. So a SUSPENDED or REVOKED member kept the role stored on
 * their row and retained workspace administration — reading the member list,
 * changing other members' roles, deleting invitations, unlinking cases.
 *
 * Revoking somebody's membership did not actually revoke anything.
 *
 * WHY THIS SUITE IS SHAPED THIS WAY
 * ---------------------------------------------------------------------------
 * The fix is at ONE choke point, so the proof is too: every route below is
 * driven three times against the SAME actor — ACTIVE, then SUSPENDED, then
 * REVOKED — and only the status column changes between them. The ACTIVE pass is
 * not decoration: without it a denial proves nothing, because a broken route
 * denies everyone. That control is also the direct evidence the fix did not
 * simply lock out legitimate administrators.
 *
 * The routes are the real registered ones, driven over HTTP against a real
 * disposable PostgreSQL 16 — not the helper in isolation, because the finding
 * was precisely that the helper's callers never looked at what it returned.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootIntegrationHarness,
  type IntegrationHarness,
} from "./integration-harness.js";

describe("NEW-023 — a SUSPENDED or REVOKED member loses workspace administration", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;

  let teamId: string;
  let adminUserId: string;
  let adminToken: string;
  let memberUserId: string;

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as
      import("@prisma/client").PrismaClient;
    teamId = h.fixtures.teamA.teamId;
    adminUserId = h.fixtures.teamA.adminUserId;
    adminToken = h.fixtures.teamA.adminToken;
    memberUserId = h.fixtures.teamA.memberUserId;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const auth = () => ({ authorization: `Bearer ${adminToken}` });

  const setStatus = async (status: "ACTIVE" | "SUSPENDED" | "REVOKED") => {
    await prisma.teamMember.updateMany({
      where: { teamId, userId: adminUserId },
      data: { status, role: "ADMIN" },
    });
  };

  /**
   * The administration surfaces `getActorMembership` guards.
   *
   * `url` is a BUILDER, not a string. Building the path eagerly would
   * interpolate `teamId` while it is still undefined — the describe body runs
   * at collection time, before `beforeAll` — and every request would go to
   * `/v1/teams/undefined/...` and fail schema validation with a 400 that looks
   * like a refusal. A suite that "passes" that way proves nothing.
   */
  const ADMIN_SURFACES = [
    { name: "GET team cases", method: "GET" as const, url: () => `/v1/teams/${teamId}/cases` },
    { name: "GET team invites", method: "GET" as const, url: () => `/v1/teams/${teamId}/invites` },
    { name: "GET team activity", method: "GET" as const, url: () => `/v1/teams/${teamId}/activity` },
    {
      name: "PATCH team",
      method: "PATCH" as const,
      url: () => `/v1/teams/${teamId}`,
      payload: { name: "Phase13 NEW-023 rename probe" } as Record<string, unknown>,
    },
  ] as const;

  const drive = (s: (typeof ADMIN_SURFACES)[number]) =>
    h.app.inject({
      method: s.method,
      url: s.url(),
      headers: auth(),
      ...("payload" in s ? { payload: s.payload } : {}),
    });

  it("POSITIVE CONTROL: an ACTIVE ADMIN can reach every administration surface", async () => {
    await setStatus("ACTIVE");
    for (const s of ADMIN_SURFACES) {
      const res = await drive(s);
      expect(
        res.statusCode,
        `${s.name} must succeed for an ACTIVE ADMIN, got ${res.statusCode}: ${res.body.slice(0, 200)}`,
      ).toBeLessThan(400);
    }
  });

  for (const status of ["SUSPENDED", "REVOKED"] as const) {
    describe(`a ${status} ADMIN`, () => {
      for (const s of ADMIN_SURFACES) {
        it(`is refused by ${s.name}`, async () => {
          // Control on this exact actor and route first, so the refusal that
          // follows is attributable to the status column and nothing else.
          await setStatus("ACTIVE");
          const ok = await drive(s);
          expect(
            ok.statusCode,
            `${s.name} ACTIVE control: ${ok.body.slice(0, 200)}`,
          ).toBeLessThan(400);

          await setStatus(status);
          const res = await drive(s);
          expect(
            res.statusCode,
            `${s.name} admitted a ${status} member (${res.statusCode}) — membership status is not enforced`,
          ).toBeGreaterThanOrEqual(400);

          await setStatus("ACTIVE");
        });
      }

      it("cannot change another member's role", async () => {
        // The most consequential of the twelve: a revoked administrator
        // promoting somebody (or themselves, via another account) would make
        // the revocation reversible by its own victim.
        const target = await prisma.teamMember.findFirst({
          where: { teamId, userId: memberUserId },
          select: { id: true, role: true },
        });
        expect(target, "fixture member must exist").toBeTruthy();
        const before = target?.role;

        await setStatus(status);
        const res = await h.app.inject({
          method: "PATCH",
          url: `/v1/teams/${teamId}/members/${target?.id}`,
          headers: auth(),
          payload: { role: "ADMIN" },
        });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);

        const after = await prisma.teamMember.findUnique({
          where: { id: target?.id as string },
          select: { role: true },
        });
        expect(
          after?.role,
          `a ${status} member changed another member's role — the refusal did not prevent the write`,
        ).toBe(before);

        await setStatus("ACTIVE");
      });
    });
  }

  it("the refusal is the MEMBERSHIP decision, not an accident of the role check", async () => {
    // A SUSPENDED OWNER must also be refused. If the gate were really only
    // reading `role`, an OWNER would still pass — this is what separates
    // "status is enforced" from "the role happened not to match".
    await prisma.teamMember.updateMany({
      where: { teamId, userId: adminUserId },
      data: { role: "OWNER", status: "ACTIVE" },
    });
    const ok = await h.app.inject({
      method: "GET",
      url: `/v1/teams/${teamId}/invites`,
      headers: auth(),
    });
    expect(ok.statusCode, "ACTIVE OWNER control").toBeLessThan(400);

    await prisma.teamMember.updateMany({
      where: { teamId, userId: adminUserId },
      data: { status: "SUSPENDED" },
    });
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/teams/${teamId}/invites`,
      headers: auth(),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    await prisma.teamMember.updateMany({
      where: { teamId, userId: adminUserId },
      data: { role: "ADMIN", status: "ACTIVE" },
    });
  });
});
