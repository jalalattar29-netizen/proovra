/**
 * WS-WSP — workspace lifecycle (RG-26) and collaboration (RG-31) regressions.
 *
 * Each case drives the real routes and services against a real PostgreSQL
 * (testcontainers). The only seam replaced is the email provider, so no
 * notice leaves this machine. Every case was written to fail at the base
 * (cdcb8aef8) for the behaviour named in its title.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

vi.mock("../src/services/notifications/resend-provider.js", () => ({
  sendViaResend: async (input: { deliveryId: string }) => ({ ok: true, providerMessageId: `fake-${input.deliveryId}` }),
}));

type Prisma = import("@prisma/client").PrismaClient;
type Person = { id: string; email: string; token: string; memberId: string | null };

describe("WS-WSP — lifecycle and collaboration regressions (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let hashPassword: typeof import("../src/services/email-password-auth.service.js").hashPassword;
  let legalVersions: Record<string, string>;
  let ct: typeof import("../src/services/collaboration-team/collaboration-team.service.js");
  let completion: typeof import("../src/services/collaboration-team/collaboration-completion.service.js");
  let closure: typeof import("../src/services/workspace/workspace-closure.service.js");
  let preflight: typeof import("../src/services/identity/account-lifecycle-preflight.service.js");
  let provisioning: typeof import("../src/services/identity/membership-provisioning.service.js");
  let admin: typeof import("../src/services/workspace-admin/workspace-admin.service.js");
  let orgClosure: typeof import("../src/services/organization/org-closure.service.js");
  let guards: typeof import("../src/services/collaboration-team/billing-guards.js");
  const P = () => h.fixtures.personal;
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    ({ signJwt } = await import("../src/services/jwt.js"));
    ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
    legalVersions = (await import("../src/legal/legal-versioning.js")).REQUIRED_LEGAL_VERSIONS as Record<string, string>;
    ct = await import("../src/services/collaboration-team/collaboration-team.service.js");
    completion = await import("../src/services/collaboration-team/collaboration-completion.service.js");
    closure = await import("../src/services/workspace/workspace-closure.service.js");
    preflight = await import("../src/services/identity/account-lifecycle-preflight.service.js");
    provisioning = await import("../src/services/identity/membership-provisioning.service.js");
    admin = await import("../src/services/workspace-admin/workspace-admin.service.js");
    orgClosure = await import("../src/services/organization/org-closure.service.js");
    guards = await import("../src/services/collaboration-team/billing-guards.js");
    // Team tasks are a TEAM capability: the personal workspace's plan is its owner's.
    await prisma.entitlement.updateMany({ where: { userId: P().userId }, data: { active: false } });
    await prisma.entitlement.create({ data: { userId: P().userId, plan: "TEAM", active: true, credits: 0 } });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string, workspaceId?: string) => ({
    authorization: `Bearer ${token}`,
    ...(workspaceId ? { "x-proovra-workspace-id": workspaceId } : {}),
  });
  const code = (res: { json: () => unknown }) => {
    const b = res.json() as { error?: { code?: string }; code?: string };
    return b.error?.code ?? b.code;
  };

  async function person(
    teamId: string | null,
    role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | null,
    opts: { verified?: boolean; displayName?: string } = {},
  ): Promise<Person> {
    const email = `wsp-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: {
        email,
        firstName: "Wsp",
        lastName: "Person",
        displayName: opts.displayName ?? null,
        provider: "EMAIL",
        providerUserId: email,
        ...(opts.verified ? { emailVerifiedAt: new Date() } : {}),
      } as never,
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(legalVersions).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion,
        source: "integration-harness",
      })),
    });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    const membership =
      teamId && role ? await prisma.teamMember.create({ data: { teamId, userId: user.id, role, status: "ACTIVE" } }) : null;
    return { id: user.id, email, token, memberId: membership?.id ?? null };
  }

  async function ownedWorkspace() {
    const owner = await person(null, null);
    const org = await prisma.organization.create({
      data: { name: `Wsp container ${tag()}`, billingOwnerUserId: owner.id, status: "ACTIVE", kind: "SYSTEM" } as never,
      select: { id: true },
    });
    const team = await prisma.team.create({
      data: {
        name: `Wsp owned ${tag()}`,
        ownerUserId: owner.id,
        billingOwnerUserId: owner.id,
        isPersonal: false,
        organizationId: org.id,
        workspaceKind: "OWNED",
      } as never,
      select: { id: true, organizationId: true },
    });
    const ownerRow = await prisma.teamMember.create({
      data: { teamId: team.id, userId: owner.id, role: "OWNER", status: "ACTIVE" },
    });
    return { teamId: team.id, organizationId: team.organizationId as string, owner: { ...owner, memberId: ownerRow.id } };
  }

  async function withPassword(userId: string): Promise<string> {
    const password = `Wsp-${randomUUID()}`;
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(password) } });
    return password;
  }

  async function evidenceIn(teamId: string, ownerUserId: string, opts: { deleted?: boolean } = {}) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: {
          title: `Wsp ${tag()}`,
          type: "PHOTO",
          status: "CREATED",
          teamId,
          organizationId: team.organizationId,
          ownerUserId,
          ...(opts.deleted ? { deletedAt: new Date() } : {}),
        } as never,
        select: { id: true },
      })
    ).id;
  }

  // ===========================================================================
  // RG-31 — collaboration
  // ===========================================================================

  async function groupInPersonal() {
    await prisma.collaborationTeam.updateMany({
      where: { workspaceId: P().teamId, status: "ACTIVE" },
      data: { status: "ARCHIVED", archivedAtUtc: new Date() },
    });
    const { id } = await ct.createCollaborationTeam({ workspaceId: P().teamId, actorUserId: P().userId, name: `Wsp ${tag()}` });
    return id;
  }

  it("PRO-K2-01 — an assignee starts their own task through the ROUTE; the due date is kept, no DUE_CHANGED event", async () => {
    const teamId = await groupInPersonal();
    const a = await person(P().teamId, "MEMBER");
    await ct.addExistingMember({ teamId, actorUserId: P().userId, userIdToAdd: a.id, role: "MEMBER" });
    const caseRow = await prisma.case.create({
      data: { name: `Wsp case ${tag()}`, teamId: P().teamId, ownerUserId: P().userId },
      select: { id: true },
    });
    const due = new Date(Date.now() + 3 * 86_400_000);
    const { id } = await ct.createAssignment({
      teamId,
      actorUserId: P().userId,
      targetType: "CASE",
      targetId: caseRow.id,
      assigneeUserId: a.id,
      dueAtUtc: due,
    });
    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/collaboration-teams/${teamId}/assignments/${id}`,
      headers: bearer(a.token, P().teamId),
      payload: { status: "IN_PROGRESS" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = await prisma.collaborationTeamAssignment.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("IN_PROGRESS");
    expect(row.dueAtUtc?.toISOString()).toBe(due.toISOString());
    expect(
      await prisma.collaborationTeamActivity.count({ where: { teamId, eventType: "ASSIGNMENT_DUE_CHANGED", targetId: id } }),
    ).toBe(0);
  });

  it("PRO-K2-03 — a heartbeat for an id that names no row of the workspace is refused; a real record works", async () => {
    const random = await h.app.inject({
      method: "POST",
      url: "/v1/me/presence/heartbeat",
      headers: bearer(P().token),
      payload: { teamId: P().teamId, resourceKind: "evidence", resourceId: randomUUID() },
    });
    expect(random.statusCode, random.body).toBe(404);
    const freeForm = await h.app.inject({
      method: "POST",
      url: "/v1/me/presence/heartbeat",
      headers: bearer(P().token),
      payload: { teamId: P().teamId, resourceKind: "evidence", resourceId: "x".repeat(150) },
    });
    expect(freeForm.statusCode).not.toBe(200);
    const real = await h.app.inject({
      method: "POST",
      url: "/v1/me/presence/heartbeat",
      headers: bearer(P().token),
      payload: { teamId: P().teamId, resourceKind: "evidence", resourceId: P().evidenceId },
    });
    expect(real.statusCode, real.body).toBe(200);
  });

  it("PRO-K2-04 — a display-name @mention resolves and notifies; an unknown handle is reported", async () => {
    const teamId = await groupInPersonal();
    const jane = await person(P().teamId, "MEMBER", { displayName: "Jane Doe" });
    await ct.addExistingMember({ teamId, actorUserId: P().userId, userIdToAdd: jane.id, role: "MEMBER" });
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/collaboration-teams/${teamId}/comments`,
      headers: bearer(P().token, P().teamId),
      payload: { targetType: "TEAM", body: "ping @jane.doe and @nobody.here" },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as { unresolvedMentions?: string[] }).unresolvedMentions).toEqual(["nobody.here"]);
    expect(
      await prisma.collaborationTeamCommentMention.count({ where: { teamId, mentionedUserId: jane.id } }),
    ).toBe(1);
  });

  it("M771 — a named @mention of a SUSPENDED workspace member (group row still ACTIVE) creates no mention", async () => {
    const teamId = await groupInPersonal();
    const sam = await person(P().teamId, "MEMBER", { displayName: "Sam Suspended" });
    const kim = await person(P().teamId, "MEMBER", { displayName: "Kim Active" });
    await ct.addExistingMember({ teamId, actorUserId: P().userId, userIdToAdd: sam.id, role: "MEMBER" });
    await ct.addExistingMember({ teamId, actorUserId: P().userId, userIdToAdd: kim.id, role: "MEMBER" });
    // The workspace membership is suspended; the group row stays ACTIVE (as rbac suspension leaves it).
    await prisma.teamMember.update({ where: { id: sam.memberId as string }, data: { status: "SUSPENDED" } });
    expect(
      (await prisma.collaborationTeamMember.findFirstOrThrow({ where: { teamId, userId: sam.id } })).status,
    ).toBe("ACTIVE");
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/collaboration-teams/${teamId}/comments`,
      headers: bearer(P().token, P().teamId),
      payload: { targetType: "TEAM", body: "ping @sam.suspended and @kim.active" },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as { unresolvedMentions?: string[] }).unresolvedMentions).toEqual(["sam.suspended"]);
    expect(await prisma.collaborationTeamCommentMention.count({ where: { teamId, mentionedUserId: sam.id } })).toBe(0);
    expect(await prisma.collaborationTeamCommentMention.count({ where: { teamId, mentionedUserId: kim.id } })).toBe(1);
  });

  it("PRO-K2-06 — a removed group member's Teams list no longer carries the team", async () => {
    const teamId = await groupInPersonal();
    const m = await person(P().teamId, "MEMBER");
    const { id: memberId } = await ct.addExistingMember({
      teamId,
      actorUserId: P().userId,
      userIdToAdd: m.id,
      role: "MEMBER",
    });
    await ct.removeMember({ teamId, actorUserId: P().userId, memberId });
    const list = await ct.listCollaborationTeams({ workspaceId: P().teamId, actorUserId: m.id });
    expect(list.teams.map((t: { id: string }) => t.id)).not.toContain(teamId);
  });

  it("PRO-K2-14 — replaying an ACCEPTED legacy link after expiry leaves it ACCEPTED", async () => {
    const teamId = await groupInPersonal();
    const raw = `ctinv_${randomUUID()}`;
    const invite = await prisma.collaborationTeamInvite.create({
      data: {
        teamId,
        workspaceId: P().teamId,
        channel: "EMAIL",
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        expiresAtUtc: new Date(Date.now() - 86_400_000),
        createdByUserId: P().userId,
        status: "ACCEPTED",
        useCount: 1,
        maxUses: 1,
      } as never,
      select: { id: true },
    });
    const replayer = await person(P().teamId, "MEMBER");
    await expect(ct.acceptInvite({ rawToken: raw, actorUserId: replayer.id })).rejects.toMatchObject({
      code: "INVITE_ALREADY_USED",
    });
    expect((await prisma.collaborationTeamInvite.findUniqueOrThrow({ where: { id: invite.id } })).status).toBe("ACCEPTED");
  });

  it("PRO-K2-16 — team comments page past the first 50 with a cursor", async () => {
    const teamId = await groupInPersonal();
    const team = await prisma.collaborationTeam.findUniqueOrThrow({ where: { id: teamId }, select: { workspaceId: true } });
    const base = Date.now() - 100_000;
    await prisma.collaborationTeamComment.createMany({
      data: Array.from({ length: 55 }, (_, i) => ({
        teamId,
        workspaceId: team.workspaceId,
        authorUserId: P().userId,
        targetType: "TEAM",
        body: `c${i}`,
        status: "ACTIVE",
        createdAt: new Date(base + i * 1000),
      })) as never,
    });
    const first = await completion.listComments({ teamId, actorUserId: P().userId });
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    const second = await completion.listComments({ teamId, actorUserId: P().userId, cursor: first.nextCursor });
    expect(second.items.map((c: { body: string }) => c.body)).toEqual(["c4", "c3", "c2", "c1", "c0"]);
    expect(second.nextCursor).toBeNull();
  });

  it("PRO-K2-11 — the workspace owner may archive a group a member created and leads", async () => {
    const teamId = await groupInPersonal();
    const m = await person(P().teamId, "MEMBER");
    await ct.addExistingMember({ teamId, actorUserId: P().userId, userIdToAdd: m.id, role: "MEMBER" });
    // The member is the only LEAD; the owner holds no group role at all.
    await prisma.collaborationTeamMember.updateMany({ where: { teamId, userId: m.id }, data: { role: "LEAD" } });
    await prisma.collaborationTeamMember.deleteMany({ where: { teamId, userId: P().userId } });
    const result = await ct.archiveCollaborationTeam({ teamId, actorUserId: P().userId });
    expect(result.changed).toBe(true);
    // ...and nobody else gains it: a plain member of the workspace is refused.
    const teamId2 = await groupInPersonal();
    const other = await person(P().teamId, "MEMBER");
    await expect(ct.archiveCollaborationTeam({ teamId: teamId2, actorUserId: other.id })).rejects.toBeTruthy();
  });

  // ===========================================================================
  // RG-26 — workspace lifecycle
  // ===========================================================================

  it("PRO-T1-01 / PRO-T1-11 — the owner of a CLOSED workspace can read its closure, find it, and reopen it once", async () => {
    const w = await ownedWorkspace();
    const exAdmin = await person(w.teamId, "ADMIN");
    await closure.executeWorkspaceClosure({ teamId: w.teamId, requestedByUserId: w.owner.id });
    await prisma.workspaceClosureRequest.create({
      data: { teamId: w.teamId, requestedByUserId: w.owner.id, status: "COMPLETED", completedAtUtc: new Date() },
    });

    const read = await h.app.inject({ method: "GET", url: `/v1/teams/${w.teamId}/closure`, headers: bearer(w.owner.token) });
    expect(read.statusCode, read.body).toBe(200);
    expect((read.json() as { workspaceClosed?: boolean }).workspaceClosed).toBe(true);

    const list = await h.app.inject({ method: "GET", url: "/v1/teams", headers: bearer(w.owner.token) });
    expect((list.json() as { closedOwned?: Array<{ id: string }> }).closedOwned?.map((r) => r.id)).toContain(w.teamId);

    const other = await h.app.inject({ method: "GET", url: `/v1/teams/${w.teamId}/closure`, headers: bearer(exAdmin.token) });
    expect(other.statusCode).toBe(403);

    const reopen = () => h.app.inject({ method: "POST", url: `/v1/teams/${w.teamId}/reopen`, headers: bearer(w.owner.token), payload: {} });
    expect((await reopen()).statusCode).toBe(200);
    const again = await reopen();
    expect(again.statusCode, again.body).toBe(409);
    expect(code(again)).toBe("workspace_not_closed");
    expect(
      await prisma.adminAuditLog.count({ where: { action: "identity.workspace_reopened", workspaceId: w.teamId } }),
    ).toBe(1);
  });

  it("PRO-T1-03 — removal-impact counts trashed evidence exactly as the removal does", async () => {
    const w = await ownedWorkspace();
    const m = await person(w.teamId, "MEMBER");
    await evidenceIn(w.teamId, m.id, { deleted: true });
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/teams/${w.teamId}/members/${m.memberId}/removal-impact`,
      headers: bearer(w.owner.token),
    });
    expect(res.statusCode, res.body).toBe(200);
    const impact = (res.json() as { impact: { ownedEvidence: number; requiresTransfer: boolean } }).impact;
    expect(impact.ownedEvidence).toBe(1);
    expect(impact.requiresTransfer).toBe(true);
  });

  it("PRO-T1-04 — an ADMIN cannot mint another ADMIN by invitation", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/teams/${A().teamId}/invites`,
      headers: bearer(A().adminToken),
      payload: { email: `wsp-admin-${tag()}@test.proovra.local`, role: "ADMIN" },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(code(res)).toBe("role_above_inviter_authority");
  });

  it("PRO-T1-15 — an ADMIN's pending invitations end when that ADMIN is demoted", async () => {
    const w = await ownedWorkspace();
    const adm = await person(w.teamId, "ADMIN");
    const invite = await prisma.teamInvite.create({
      data: {
        teamId: w.teamId,
        email: `wsp-inv-${tag()}@test.proovra.local`,
        role: "MEMBER",
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        invitedByUserId: adm.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      select: { id: true },
    });
    await provisioning.changeMemberRole({
      teamId: w.teamId,
      teamMemberId: adm.memberId!,
      actorUserId: w.owner.id,
      newRole: "MEMBER",
    } as never);
    expect((await prisma.teamInvite.findUniqueOrThrow({ where: { id: invite.id } })).revokedAt).not.toBeNull();
  });

  it("PRO-T1-18 — a member who still owns records cannot leave without handing them over", async () => {
    const w = await ownedWorkspace();
    const m = await person(w.teamId, "MEMBER");
    await evidenceIn(w.teamId, m.id);
    const res = await h.app.inject({ method: "POST", url: `/v1/teams/${w.teamId}/leave`, headers: bearer(m.token), payload: {} });
    expect(res.statusCode, res.body).toBe(409);
    expect(code(res)).toBe("OWNED_RECORDS_HANDOVER_REQUIRED");
    expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: m.memberId! } })).status).toBe("ACTIVE");
  });

  it("PRO-T1-06 — ownership is offered; nothing moves until the recipient accepts with step-up", async () => {
    const w = await ownedWorkspace();
    const heir = await person(w.teamId, "MEMBER");
    const pw = await withPassword(w.owner.id);
    const offered = await h.app.inject({
      method: "POST",
      url: `/v1/teams/${w.teamId}/transfer-ownership`,
      headers: bearer(w.owner.token),
      payload: { newOwnerUserId: heir.id, stepUp: { method: "password", currentPassword: pw } },
    });
    expect(offered.statusCode, offered.body).toBe(202);
    expect((await prisma.team.findUniqueOrThrow({ where: { id: w.teamId } })).ownerUserId).toBe(w.owner.id);
    const offerId = (offered.json() as { offer: { id: string } }).offer.id;

    // Someone else cannot accept it.
    const stranger = await person(w.teamId, "MEMBER");
    const wrong = await h.app.inject({
      method: "POST",
      url: `/v1/teams/${w.teamId}/ownership-offer/${offerId}/accept`,
      headers: bearer(stranger.token),
      payload: {},
    });
    expect(wrong.statusCode).toBe(404);

    const heirPw = await withPassword(heir.id);
    const accepted = await h.app.inject({
      method: "POST",
      url: `/v1/teams/${w.teamId}/ownership-offer/${offerId}/accept`,
      headers: bearer(heir.token),
      payload: { stepUp: { method: "password", currentPassword: heirPw } },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const team = await prisma.team.findUniqueOrThrow({ where: { id: w.teamId } });
    expect(team.ownerUserId).toBe(heir.id);
    expect(team.billingOwnerUserId).toBe(heir.id);
  });

  it("PRO-T1-06 (matrix review Task B) — the pending offer is read only by its two parties; only the recipient declines, only the owner cancels", async () => {
    const offerTo = async () => {
      const w = await ownedWorkspace();
      const heir = await person(w.teamId, "MEMBER");
      const pw = await withPassword(w.owner.id);
      const offered = await h.app.inject({
        method: "POST",
        url: `/v1/teams/${w.teamId}/transfer-ownership`,
        headers: bearer(w.owner.token),
        payload: { newOwnerUserId: heir.id, stepUp: { method: "password", currentPassword: pw } },
      });
      expect(offered.statusCode, offered.body).toBe(202);
      return { w, heir, offerId: (offered.json() as { offer: { id: string } }).offer.id };
    };
    const read = (teamId: string, token: string) =>
      h.app.inject({ method: "GET", url: `/v1/teams/${teamId}/ownership-offer`, headers: bearer(token) });
    const settle = (teamId: string, offerId: string, suffix: "decline" | "cancel", token: string) =>
      h.app.inject({ method: "POST", url: `/v1/teams/${teamId}/ownership-offer/${offerId}/${suffix}`, headers: bearer(token), payload: {} });
    const status = async (offerId: string) =>
      (await prisma.workspaceOwnershipOffer.findUniqueOrThrow({ where: { id: offerId }, select: { status: true } })).status;

    const { w, heir, offerId } = await offerTo();
    const stranger = await person(w.teamId, "ADMIN");
    for (const token of [w.owner.token, heir.token]) {
      const r = await read(w.teamId, token);
      expect(r.statusCode, r.body).toBe(200);
      expect((r.json() as { offer: { id: string } | null }).offer?.id).toBe(offerId);
    }
    const hidden = await read(w.teamId, stranger.token);
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect((hidden.json() as { offer: unknown }).offer).toBeNull();

    // Decline: the owner and a third member are refused; the recipient declines.
    for (const token of [w.owner.token, stranger.token]) {
      const refused = await settle(w.teamId, offerId, "decline", token);
      expect(refused.statusCode, refused.body).toBe(404);
    }
    expect(await status(offerId)).toBe("PENDING");
    const declined = await settle(w.teamId, offerId, "decline", heir.token);
    expect(declined.statusCode, declined.body).toBe(200);
    expect(await status(offerId)).toBe("DECLINED");

    // Cancel: the recipient and a third member are refused; the owner cancels.
    const second = await offerTo();
    const outsider = await person(second.w.teamId, "ADMIN");
    for (const token of [second.heir.token, outsider.token]) {
      const refused = await settle(second.w.teamId, second.offerId, "cancel", token);
      expect(refused.statusCode, refused.body).toBe(404);
    }
    expect(await status(second.offerId)).toBe("PENDING");
    const cancelled = await settle(second.w.teamId, second.offerId, "cancel", second.w.owner.token);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(await status(second.offerId)).toBe("CANCELLED");
    expect((await prisma.team.findUniqueOrThrow({ where: { id: second.w.teamId } })).ownerUserId).toBe(second.w.owner.id);
  });

  it("PRO-T1-14 — the invitee declines with the token; another account cannot", async () => {
    const w = await ownedWorkspace();
    const invitee = await person(null, null, { verified: true });
    const raw = `wsit_v1_${randomUUID()}`;
    const invite = await prisma.teamInvite.create({
      data: {
        teamId: w.teamId,
        email: invitee.email,
        role: "MEMBER",
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        invitedByUserId: w.owner.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      select: { id: true },
    });
    const other = await person(null, null, { verified: true });
    const refused = await h.app.inject({
      method: "POST",
      url: "/v1/teams/invites/decline",
      headers: bearer(other.token),
      payload: { token: raw },
    });
    expect(refused.statusCode).toBe(403);
    const declined = await h.app.inject({
      method: "POST",
      url: "/v1/teams/invites/decline",
      headers: bearer(invitee.token),
      payload: { token: raw },
    });
    expect(declined.statusCode, declined.body).toBe(200);
    const row = await prisma.teamInvite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedByUserId).toBe(invitee.id);
  });

  it("PRO-T1-09 — access review counts only ACTIVE members as internal and labels status", async () => {
    const w = await ownedWorkspace();
    const gone = await person(w.teamId, "MEMBER");
    await prisma.teamMember.update({ where: { id: gone.memberId! }, data: { status: "REVOKED", revokedAtUtc: new Date() } });
    const res = await h.app.inject({ method: "GET", url: `/v1/teams/${w.teamId}/access-review`, headers: bearer(w.owner.token) });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { summary: { internalMembers: number }; members: Array<{ userId: string; status?: string }> };
    expect(body.summary.internalMembers).toBe(1);
    expect(body.members.find((m) => m.userId === gone.id)?.status).toBe("REVOKED");
  });

  it("PRO-T1C-01 — a revoked invitation is neither listed nor counted as pending in workspace administration", async () => {
    const w = await ownedWorkspace();
    await prisma.teamInvite.create({
      data: {
        teamId: w.teamId,
        email: `wsp-rev-${tag()}@test.proovra.local`,
        role: "MEMBER",
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        invitedByUserId: w.owner.id,
        expiresAt: new Date(Date.now() + 86_400_000),
        revokedAt: new Date(),
      },
    });
    const env = (await admin.buildWorkspaceAdmin({
      teamId: w.teamId,
      userId: w.owner.id,
      role: "OWNER",
      canSeeContact: true,
    })) as { workspace: { pendingInviteCount: number } };
    expect(env.workspace.pendingInviteCount).toBe(0);
  });

  it("PRO-T1C-06 — a destruction review UNDER_REVIEW blocks workspace closure", async () => {
    const w = await ownedWorkspace();
    const evidenceId = await evidenceIn(w.teamId, w.owner.id);
    await prisma.destructionReview.create({
      data: { teamId: w.teamId, evidenceId, reason: "retention", status: "UNDER_REVIEW" } as never,
    });
    const { blockers } = await preflight.evaluateWorkspaceClosurePreflight(w.teamId);
    expect(blockers.map((b) => b.code)).toContain("DESTRUCTION_REVIEW_PENDING");
  });

  it("PRO-PSZ-01 — a hold placed after the processor's preflight stops the closure inside its transaction", async () => {
    const w = await ownedWorkspace();
    expect((await preflight.evaluateWorkspaceClosurePreflight(w.teamId)).blockers).toHaveLength(0);
    // The hold lands between the preflight above and the closure transaction.
    await prisma.evidenceLegalHold.create({
      data: { teamId: w.teamId, scope: "WORKSPACE", title: "Late hold", placedByUserId: w.owner.id, status: "ACTIVE" } as never,
    });
    await expect(
      closure.executeWorkspaceClosure({ teamId: w.teamId, requestedByUserId: w.owner.id, rejudgeInTransaction: true }),
    ).rejects.toBeInstanceOf(closure.WorkspaceClosureBlockedError);
    expect((await prisma.team.findUniqueOrThrow({ where: { id: w.teamId } })).closedAtUtc).toBeNull();
    expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: w.owner.memberId } })).status).toBe("ACTIVE");
  });

  it("PRO-PSZ-01 — an ORGANIZATION closure re-judges inside its transaction: a late hold closes nothing", async () => {
    const w = await ownedWorkspace();
    // What the processor's preflight saw: nothing in the way.
    expect((await preflight.evaluateOrganizationClosurePreflight(w.organizationId, w.owner.id)).blockers).toHaveLength(0);
    await prisma.evidenceLegalHold.create({
      data: { teamId: w.teamId, scope: "WORKSPACE", title: "Late hold", placedByUserId: w.owner.id, status: "ACTIVE" } as never,
    });
    const refused = await orgClosure
      .executeOrganizationClosure({
        organizationId: w.organizationId,
        requestedByUserId: w.owner.id,
        rejudgeInTransaction: (all) => all,
      })
      .then(() => null, (err: unknown) => err);
    expect(refused).toBeInstanceOf(orgClosure.OrganizationClosureBlockedError);
    expect((refused as InstanceType<typeof orgClosure.OrganizationClosureBlockedError>).blockers.map((b) => b.code)).toEqual([
      "LEGAL_HOLD_ACTIVE",
    ]);
    // Nothing of the closure committed.
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: w.organizationId } })).status).toBe("ACTIVE");
    expect((await prisma.team.findUniqueOrThrow({ where: { id: w.teamId } })).closedAtUtc).toBeNull();
    expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: w.owner.memberId } })).status).toBe("ACTIVE");
  });

  // LAST: it lapses the personal fixture workspace (restored in `finally`).
  it("PRO-K2-12 — a lapsed workspace can still settle tasks and offboard members; growth stays refused", async () => {
    const teamId = await groupInPersonal();
    const a = await person(P().teamId, "MEMBER");
    const b = await person(P().teamId, "MEMBER");
    await ct.addExistingMember({ teamId, actorUserId: P().userId, userIdToAdd: a.id, role: "MEMBER" });
    await ct.addExistingMember({ teamId, actorUserId: P().userId, userIdToAdd: b.id, role: "MEMBER" });
    const caseRow = await prisma.case.create({
      data: { name: `Wsp case ${tag()}`, teamId: P().teamId, ownerUserId: P().userId },
      select: { id: true },
    });
    const task = async () =>
      (await ct.createAssignment({ teamId, actorUserId: P().userId, targetType: "CASE", targetId: caseRow.id, assigneeUserId: a.id })).id;
    const settled = await task();
    const edited = await task();
    const memberOf = async (userId: string) =>
      (await prisma.collaborationTeamMember.findFirstOrThrow({ where: { teamId, userId }, select: { id: true } })).id;

    // The lapse is a real cancelled subscription, read by the one canonical reader.
    const past = new Date(Date.now() - 60 * 86_400_000);
    const providerSubId = `k212-${tag()}`;
    const before = await prisma.subscription.findMany({ where: { teamId: P().teamId } });
    await prisma.subscription.deleteMany({ where: { teamId: P().teamId } });
    await prisma.subscription.create({
      data: {
        userId: P().userId,
        teamId: P().teamId,
        provider: "STRIPE",
        providerSubId,
        status: "CANCELED",
        plan: "TEAM",
        canceledAtUtc: past,
        currentPeriodEnd: past,
      },
    });
    try {
      const lapsed = await guards
        .assertSubscriptionActiveOrGraceAllowed({ workspaceId: P().teamId })
        .then(() => null, (err: { code?: string }) => err.code);
      expect(lapsed).toBe("SUBSCRIPTION_INACTIVE");
      const owner = bearer(P().token, P().teamId);
      const patch = (url: string, payload: Record<string, unknown>) => h.app.inject({ method: "PATCH", url, headers: owner, payload });

      // Reductions and settlements pass the gate.
      const complete = await patch(`/v1/collaboration-teams/${teamId}/assignments/${settled}`, { status: "COMPLETED" });
      expect(complete.statusCode, complete.body).toBe(200);
      expect((await prisma.collaborationTeamAssignment.findUniqueOrThrow({ where: { id: settled } })).status).toBe("COMPLETED");
      const suspend = await patch(`/v1/collaboration-teams/${teamId}/members/${await memberOf(a.id)}`, { status: "SUSPENDED" });
      expect(suspend.statusCode, suspend.body).toBe(200);
      expect((await prisma.collaborationTeamMember.findFirstOrThrow({ where: { teamId, userId: a.id } })).status).toBe("SUSPENDED");

      // Growth and edits stay behind it, and write nothing.
      const reprioritise = await patch(`/v1/collaboration-teams/${teamId}/assignments/${edited}`, { priority: "URGENT" });
      expect(code(reprioritise), reprioritise.body).toBe("SUBSCRIPTION_INACTIVE");
      expect((await prisma.collaborationTeamAssignment.findUniqueOrThrow({ where: { id: edited } })).priority).not.toBe("URGENT");
      const promote = await patch(`/v1/collaboration-teams/${teamId}/members/${await memberOf(b.id)}`, { role: "ADMIN" });
      expect(code(promote), promote.body).toBe("SUBSCRIPTION_INACTIVE");
      expect((await prisma.collaborationTeamMember.findFirstOrThrow({ where: { teamId, userId: b.id } })).role).toBe("MEMBER");
      const reinstate = await patch(`/v1/collaboration-teams/${teamId}/members/${await memberOf(a.id)}`, { status: "ACTIVE" });
      expect(code(reinstate), reinstate.body).toBe("SUBSCRIPTION_INACTIVE");
    } finally {
      await prisma.subscription.deleteMany({ where: { providerSubId } });
      if (before.length > 0) await prisma.subscription.createMany({ data: before as never });
    }
  });
});
