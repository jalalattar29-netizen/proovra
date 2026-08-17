/**
 * PHASE 13 §A4 — RUNTIME PROOF for the two production defects the tenancy pass
 * found. Two DISTINCT patterns, one suite, because they are the same mistake
 * seen from opposite ends: a tenant decision that was never made.
 *
 * NEW-025 — STATUS-BLIND GRANT (HIGH)
 * ---------------------------------------------------------------------------
 * `POST /v1/cases/:id/share-email` performs `caseAccess.upsert` — a STANDING
 * grant on tenant-owned case data — after checking only that the CALLER owns
 * the case. Nothing checked the TARGET. Its sibling `POST /v1/cases/:id/share-team`
 * was remediated on 2026-07-21 for exactly this, with the reason written into
 * the source: "granting CaseAccess confers standing access, so a suspended /
 * revoked target member must not be shareable-to". The email spelling of the
 * same grant was left behind, so the identical access could be handed to a
 * suspended member, a revoked member, or a user who was never in the workspace
 * at all — by typing their email address.
 *
 * NEW-026 — TENANT ID TAKEN ON TRUST (MEDIUM)
 * ---------------------------------------------------------------------------
 * `POST /v1/capture/sessions` wrote `teamId: body.teamId ?? null` with no
 * membership check. Any authenticated user could create a CaptureSession
 * claiming ANY workspace id, carrying their own item snapshots and internal
 * notes. The route's own comment said team drafts' "membership + plan gates
 * apply downstream" — downstream is the wrong place for the question of whose
 * workspace a row is written into, and the row is written here.
 *
 * WHY EACH TEST ASSERTS ON THE DATABASE
 * ---------------------------------------------------------------------------
 * A 4xx that performed the write anyway is the worst outcome and the only one a
 * status-code assertion cannot see. Every case below reads the durable rows
 * back. Each also carries its CONTROL — the legitimate actor must still
 * succeed — because a route that refuses everyone would pass a refusal test
 * while being a total outage.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootIntegrationHarness,
  type IntegrationHarness,
} from "./integration-harness.js";

describe("NEW-025 / NEW-026 — tenant grants and tenant stamps", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as
      import("@prisma/client").PrismaClient;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // -------------------------------------------------------------------------
  // NEW-025
  // -------------------------------------------------------------------------

  describe("NEW-025 — share-email cannot grant standing case access to a non-ACTIVE or foreign user", () => {
    const setMemberStatus = async (
      teamId: string,
      userId: string,
      status: "ACTIVE" | "SUSPENDED" | "REVOKED",
    ) => {
      await prisma.teamMember.updateMany({
        where: { teamId, userId },
        data: { status },
      });
    };

    const accessRows = async (caseId: string, userId: string) =>
      prisma.caseAccess.count({ where: { caseId, userId } });

    const shareByEmail = (caseId: string, token: string, email: string) =>
      h.app.inject({
        method: "POST",
        url: `/v1/cases/${caseId}/share-email`,
        headers: { authorization: `Bearer ${token}` },
        payload: { email },
      });

    for (const status of ["SUSPENDED", "REVOKED"] as const) {
      it(`a ${status} workspace member is refused, and NO CaseAccess row exists afterwards`, async () => {
        const { teamId, caseId, ownerToken, memberUserId } = h.fixtures.teamA;
        const target = await prisma.user.findUnique({
          where: { id: memberUserId },
          select: { email: true },
        });
        expect(target?.email, "fixture member must have an email").toBeTruthy();

        await prisma.caseAccess.deleteMany({ where: { caseId, userId: memberUserId } });
        await setMemberStatus(teamId, memberUserId, status);
        try {
          const res = await shareByEmail(caseId, ownerToken, target!.email as string);
          expect(
            res.statusCode,
            `a ${status} member was shareable-to (${res.statusCode}): ${res.body.slice(0, 200)}`,
          ).toBeGreaterThanOrEqual(400);

          // The assertion that matters: no standing grant was written.
          expect(
            await accessRows(caseId, memberUserId),
            `a CaseAccess row was created for a ${status} member despite the refusal`,
          ).toBe(0);
        } finally {
          await setMemberStatus(teamId, memberUserId, "ACTIVE");
          await prisma.caseAccess.deleteMany({ where: { caseId, userId: memberUserId } });
        }
      });
    }

    it("a user from ANOTHER workspace is refused, and no cross-tenant grant is written", async () => {
      const { caseId, ownerToken } = h.fixtures.teamA;
      const foreignUserId = h.fixtures.teamB.memberUserId;
      const foreign = await prisma.user.findUnique({
        where: { id: foreignUserId },
        select: { email: true },
      });
      expect(foreign?.email).toBeTruthy();

      await prisma.caseAccess.deleteMany({ where: { caseId, userId: foreignUserId } });
      const res = await shareByEmail(caseId, ownerToken, foreign!.email as string);
      expect(
        res.statusCode,
        `a user outside the workspace was granted access (${res.statusCode}): ${res.body.slice(0, 200)}`,
      ).toBeGreaterThanOrEqual(400);
      expect(
        await accessRows(caseId, foreignUserId),
        "a cross-tenant CaseAccess row was written",
      ).toBe(0);
    });

    it("CONTROL — an ACTIVE member of the same workspace IS still shareable-to", async () => {
      // Without this, every assertion above is satisfied by a route that
      // refuses everything, which would be an outage rather than a fix.
      const { teamId, caseId, ownerToken, memberUserId } = h.fixtures.teamA;
      const target = await prisma.user.findUnique({
        where: { id: memberUserId },
        select: { email: true },
      });
      await setMemberStatus(teamId, memberUserId, "ACTIVE");
      await prisma.caseAccess.deleteMany({ where: { caseId, userId: memberUserId } });
      try {
        const res = await shareByEmail(caseId, ownerToken, target!.email as string);
        expect(
          res.statusCode,
          `an ACTIVE member was refused — the fix is over-tight: ${res.body.slice(0, 300)}`,
        ).toBeLessThan(400);
        expect(await accessRows(caseId, memberUserId)).toBe(1);
      } finally {
        await prisma.caseAccess.deleteMany({ where: { caseId, userId: memberUserId } });
      }
    });
  });

  // -------------------------------------------------------------------------
  // NEW-026
  // -------------------------------------------------------------------------

  describe("NEW-026 — a capture session cannot claim a workspace the caller is not an ACTIVE member of", () => {
    const createSession = (token: string, teamId: string | null) =>
      h.app.inject({
        method: "POST",
        url: "/v1/capture/sessions",
        headers: { authorization: `Bearer ${token}` },
        payload: teamId === null ? {} : { teamId },
      });

    it("a foreign workspace id is refused, and NO CaptureSession row is written for it", async () => {
      const foreignTeamId = h.fixtures.teamB.teamId;
      const actorUserId = h.fixtures.teamA.ownerUserId;
      const before = await prisma.captureSession.count({
        where: { teamId: foreignTeamId, ownerUserId: actorUserId },
      });

      const res = await createSession(h.fixtures.teamA.ownerToken, foreignTeamId);
      expect(
        res.statusCode,
        `a caller created a draft in a workspace they do not belong to (${res.statusCode}): ${res.body.slice(0, 200)}`,
      ).toBeGreaterThanOrEqual(400);

      expect(
        await prisma.captureSession.count({
          where: { teamId: foreignTeamId, ownerUserId: actorUserId },
        }),
        "a CaptureSession stamped with a foreign teamId was written despite the refusal",
      ).toBe(before);
    });

    it("a SUSPENDED member of the named workspace is refused", async () => {
      const { teamId, memberUserId, memberToken } = h.fixtures.teamA;
      await prisma.teamMember.updateMany({
        where: { teamId, userId: memberUserId },
        data: { status: "SUSPENDED" },
      });
      try {
        const before = await prisma.captureSession.count({
          where: { teamId, ownerUserId: memberUserId },
        });
        const res = await createSession(memberToken, teamId);
        expect(
          res.statusCode,
          `a SUSPENDED member created a team draft (${res.statusCode}): ${res.body.slice(0, 200)}`,
        ).toBeGreaterThanOrEqual(400);
        expect(
          await prisma.captureSession.count({ where: { teamId, ownerUserId: memberUserId } }),
          "a CaptureSession was written for a SUSPENDED member",
        ).toBe(before);
      } finally {
        await prisma.teamMember.updateMany({
          where: { teamId, userId: memberUserId },
          data: { status: "ACTIVE" },
        });
      }
    });

    it("CONTROL — an ACTIVE member of the named workspace still creates the draft", async () => {
      const { teamId, memberUserId, memberToken } = h.fixtures.teamA;
      const res = await createSession(memberToken, teamId);
      expect(
        res.statusCode,
        `an ACTIVE member was refused — the fix is over-tight: ${res.body.slice(0, 300)}`,
      ).toBeLessThan(400);
      const created = await prisma.captureSession.findFirst({
        where: { teamId, ownerUserId: memberUserId },
        orderBy: { createdAt: "desc" },
        select: { id: true, teamId: true },
      });
      expect(created?.teamId, "the draft did not land in the named workspace").toBe(teamId);
      if (created) await prisma.captureSession.delete({ where: { id: created.id } });
    });
  });
});
