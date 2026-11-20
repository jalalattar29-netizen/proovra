/**
 * RG-26 matrix-review gaps (live PostgreSQL).
 *
 * NEW-RG-26-1 / NEW-RG-26-2 — PRO-T1-03 / PRO-T1-18: records never end up
 * owned by a person who is no longer an active member. DELETE
 * /v1/teams/:id/members refused (or transferred), but the Security Center
 * revoke (`POST /v1/identity/members/:id/revoke`) and an access-review
 * REVOKE_MEMBER decision called the engine's `revokeMember` directly, and the
 * engine had no such rule. The refusal now lives in the engine, inside its
 * transaction, so every caller holds the membership until the records are
 * handed over (the teams removal hands them over in the same transaction
 * before it revokes).
 *
 * NEW-RG-26-3 — PRO-T1-15 / DEC-28: invitations an inviter issued stop carrying
 * authority the inviter no longer holds. The rbac lifecycle commands revoked
 * them; a directory demotion (`applyDirectoryRoleChange`) and a directory /
 * organization suspension (`suspendWorkspaceMembership`) did not.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";

describe("RG-26 gaps — departure keeps records owned and invitations bounded (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  // The application graph reads DATABASE_URL at import time and the harness
  // sets it at boot, so these load once in beforeAll, after the boot.
  let prisma: import("@prisma/client").PrismaClient;
  let rbac: typeof import("../src/services/identity/rbac.service.js");
  let provisioning: typeof import("../src/services/identity/membership-provisioning.service.js");
  let accessReview: typeof import("../src/services/identity/access-review.service.js");
  let rbacErrorStatus: typeof import("../src/http/member-command-gates.js")["rbacErrorStatus"];
  let REQUIRED_LEGAL_VERSIONS: Record<string, string>;
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    rbac = await import("../src/services/identity/rbac.service.js");
    provisioning = await import("../src/services/identity/membership-provisioning.service.js");
    accessReview = await import("../src/services/identity/access-review.service.js");
    ({ rbacErrorStatus } = await import("../src/http/member-command-gates.js"));
    REQUIRED_LEGAL_VERSIONS = (await import("../src/legal/legal-versioning.js")).REQUIRED_LEGAL_VERSIONS as Record<string, string>;
    await prisma.team.updateMany({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  async function person(role: "ADMIN" | "MEMBER") {
    const email = `rg26-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, displayName: "RG-26 member", provider: "EMAIL", providerUserId: email },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "integration-harness",
      })),
    });
    const m = await prisma.teamMember.create({ data: { teamId: A().teamId, userId: user.id, role, status: "ACTIVE" } });
    return { id: user.id, memberId: m.id };
  }

  async function ownedRecord(ownerUserId: string) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    return prisma.evidence.create({
      data: { title: `rg26 ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId: A().teamId, organizationId: team.organizationId, ownerUserId },
      select: { id: true },
    });
  }

  const status = async (memberId: string) =>
    (await prisma.teamMember.findUniqueOrThrow({ where: { id: memberId }, select: { status: true } })).status;

  async function invite(inviterUserId: string, role: "ADMIN" | "MEMBER" | "VIEWER") {
    return prisma.teamInvite.create({
      data: {
        teamId: A().teamId,
        email: `rg26-invitee-${randomUUID().slice(0, 8)}@test.proovra.local`,
        role,
        tokenHash: randomBytes(32).toString("hex"),
        invitedByUserId: inviterUserId,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
      select: { id: true },
    });
  }
  const inviteRevoked = async (id: string) =>
    (await prisma.teamInvite.findUniqueOrThrow({ where: { id }, select: { revokedAt: true } })).revokedAt !== null;

  // ---------------------------------------------------------------- NEW-RG-26-1
  it("NEW-RG-26-1: the engine refuses to revoke a member who still owns records; the membership stays ACTIVE and the record keeps its owner", async () => {
    const m = await person("MEMBER");
    const ev = await ownedRecord(m.id);
    await expect(
      rbac.revokeMember({ teamId: A().teamId, teamMemberId: m.memberId, actorUserId: A().ownerUserId }),
    ).rejects.toMatchObject({ code: "owned_records_handover_required" });
    expect(await status(m.memberId)).toBe("ACTIVE");
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id }, select: { ownerUserId: true } })).ownerUserId).toBe(m.id);
    // The refusal is a 409 on every route that maps engine refusals.
    expect(rbacErrorStatus("owned_records_handover_required")).toBe(409);
  });

  it("NEW-RG-26-1: a trashed record still counts; a destroyed one does not", async () => {
    const m = await person("MEMBER");
    const ev = await ownedRecord(m.id);
    await prisma.evidence.update({ where: { id: ev.id }, data: { lifecycleState: "TRASHED" } as never });
    await expect(
      rbac.revokeMember({ teamId: A().teamId, teamMemberId: m.memberId, actorUserId: A().ownerUserId }),
    ).rejects.toMatchObject({ code: "owned_records_handover_required" });
    await prisma.evidence.update({ where: { id: ev.id }, data: { lifecycleState: "DESTROYED" } as never });
    await rbac.revokeMember({ teamId: A().teamId, teamMemberId: m.memberId, actorUserId: A().ownerUserId });
    expect(await status(m.memberId)).toBe("REVOKED");
  });

  it("NEW-RG-26-1: a member who owns nothing is revoked (positive control)", async () => {
    const m = await person("MEMBER");
    await rbac.revokeMember({ teamId: A().teamId, teamMemberId: m.memberId, actorUserId: A().ownerUserId });
    expect(await status(m.memberId)).toBe("REVOKED");
  });

  it("NEW-RG-26-1: leaving is refused inside the engine too (the route pre-check is outside the transaction)", async () => {
    const m = await person("MEMBER");
    await ownedRecord(m.id);
    await expect(rbac.leaveWorkspace({ teamId: A().teamId, userId: m.id })).rejects.toMatchObject({
      code: "owned_records_handover_required",
    });
    expect(await status(m.memberId)).toBe("ACTIVE");
  });

  // ---------------------------------------------------------------- NEW-RG-26-2
  it("NEW-RG-26-2: an access-review REVOKE_MEMBER decision is refused while the subject owns records; the review stays PENDING", async () => {
    const m = await person("MEMBER");
    await ownedRecord(m.id);
    const review = await prisma.accessReview.create({
      data: {
        teamId: A().teamId,
        kind: "PERIODIC_MEMBER_REVIEW",
        subjectKind: "TEAM_MEMBER",
        subjectUserId: m.id,
      },
      select: { id: true },
    });
    await expect(
      accessReview.completeAccessReview({
        teamId: A().teamId,
        reviewId: review.id,
        actorUserId: A().ownerUserId,
        decision: "REVOKE_MEMBER",
      }),
    ).rejects.toMatchObject({ code: "owned_records_handover_required" });
    expect(await status(m.memberId)).toBe("ACTIVE");
    expect((await prisma.accessReview.findUniqueOrThrow({ where: { id: review.id }, select: { status: true } })).status).toBe("PENDING");
  });

  // ---------------------------------------------------------------- NEW-RG-26-3
  it("NEW-RG-26-3: a directory demotion of an ADMIN revokes the invitations the new role can no longer issue", async () => {
    const admin = await person("ADMIN");
    const member = await invite(admin.id, "MEMBER");
    const viewer = await invite(admin.id, "VIEWER");
    const otherInviter = await invite(A().ownerUserId, "MEMBER");
    await prisma.$transaction(async (tx) => {
      const r = await provisioning.applyDirectoryRoleChange(tx as never, {
        teamMemberId: admin.memberId,
        currentRole: "ADMIN",
        desiredRole: "MEMBER",
        source: "SCIM",
        allowPrivilegedChange: true,
      });
      expect(r.changed).toBe(true);
    });
    expect(await inviteRevoked(member.id)).toBe(true);
    expect(await inviteRevoked(viewer.id)).toBe(true);
    // Positive control: another inviter's invitation is untouched.
    expect(await inviteRevoked(otherInviter.id)).toBe(false);
  });

  it("NEW-RG-26-3: a directory suspension revokes the suspended inviter's pending invitations", async () => {
    const admin = await person("ADMIN");
    const pending = await invite(admin.id, "MEMBER");
    const otherInviter = await invite(A().ownerUserId, "VIEWER");
    await prisma.$transaction(async (tx) => {
      await provisioning.suspendWorkspaceMembership(tx as never, {
        teamMemberId: admin.memberId,
        actorUserId: null,
        reason: "scim deactivation",
      });
    });
    expect(await status(admin.memberId)).toBe("SUSPENDED");
    expect(await inviteRevoked(pending.id)).toBe(true);
    expect(await inviteRevoked(otherInviter.id)).toBe(false);
  });
});
