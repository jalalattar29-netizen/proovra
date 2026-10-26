/**
 * PHASE D — ACCOUNT CLOSURE, ENTERPRISE TERMINATION, ONE CLOSURE LEG SET
 * (members audit LIFE-09, LIFE-10, LIFE-11, LIFE-12, LIFE-13, LIFE-16).
 *
 * Every case drives the real closure engines against a real PostgreSQL:
 *   - account closure closes the workspace the user OWNED (credentials,
 *     webhooks, invitations, external grants, suspended members and their
 *     reach), stamps `closedAtUtc`, anonymises only afterwards, preserves
 *     evidence, and is idempotent;
 *   - an interrupted closure is resumed by the reaper;
 *   - workspace closure revokes pending invitations, organization closure
 *     stamps `closedAtUtc`;
 *   - an Enterprise contract termination moves ACTIVE → TERMINATING →
 *     TERMINATED through the canonical organization closure.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedOrganizationTenant,
  seedPersonalTenant,
  seedUser,
  type FixtureDeps,
} from "./point7/product-fixtures.js";

type Prisma = typeof import("../src/db.js")["prisma"];

describe("Phase D — closure lifecycle (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: Prisma;
  let deps: FixtureDeps;
  let accountClosure: typeof import("../src/services/identity/account-closure.service.js");
  let workspaceClosure: typeof import("../src/services/workspace/workspace-closure.service.js");
  let orgClosure: typeof import("../src/services/organization/org-closure.service.js");
  let termination: typeof import("../src/services/organization/enterprise-termination.service.js");
  let tick: typeof import("../src/services/lifecycle/lifecycle-scheduler.service.js");
  let ct: typeof import("../src/services/collaboration-team/collaboration-team.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    accountClosure = await import("../src/services/identity/account-closure.service.js");
    workspaceClosure = await import("../src/services/workspace/workspace-closure.service.js");
    orgClosure = await import("../src/services/organization/org-closure.service.js");
    termination = await import("../src/services/organization/enterprise-termination.service.js");
    tick = await import("../src/services/lifecycle/lifecycle-scheduler.service.js");
    ct = await import("../src/services/collaboration-team/collaboration-team.service.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `lifed-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt({ sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) }, secret, 3600),
    };
  }, 900_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);

  /** A workspace with every kind of live thing a closure must settle. */
  async function populate(teamId: string, ownerUserId: string) {
    const suspended = await seedUser(deps, `susp-${tag()}`);
    await prisma.teamMember.create({ data: { teamId, userId: suspended.userId, role: "MEMBER", status: "ACTIVE" } });
    const group = await ct.createCollaborationTeam({ workspaceId: teamId, actorUserId: ownerUserId, name: `G ${tag()}` });
    await ct.addExistingMember({ teamId: group.id, actorUserId: ownerUserId, userIdToAdd: suspended.userId });
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    const caseRow = await prisma.case.create({ data: { name: `C ${tag()}`, teamId, ownerUserId }, select: { id: true } });
    await prisma.caseAccess.create({ data: { caseId: caseRow.id, userId: suspended.userId } });
    await prisma.teamMember.updateMany({ where: { teamId, userId: suspended.userId }, data: { status: "SUSPENDED" } });
    const evidence = await prisma.evidence.create({
      data: { title: `E ${tag()}`, type: "PHOTO", status: "CREATED", teamId, organizationId: team.organizationId, ownerUserId },
      select: { id: true },
    });
    const invite = await prisma.teamInvite.create({
      data: {
        teamId,
        email: `pending-${tag()}@invitee.test`,
        role: "MEMBER",
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        expiresAt: new Date(Date.now() + 86_400_000),
        invitedByUserId: ownerUserId,
      },
      select: { id: true },
    });
    const credential = await prisma.apiCredential.create({
      data: { teamId, name: "ci", keyPrefix: `pk_${tag()}`, keyHash: createHash("sha256").update(randomUUID()).digest("hex"), createdByUserId: ownerUserId },
      select: { id: true },
    });
    const webhook = await prisma.webhookEndpoint.create({
      data: { teamId, url: "https://hooks.example.test/x", secretCiphertext: "x", secretPrefix: "whs_x", createdByUserId: ownerUserId },
      select: { id: true },
    });
    const grant = await prisma.externalReviewGrant.create({
      data: {
        teamId,
        scopeKind: "EVIDENCE",
        evidenceId: evidence.id,
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        reviewerEmail: `reviewer-${tag()}@external.test`,
        state: "ACTIVE",
        invitedByUserId: ownerUserId,
        expiresAtUtc: new Date(Date.now() + 86_400_000),
      },
      select: { id: true },
    });
    return { suspended, groupId: group.id, caseId: caseRow.id, evidenceId: evidence.id, inviteId: invite.id, credentialId: credential.id, webhookId: webhook.id, grantId: grant.id };
  }

  async function assertSettled(teamId: string, live: Awaited<ReturnType<typeof populate>>) {
    expect((await prisma.team.findUniqueOrThrow({ where: { id: teamId } })).closedAtUtc).not.toBeNull();
    expect((await prisma.teamMember.findFirstOrThrow({ where: { teamId, userId: live.suspended.userId } })).status).toBe("REVOKED");
    expect(await prisma.caseAccess.count({ where: { caseId: live.caseId, userId: live.suspended.userId } })).toBe(0);
    expect((await prisma.collaborationTeamMember.findFirstOrThrow({ where: { teamId: live.groupId, userId: live.suspended.userId } })).status).toBe("REMOVED");
    expect((await prisma.teamInvite.findUniqueOrThrow({ where: { id: live.inviteId } })).revokedAt).not.toBeNull();
    expect((await prisma.apiCredential.findUniqueOrThrow({ where: { id: live.credentialId } })).status).toBe("REVOKED");
    expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: live.webhookId } })).status).toBe("DISABLED");
    expect((await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: live.grantId } })).state).toBe("REVOKED");
    // Evidence is governed, never destroyed.
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id: live.evidenceId } });
    expect(ev.deletedAt).toBeNull();
  }

  it("LIFE-09/13 — account closure closes the owned workspace first, then anonymises; a second run changes nothing", async () => {
    const t = await seedPersonalTenant(deps, "TEAM");
    const live = await populate(t.personalTeamId, t.owner.userId);
    await accountClosure.executeAccountClosure(t.owner.userId);
    await assertSettled(t.personalTeamId, live);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: t.owner.userId } });
    expect(user.email).toBeNull();
    expect(user.providerUserId).toBe(`closed:${t.owner.userId}`);

    const closedAt = (await prisma.team.findUniqueOrThrow({ where: { id: t.personalTeamId } })).closedAtUtc;
    await expect(accountClosure.executeAccountClosure(t.owner.userId)).resolves.toBeUndefined();
    expect((await prisma.team.findUniqueOrThrow({ where: { id: t.personalTeamId } })).closedAtUtc).toEqual(closedAt);
  });

  it("LIFE-13 — other members are a consequence shown before confirming, not a blocker; closure then revokes them", async () => {
    const t = await seedPersonalTenant(deps, "TEAM");
    const active = await seedUser(deps, `active-${tag()}`);
    const suspended = await seedUser(deps, `suspended-${tag()}`);
    await prisma.teamMember.create({ data: { teamId: t.personalTeamId, userId: active.userId, role: "MEMBER", status: "ACTIVE" } });
    await prisma.teamMember.create({ data: { teamId: t.personalTeamId, userId: suspended.userId, role: "MEMBER", status: "SUSPENDED" } });

    const res = await harness.app.inject({
      method: "GET",
      url: "/v1/identity/account-closure",
      headers: { authorization: `Bearer ${t.owner.token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as {
      blockers: Array<{ code: string }>;
      consequences: Array<{ code: string; count: number }>;
    };
    expect(body.blockers).toEqual([]);
    expect(body.consequences).toEqual([expect.objectContaining({ code: "WORKSPACE_MEMBERS_LOSE_ACCESS", count: 2 })]);

    // A solo owner sees no consequence (positive control for the count).
    const solo = await seedPersonalTenant(deps, "TEAM");
    const soloRes = await harness.app.inject({
      method: "GET",
      url: "/v1/identity/account-closure",
      headers: { authorization: `Bearer ${solo.owner.token}` },
    });
    expect((JSON.parse(soloRes.body) as { consequences: unknown[] }).consequences).toEqual([]);

    await accountClosure.executeAccountClosure(t.owner.userId);
    for (const userId of [active.userId, suspended.userId]) {
      expect((await prisma.teamMember.findFirstOrThrow({ where: { teamId: t.personalTeamId, userId } })).status).toBe("REVOKED");
    }
  });

  it("LIFE-11 — an interrupted closure left PROCESSING is resumed by the reaper", async () => {
    const t = await seedPersonalTenant(deps, "PRO");
    const live = await populate(t.personalTeamId, t.owner.userId);
    const req = await prisma.accountClosureRequest.create({
      data: { userId: t.owner.userId, status: "PROCESSING", startedAtUtc: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      select: { id: true },
    });
    const summary = await tick.runLifecycleTick(new Date());
    expect(summary.processors.accountClosures).toBe("ok");
    expect((await prisma.accountClosureRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("COMPLETED");
    await assertSettled(t.personalTeamId, live);
  });

  it("LIFE-12 — a workspace closure revokes pending invitations (they do not revive on reopen)", async () => {
    const t = await seedPersonalTenant(deps, "TEAM");
    const live = await populate(t.personalTeamId, t.owner.userId);
    await workspaceClosure.executeWorkspaceClosure({ teamId: t.personalTeamId, requestedByUserId: t.owner.userId });
    await assertSettled(t.personalTeamId, live);
  });

  it("LIFE-10 — organization closure stamps closedAtUtc on every organization workspace", async () => {
    const org = await seedOrganizationTenant(deps, {});
    await orgClosure.executeOrganizationClosure({ organizationId: org.organizationId, requestedByUserId: org.owner.userId });
    expect((await prisma.team.findUniqueOrThrow({ where: { id: org.workspaceId } })).closedAtUtc).not.toBeNull();
  });

  it("LIFE-16 — Enterprise termination: ACTIVE → TERMINATING → TERMINATED through the canonical closure", async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 2 });
    const live = await populate(org.workspaceId, org.owner.userId);
    const state = async () => {
      const [o, c, open] = await Promise.all([
        prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId }, select: { status: true } }),
        prisma.enterpriseContract.findUniqueOrThrow({ where: { organizationId: org.organizationId }, select: { status: true } }),
        prisma.organizationClosureRequest.findMany({
          where: { organizationId: org.organizationId, status: { in: ["SCHEDULED", "PROCESSING", "BLOCKED", "COOLING_OFF"] } },
          select: { reason: true },
        }),
      ]);
      return termination.resolveOrganizationLifecycleState({
        organizationStatus: o.status,
        contractStatus: c.status,
        openTerminationClosure: open.some((r) => termination.isContractTerminationClosure(r.reason)),
      });
    };
    expect(await state()).toBe("ACTIVE");
    await termination.beginEnterpriseTermination({
      organizationId: org.organizationId,
      actorUserId: org.owner.userId,
      reason: "contract ended",
      effectiveAtUtc: new Date(Date.now() - 1000),
    });
    expect(await state()).toBe("TERMINATING");
    // A second schedule is refused, not duplicated.
    await expect(
      termination.beginEnterpriseTermination({ organizationId: org.organizationId, actorUserId: org.owner.userId, reason: "again" }),
    ).rejects.toMatchObject({ code: "TERMINATION_ALREADY_SCHEDULED" });

    // Members are off-boarded by the termination itself — the self-service
    // "members still active" blocker does not apply to it.
    const summary = await tick.runLifecycleTick(new Date());
    expect(summary.failures).toBe(0);
    expect(await state()).toBe("TERMINATED");
    await assertSettled(org.workspaceId, live);
    expect(
      await prisma.teamMember.count({ where: { teamId: org.workspaceId, status: { in: ["ACTIVE", "SUSPENDED"] } } }),
    ).toBe(0);
  });

  it("LIFE-16 — a scheduled termination can be withdrawn before it executes, without restoring access silently", async () => {
    const org = await seedOrganizationTenant(deps, {});
    await termination.beginEnterpriseTermination({
      organizationId: org.organizationId,
      actorUserId: org.owner.userId,
      reason: "renewal pending",
      effectiveAtUtc: new Date(Date.now() + 7 * 86_400_000),
    });
    await termination.cancelEnterpriseTermination({ organizationId: org.organizationId, actorUserId: org.owner.userId });
    const contract = await prisma.enterpriseContract.findUniqueOrThrow({ where: { organizationId: org.organizationId } });
    expect(contract.status).toBe("SUSPENDED");
    expect((await prisma.team.findUniqueOrThrow({ where: { id: org.workspaceId } })).closedAtUtc).toBeNull();
  });

  it("LIFE-16 — an ACTIVE legal hold holds a termination at TERMINATING; nothing closes", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const live = await populate(org.workspaceId, org.owner.userId);
    await prisma.evidenceLegalHold.create({
      data: {
        teamId: org.workspaceId,
        evidenceId: live.evidenceId,
        scope: "EVIDENCE",
        status: "ACTIVE",
        title: "Litigation hold",
        reason: "pending matter",
        placedByUserId: org.owner.userId,
      } as never,
    });
    await termination.beginEnterpriseTermination({
      organizationId: org.organizationId,
      actorUserId: org.owner.userId,
      reason: "contract ended",
      effectiveAtUtc: new Date(Date.now() - 1000),
    });
    await tick.runLifecycleTick(new Date());
    const req = await prisma.organizationClosureRequest.findFirstOrThrow({
      where: { organizationId: org.organizationId },
      orderBy: { createdAt: "desc" },
    });
    expect(req.status).toBe("BLOCKED");
    expect((await prisma.enterpriseContract.findUniqueOrThrow({ where: { organizationId: org.organizationId } })).status).toBe("SUSPENDED");
    expect((await prisma.team.findUniqueOrThrow({ where: { id: org.workspaceId } })).closedAtUtc).toBeNull();
  });
});
