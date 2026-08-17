/**
 * PHASE 13 §1.4 — NEW-024 RUNTIME PROOF: status-blind organization ownership
 * transfer.
 *
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * `POST /v1/orgs/:id/transfer-ownership` authorized its caller with
 *
 *     { organizationId, userId, role: "ORG_OWNER" }
 *
 * and no `status` predicate. A SUSPENDED or REVOKED organization owner could
 * therefore transfer ORGANIZATION OWNERSHIP — the most consequential membership
 * mutation in the system, and the one that would let a revoked owner
 * re-establish control through another account they hold.
 *
 * Every sibling org-admin lookup in the same file already carried
 * `status: "ACTIVE"` (the ORG_OWNER checks guarding member removal and role
 * change), so this was an inconsistency rather than a deliberate exemption.
 *
 * WHY THE STEP-UP PROOF IS NOT THE CONTROL
 * ---------------------------------------------------------------------------
 * The route requires a step-up proof before the membership lookup. That is a
 * SECOND FACTOR, not a lifecycle check: a suspended owner still holds their own
 * credentials and passes it. The suite therefore asserts on the DATABASE — who
 * owns the organization afterwards — rather than on a status code alone, so a
 * refusal that happened for an unrelated reason cannot be mistaken for the
 * membership decision doing its job.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootIntegrationHarness,
  type IntegrationHarness,
} from "./integration-harness.js";

describe("NEW-024 — a non-ACTIVE ORG_OWNER cannot transfer organization ownership", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;

  let organizationId: string;
  let ownerUserId: string;
  let ownerToken: string;
  let targetUserId: string;

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as
      import("@prisma/client").PrismaClient;

    ownerUserId = h.fixtures.teamA.ownerUserId;
    ownerToken = h.fixtures.teamA.ownerToken;
    targetUserId = h.fixtures.teamA.adminUserId;

    const team = await prisma.team.findUnique({
      where: { id: h.fixtures.teamA.teamId },
      select: { organizationId: true },
    });
    organizationId = team?.organizationId as string;
    expect(organizationId, "the fixture workspace must carry an organization").toBeTruthy();

    // Both actors must be organization members for the transfer to be a
    // MEMBERSHIP-STATUS test rather than a "target is not a member" test.
    for (const [userId, role] of [
      [ownerUserId, "ORG_OWNER"],
      [targetUserId, "ORG_MEMBER"],
    ] as const) {
      const existing = await prisma.organizationMembership.findFirst({
        where: { organizationId, userId },
        select: { id: true },
      });
      if (existing) {
        await prisma.organizationMembership.update({
          where: { id: existing.id },
          data: { role, status: "ACTIVE" },
        });
      } else {
        await prisma.organizationMembership.create({
          data: {
            id: randomUUID(),
            organizationId,
            userId,
            role,
            status: "ACTIVE",
            updatedAt: new Date(),
          },
        });
      }
    }
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  /**
   * The schema enforces a status TIMELINE with a CHECK constraint:
   * ACTIVE requires both timestamps null, SUSPENDED requires `suspendedAtUtc`,
   * REVOKED requires `revokedAtUtc`. Writing the enum alone is rejected by the
   * database — correctly, since a lifecycle state with no transition time is
   * not a state anyone could audit. The fixture therefore moves the whole
   * timeline, exactly as the production transition writer does.
   */
  const setOwnerStatus = async (status: "ACTIVE" | "SUSPENDED" | "REVOKED") => {
    const now = new Date();
    await prisma.organizationMembership.updateMany({
      where: { organizationId, userId: ownerUserId },
      data: {
        status,
        role: "ORG_OWNER",
        statusChangedAtUtc: now,
        suspendedAtUtc: status === "SUSPENDED" ? now : null,
        revokedAtUtc: status === "REVOKED" ? now : null,
      },
    });
  };

  const currentOwners = async (): Promise<string[]> => {
    const rows = await prisma.organizationMembership.findMany({
      where: { organizationId, role: "ORG_OWNER" },
      select: { userId: true },
    });
    return rows.map((r) => r.userId).sort();
  };

  const transfer = () =>
    h.app.inject({
      method: "POST",
      url: `/v1/orgs/${organizationId}/transfer-ownership`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { targetUserId },
    });

  for (const status of ["SUSPENDED", "REVOKED"] as const) {
    it(`a ${status} ORG_OWNER cannot transfer ownership, and the owner set is unchanged`, async () => {
      await setOwnerStatus(status);
      const ownersBefore = await currentOwners();
      expect(ownersBefore, "the fixture owner must hold ownership going in").toContain(
        ownerUserId,
      );

      const res = await transfer();
      expect(
        res.statusCode,
        `a ${status} owner was admitted (${res.statusCode}): ${res.body.slice(0, 200)}`,
      ).toBeGreaterThanOrEqual(400);

      // THE ASSERTION THAT MATTERS: the durable owner set did not move. A 4xx
      // that still performed the swap would be the worst possible outcome, and
      // only the database can rule it out.
      expect(
        await currentOwners(),
        `ownership changed despite the refusal — a ${status} owner completed the transfer`,
      ).toEqual(ownersBefore);
      expect(await currentOwners()).not.toContain(targetUserId);

      await setOwnerStatus("ACTIVE");
    });
  }

  it("the refusal is the STATUS decision — an ACTIVE owner is refused only by the step-up factor, never by membership", async () => {
    // The control. Without it, the two denials above are indistinguishable from
    // a route that refuses everyone (for instance because step-up always fails
    // in this environment).
    //
    // An ACTIVE owner must NOT be refused with the owner-required denial. It
    // may still be refused by the step-up second factor, which this environment
    // cannot satisfy — so the assertion is on the DENIAL REASON, not on success.
    await setOwnerStatus("ACTIVE");
    const res = await transfer();
    const body = res.body.toLowerCase();
    expect(
      body.includes("owner_required"),
      `an ACTIVE ORG_OWNER was refused with owner_required — the membership gate is rejecting a legitimate owner. Body: ${res.body.slice(0, 300)}`,
    ).toBe(false);

    // And a non-ACTIVE owner IS refused with exactly that reason, which is what
    // proves the two cases diverge on the status column alone.
    await setOwnerStatus("SUSPENDED");
    const suspended = await transfer();
    expect(
      suspended.body.toLowerCase().includes("owner_required"),
      `a SUSPENDED owner should be refused as owner_required. Body: ${suspended.body.slice(0, 300)}`,
    ).toBe(true);

    await setOwnerStatus("ACTIVE");
  });
});
