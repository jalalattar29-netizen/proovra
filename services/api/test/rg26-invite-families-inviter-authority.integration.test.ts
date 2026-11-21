/**
 * NEW-RG-07-4 / NEW-RG-26-3 — owner decision F: the acceptance-time inviter
 * check applies to EVERY invitation family that delegates access, each judged
 * by its own issuing authority. Live PostgreSQL through the real routes.
 *
 * Workspace and organization (member-issued) invitations are proven in
 * rg26-invite-acceptance-inviter-authority.integration.test.ts. This file
 * proves the three families that were open:
 *
 *   - PLATFORM-PROVISIONED ORG_OWNER invitations: the issuing operator holds no
 *     organization membership; their authority is platform administration, and
 *     acceptance now asks whether they still hold it. The authorized resend is
 *     the operator owner-invite reissue.
 *   - COLLABORATION-GROUP invitations (legacy links; the writer is retired): the
 *     inviter must still be an effective group member holding
 *     `team.member.invite`. The re-approval path is the group's own direct add.
 *   - PORTAL (external-review) invitations: the issuer must still hold an
 *     authority that issues one (review.assign at the administrative tier,
 *     governance.exchange.decide, or governance.legal_hold.manage). The
 *     authorized resend (token rotation by an operator) re-authorizes.
 *
 * Each family: inviter still authorized -> accepted; inviter demoted or
 * removed -> refused, nothing granted, invitation left pending; resend or
 * re-approval by an authorized person -> accepted.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps } from "./point7/product-fixtures.js";

describe("NEW-RG-07-4 / NEW-RG-26-3 — every invitation family re-checks its inviter at acceptance (decision F)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let fx: typeof import("./point7/product-fixtures.js");
  let provisioning: typeof import("../src/services/enterprise-provisioning.service.js");
  let collab: typeof import("../src/services/collaboration-team/collaboration-team.service.js");
  let portal: typeof import("../src/services/external-review/portal-invitation.service.js");
  let grants: typeof import("../src/services/external-review/external-review-grant.service.js");
  let deps: FixtureDeps;

  const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const tag = () => randomUUID().slice(0, 8);

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    fx = await import("./point7/product-fixtures.js");
    provisioning = await import("../src/services/enterprise-provisioning.service.js");
    collab = await import("../src/services/collaboration-team/collaboration-team.service.js");
    portal = await import("../src/services/external-review/portal-invitation.service.js");
    grants = await import("../src/services/external-review/external-review-grant.service.js");
    const jwt = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag: `rgfam-${Date.now().toString(36)}`,
      mintToken: (userId: string, email: string) =>
        jwt.signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET as string,
          3600,
        ),
    };
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ---------------------------------------------------------------------------
  // Platform-provisioned ORG_OWNER invitations
  // ---------------------------------------------------------------------------

  async function operator(platformRole: "admin" | null = "admin") {
    return prisma.user.create({
      data: {
        email: `operator-${tag()}@test.proovra.local`,
        provider: "EMAIL",
        providerUserId: `operator-${tag()}`,
        platformRole,
      } as never,
      select: { id: true },
    });
  }

  async function provisioned() {
    const owner = await fx.seedUser(deps, "prov-owner");
    const op = await operator("admin");
    const { result } = await provisioning.provisionEnterpriseCustomerIdempotent(
      {
        organizationName: `Customer ${tag()}`,
        ownerEmail: owner.email,
        seats: 5,
        actorUserId: op.id,
        idempotencyKey: `rgfam-${randomUUID()}`,
      },
      prisma as never,
    );
    const r = result as { organizationId: string; ownerInviteToken: string };
    return { owner, operatorId: op.id, organizationId: r.organizationId, token: r.ownerInviteToken };
  }

  const acceptOrg = (token: string, raw: string) =>
    h.app.inject({ method: "POST", url: "/v1/org-invites/accept", headers: bearer(token), payload: { token: raw } });

  it("platform ORG_OWNER: an operator who still holds platform administration -> the owner accepts", async () => {
    const p = await provisioned();
    const ok = await acceptOrg(p.owner.token, p.token);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(
      await prisma.organizationMembership.findFirstOrThrow({
        where: { organizationId: p.organizationId, userId: p.owner.userId },
        select: { role: true, status: true },
      }),
    ).toEqual({ role: "ORG_OWNER", status: "ACTIVE" });
  });

  it("platform ORG_OWNER: an operator who lost platform administration -> refused, nothing granted, invitation pending; an authorized operator's reissue -> accepted", async () => {
    const p = await provisioned();
    await prisma.user.update({ where: { id: p.operatorId }, data: { platformRole: null } as never });

    const refused = await acceptOrg(p.owner.token, p.token);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: "INVITE_INVITER_AUTHORITY_LOST" } });
    expect(await prisma.organizationMembership.count({ where: { organizationId: p.organizationId } })).toBe(0);
    const pending = await prisma.organizationInvite.findFirstOrThrow({
      where: { organizationId: p.organizationId, role: "ORG_OWNER" },
      select: { acceptedAt: true, revokedAt: true },
    });
    expect(pending).toEqual({ acceptedAt: null, revokedAt: null });
    const audit = await prisma.organizationAuditEvent.findFirst({
      where: { organizationId: p.organizationId, eventType: "ORG_INVITE_ACCEPT_REJECTED" },
      select: { metadata: true },
    });
    expect(audit?.metadata).toMatchObject({ reason: "inviter_authority_lost" });

    // The authorized resend path: another operator who holds the authority reissues.
    const second = await operator("admin");
    const reissued = await provisioning.reissueEnterpriseOwnerInvite(
      { organizationId: p.organizationId, actorUserId: second.id },
      prisma as never,
    );
    const fresh = decodeURIComponent(/\/org-invites\/([^/?#]+)\/accept/.exec(reissued.inviteUrl)![1]!);
    const ok = await acceptOrg(p.owner.token, fresh);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(
      await prisma.organizationMembership.findFirstOrThrow({
        where: { organizationId: p.organizationId, userId: p.owner.userId },
        select: { role: true },
      }),
    ).toEqual({ role: "ORG_OWNER" });
  });

  it("platform ORG_OWNER: a plain user (never a platform operator) as the issuer -> refused", async () => {
    const p = await provisioned();
    const plain = await operator(null);
    await prisma.organizationInvite.updateMany({
      where: { organizationId: p.organizationId, role: "ORG_OWNER" },
      data: { invitedByUserId: plain.id },
    });
    const refused = await acceptOrg(p.owner.token, p.token);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: "INVITE_INVITER_AUTHORITY_LOST" } });
    expect(await prisma.organizationMembership.count({ where: { organizationId: p.organizationId } })).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Collaboration-group invitations (legacy links)
  // ---------------------------------------------------------------------------

  async function group() {
    // Collaboration Teams are a TEAM capability: a personal workspace's plan is
    // its owner's, so the groups live in the personal fixture on TEAM.
    const P = h.fixtures.personal;
    await fx.setAccountPlan(deps, P.userId, "TEAM");
    await prisma.collaborationTeam.updateMany({
      where: { workspaceId: P.teamId, status: "ACTIVE" },
      data: { status: "ARCHIVED", archivedAtUtc: new Date() } as never,
    });
    const inviter = await fx.seedUser(deps, "ct-inviter");
    const invitee = await fx.seedUser(deps, "ct-invitee");
    await prisma.teamMember.createMany({
      data: [
        { teamId: P.teamId, userId: inviter.userId, role: "ADMIN", status: "ACTIVE" },
        { teamId: P.teamId, userId: invitee.userId, role: "MEMBER", status: "ACTIVE" },
      ],
    });
    const g = await collab.createCollaborationTeam({ workspaceId: P.teamId, actorUserId: P.userId, name: `rgfam-${tag()}` });
    // The inviter: a group ADMIN (holds team.member.invite).
    const inviterRow = await prisma.collaborationTeamMember.create({
      data: { teamId: g.id, userId: inviter.userId, role: "ADMIN", status: "ACTIVE" } as never,
      select: { id: true },
    });
    const raw = `rgfam-ct-${randomUUID()}`;
    const invite = await prisma.collaborationTeamInvite.create({
      data: {
        teamId: g.id,
        workspaceId: P.teamId,
        channel: "LINK",
        tokenHash: sha(raw),
        role: "MEMBER",
        expiresAtUtc: new Date(Date.now() + 86_400_000),
        createdByUserId: inviter.userId,
      },
      select: { id: true },
    });
    return { teamId: g.id, inviterRowId: inviterRow.id, raw, inviteId: invite.id, invitee };
  }

  const acceptGroup = (g: { raw: string; invitee: { token: string } }) =>
    h.app.inject({
      method: "POST",
      url: "/v1/collaboration-team-invites/accept",
      headers: bearer(g.invitee.token),
      payload: { token: g.raw },
    });

  const groupMember = (g: { teamId: string; invitee: { userId: string } }) =>
    prisma.collaborationTeamMember.findFirst({
      where: { teamId: g.teamId, userId: g.invitee.userId, status: "ACTIVE" },
      select: { role: true },
    });

  it("collaboration group: an inviter who still holds team.member.invite -> accepted", async () => {
    const g = await group();
    const ok = await acceptGroup(g);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ teamId: g.teamId, alreadyMember: false });
    expect(await groupMember(g)).toEqual({ role: "MEMBER" });
  });

  it("collaboration group: an inviter demoted or removed -> refused, nothing granted, invitation pending; the group's re-approval (a LEAD adds them) -> member", async () => {
    for (const after of [{ role: "MEMBER" }, { status: "REMOVED" }]) {
      const g = await group();
      await prisma.collaborationTeamMember.update({ where: { id: g.inviterRowId }, data: after as never });
      const refused = await acceptGroup(g);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ error: { code: "INVITE_INVITER_AUTHORITY_LOST" } });
      expect(await groupMember(g)).toBeNull();
      expect(
        await prisma.collaborationTeamInvite.findUniqueOrThrow({ where: { id: g.inviteId }, select: { status: true, useCount: true } }),
      ).toEqual({ status: "PENDING", useCount: 0 });

      // Re-approval: the group LEAD (the workspace owner) adds the person directly.
      await collab.addExistingMember({
        teamId: g.teamId,
        actorUserId: h.fixtures.personal.userId,
        userIdToAdd: g.invitee.userId,
        role: "MEMBER",
      });
      expect(await groupMember(g)).toEqual({ role: "MEMBER" });
      // The stale link now answers as "already a member", not as a grant.
      const again = await acceptGroup(g);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toMatchObject({ alreadyMember: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Portal (external-review) invitations
  // ---------------------------------------------------------------------------

  async function portalInvite(invitedByUserId: string) {
    const A = h.fixtures.teamA;
    const issued = await portal.issueInvitation({
      teamId: A.teamId,
      invitedByUserId,
      reviewerEmail: `rgfam-reviewer-${tag()}@test.proovra.local`,
      role: "EXTERNAL_REVIEWER",
      scope: { kind: "EVIDENCE", evidenceId: A.evidenceId },
      expiresAtUtc: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    if (!issued.ok) throw new Error(`invitation refused: ${issued.denial}`);
    return { grantId: issued.grantId, rawToken: issued.rawToken };
  }

  const portalAuth = (token: string) =>
    h.app.inject({ method: "POST", url: "/v1/portal/auth", headers: { "content-type": "application/json" }, payload: { token } });

  const grantRow = (id: string) =>
    prisma.externalReviewGrant.findUniqueOrThrow({ where: { id }, select: { state: true, invitedByUserId: true } });

  async function setAdmin(patch: Record<string, unknown>) {
    const A = h.fixtures.teamA;
    await prisma.teamMember.updateMany({ where: { teamId: A.teamId, userId: A.adminUserId }, data: patch as never });
  }

  it("portal: an issuer who still holds the authority (workspace ADMIN) -> the reviewer's invitation is accepted", async () => {
    const inv = await portalInvite(h.fixtures.teamA.adminUserId);
    const ok = await portalAuth(inv.rawToken);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await grantRow(inv.grantId)).state).toBe("ACTIVE");
  });

  it("portal: an issuer demoted or suspended -> refused, the grant stays INVITED; an authorized operator's resend -> accepted", async () => {
    try {
      for (const after of [{ role: "MEMBER" }, { status: "SUSPENDED" }]) {
        const inv = await portalInvite(h.fixtures.teamA.adminUserId);
        // Written as a bypassing transition (the role-change writer would also
        // end the issuer's grants): the acceptance check is what refuses here.
        await setAdmin(after);
        const refused = await portalAuth(inv.rawToken);
        expect(refused.statusCode, refused.body).toBe(409);
        expect(refused.json()).toMatchObject({ denial: "INVITER_AUTHORITY_LOST" });
        expect(await grantRow(inv.grantId)).toEqual({ state: "INVITED", invitedByUserId: h.fixtures.teamA.adminUserId });
        // The legacy path-token acceptance is refused by the same state machine.
        const legacy = await h.app.inject({ method: "POST", url: `/v1/external-review/access/${inv.rawToken}` });
        expect(legacy.statusCode, legacy.body).toBe(401);
        expect((await grantRow(inv.grantId)).state).toBe("INVITED");

        // The authorized resend (every resend path rotates the token through
        // this one function, after re-proving the operator's authority).
        const rotated = await grants.rotateExternalReviewGrantToken({
          grantId: inv.grantId,
          teamId: h.fixtures.teamA.teamId,
          actorUserId: h.fixtures.teamA.ownerUserId,
          reason: "Operator resent the external-reviewer invitation email.",
        });
        if (!rotated.ok) throw new Error(`rotation refused: ${rotated.reason}`);
        expect((await grantRow(inv.grantId)).invitedByUserId).toBe(h.fixtures.teamA.ownerUserId);
        const ok = await portalAuth(rotated.rawToken);
        expect(ok.statusCode, ok.body).toBe(200);
        expect((await grantRow(inv.grantId)).state).toBe("ACTIVE");
        await setAdmin({ role: "ADMIN", status: "ACTIVE" });
      }
    } finally {
      await setAdmin({ role: "ADMIN", status: "ACTIVE" });
    }
  });

  it("portal: a workspace MEMBER as the issuer (no issuing authority) -> refused", async () => {
    const inv = await portalInvite(h.fixtures.teamA.adminUserId);
    await prisma.externalReviewGrant.update({
      where: { id: inv.grantId },
      data: { invitedByUserId: h.fixtures.teamA.memberUserId },
    });
    const refused = await portalAuth(inv.rawToken);
    expect(refused.statusCode, refused.body).toBe(409);
    expect((await grantRow(inv.grantId)).state).toBe("INVITED");
  });

  // Review follow-up: each grant kind answers to the permission that issues it.
  async function capability(userId: string, permission: string) {
    const A = h.fixtures.teamA;
    const tm = await prisma.teamMember.findFirstOrThrow({ where: { teamId: A.teamId, userId }, select: { id: true } });
    await prisma.memberCapabilityGrant.create({
      data: { teamMemberId: tm.id, teamId: A.teamId, permission, grantedByUserId: A.ownerUserId, reason: "rg26 test" },
    });
    return tm.id;
  }

  it("portal: a demoted issuer who keeps governance.legal_hold.manage cannot validate a PORTAL invitation (that permission issues only plain grants)", async () => {
    try {
      const inv = await portalInvite(h.fixtures.teamA.adminUserId);
      await setAdmin({ role: "MEMBER" });
      const tmId = await capability(h.fixtures.teamA.adminUserId, "governance.legal_hold.manage");
      try {
        const refused = await portalAuth(inv.rawToken);
        expect(refused.statusCode, refused.body).toBe(409);
        expect(refused.json()).toMatchObject({ denial: "INVITER_AUTHORITY_LOST" });
        expect((await grantRow(inv.grantId)).state).toBe("INVITED");
      } finally {
        await prisma.memberCapabilityGrant.deleteMany({ where: { teamMemberId: tmId } });
      }
    } finally {
      await setAdmin({ role: "ADMIN", status: "ACTIVE" });
    }
  });

  it("plain grant: an issuer who holds governance.legal_hold.manage -> accepted; one who does not -> refused", async () => {
    const A = h.fixtures.teamA;
    const plain = async () => {
      const issued = await grants.issueExternalReviewGrant({
        teamId: A.teamId,
        invitedByUserId: A.ownerUserId,
        scopeKind: "EVIDENCE",
        evidenceId: A.evidenceId,
        reviewerEmail: `rgfam-plain-${tag()}@test.proovra.local`,
        expiresAtUtc: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      } as never);
      if (!issued.ok) throw new Error(`grant refused: ${issued.reason}`);
      // The issuer of record becomes a plain MEMBER (no issuing role).
      await prisma.externalReviewGrant.update({ where: { id: issued.grant.id }, data: { invitedByUserId: A.memberUserId } });
      return issued;
    };
    const access = (token: string) => h.app.inject({ method: "POST", url: `/v1/external-review/access/${token}` });

    const without = await plain();
    const refused = await access(without.rawToken);
    expect(refused.statusCode, refused.body).toBe(401);
    expect((await grantRow(without.grant.id)).state).toBe("INVITED");

    const tmId = await capability(A.memberUserId, "governance.legal_hold.manage");
    try {
      const withIt = await plain();
      const ok = await access(withIt.rawToken);
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await grantRow(withIt.grant.id)).state).toBe("ACTIVE");
    } finally {
      await prisma.memberCapabilityGrant.deleteMany({ where: { teamMemberId: tmId } });
    }
  });
});
