/**
 * Members re-audit 3 — the Organization-scoped identity residue and the SCIM
 * deactivation that left work stuck, proven against a real PostgreSQL:
 *
 *   N-5 / T-1a  DELETE /v1/identity/external-mappings/:id is administered from
 *               the workspace the caller ACTS from (the canonical permission
 *               there + the Organization identity role), not from the link
 *               row's configuring workspace; a caller of another Organization
 *               gets the same concealed 404 as a non-existent id. Through the
 *               ROUTE (app.inject), from a SIBLING workspace.
 *   T-1b        a sibling workspace's directory token lists and GETs the
 *               Organization's directory users who hold a membership in its
 *               workspace (and can PATCH their displayName); a user of another
 *               Organization, or one without a membership there, is not seen.
 *   B-N1        SCIM deactivation (the canonical `suspendWorkspaceMembership`
 *               writer) releases the work the person held — rows kept,
 *               unassigned, one audit row per workspace — and a colleague's
 *               work is untouched.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("DOM-13 re-audit 3 — sibling-workspace unlink route, SCIM Users readers, SCIM deactivation releases work (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let fixtures: typeof import("./point7/product-fixtures.js");
  let scim: typeof import("../src/services/access-control/scim.service.js");
  let groups: typeof import("../src/services/access-control/scim-groups.service.js");
  let identity: typeof import("../src/services/identity/external-identity.service.js");
  let factors: typeof import("../src/services/security/verified-contact-factor.service.js");
  let signJwt: typeof import("../src/services/jwt.js").signJwt;

  const tag = () => randomUUID().slice(0, 8);

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    fixtures = await import("./point7/product-fixtures.js");
    scim = await import("../src/services/access-control/scim.service.js");
    groups = await import("../src/services/access-control/scim-groups.service.js");
    identity = await import("../src/services/identity/external-identity.service.js");
    factors = await import("../src/services/security/verified-contact-factor.service.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const deps = () => ({
    prisma: prisma as never,
    tag: `dom13r3-${tag()}`,
    mintToken: (userId: string, email: string) =>
      signJwt(
        { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
        process.env.AUTH_JWT_SECRET as string,
        3600,
      ),
  });

  async function workspace(orgId: string, ownerUserId: string) {
    const w = await prisma.team.create({
      data: {
        name: `dom13r3-w-${tag()}`,
        ownerUserId,
        billingOwnerUserId: ownerUserId,
        isPersonal: false,
        organizationId: orgId,
        workspaceKind: "ORGANIZATION",
        billingPlan: "ENTERPRISE",
        billingStatus: "ACTIVE",
      },
      select: { id: true },
    });
    await prisma.teamMember.create({ data: { teamId: w.id, userId: ownerUserId, role: "OWNER", status: "ACTIVE" } });
    return w.id;
  }

  /** An Enterprise Organization with two open Workspaces. */
  async function organization() {
    const t = await fixtures.seedOrganizationTenant(deps());
    const w2 = await workspace(t.organizationId, t.owner.userId);
    return { orgId: t.organizationId, w1: t.workspaceId, w2, owner: t.owner };
  }

  async function directory(o: { orgId: string; owner: { userId: string } }, teamId: string) {
    const { projection } = await scim.createScimToken(
      { teamId, actorUserId: o.owner.userId, name: `dir-${tag()}`, scopes: ["users.read", "users.write", "users.deactivate", "groups.read", "groups.write"] },
      prisma,
    );
    return { teamId, organizationId: o.orgId, tokenId: projection.id, baseUrl: "https://scim.test/v2/scim" };
  }

  async function pushUser(ctx: Awaited<ReturnType<typeof directory>>, externalId: string) {
    const email = `dom13r3-${tag()}@example.test`;
    const out = await scim.scimCreateUser(
      ctx,
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: email, externalId, emails: [{ value: email, primary: true }], active: true } as never,
      prisma,
    );
    expect(out.ok, JSON.stringify(out)).toBe(true);
    return (out as { user: { id: string } }).user.id;
  }

  async function plainMember(teamId: string, role: "ADMIN" | "MEMBER" = "MEMBER") {
    const email = `dom13r3-plain-${tag()}@example.test`;
    const u = await prisma.user.create({ data: { email, provider: "EMAIL", providerUserId: email }, select: { id: true } });
    await prisma.teamMember.create({ data: { teamId, userId: u.id, role, status: "ACTIVE" } });
    return u.id;
  }

  /** A user provisioned through w1's directory who also holds an ADMIN membership in w2. */
  async function directoryUserInSibling(o: Awaited<ReturnType<typeof organization>>) {
    const ctx = await directory(o, o.w1);
    const externalId = `ext-${tag()}`;
    const u = await pushUser(ctx, externalId);
    const g = await groups.scimCreateGroup(
      ctx,
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Staff", externalId: `g-${tag()}`, mappedRole: "MEMBER", members: [{ value: u }] } as never,
      prisma,
    );
    await groups.addScimGroupProjection(
      { organizationId: o.orgId, groupId: (g as { group: { id: string } }).group.id, workspaceId: o.w2, mappedRole: "ADMIN", actorUserId: o.owner.userId },
      prisma,
    );
    const m = await prisma.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: o.w2, userId: u } } });
    expect(m.status).toBe("ACTIVE");
    return { ctx, u, externalId };
  }

  /** A real, signed-in operator acting FROM `teamId` (the persisted workspace pointer). */
  async function operatorIn(teamId: string, orgId: string, role: "ADMIN" | "MEMBER", orgRole: "ORG_ADMIN" | "ORG_MEMBER") {
    const user = await fixtures.seedUser(deps(), `op-${role.toLowerCase()}`);
    await prisma.teamMember.create({ data: { teamId, userId: user.userId, role, status: "ACTIVE" } });
    await prisma.organizationMembership.create({ data: { organizationId: orgId, userId: user.userId, role: orgRole } });
    await prisma.user.update({ where: { id: user.userId }, data: { currentWorkspaceId: teamId } });
    return user;
  }

  /** An APPROVED step-up challenge bound to one external identity mapping, minted in `teamId`. */
  async function unlinkStepUp(teamId: string, userId: string, mappingId: string) {
    // Enrolled through the real service (once per account: it refuses a second).
    const existing = await prisma.mfaFactor.findFirst({
      where: { userId, status: "ACTIVE" as never, verifiedAtUtc: { not: null }, revokedAt: null },
    });
    const factorId =
      existing?.id ??
      (await (async () => {
        const started = await factors.startContactFactorEnrollment({
          userId,
          kind: "SMS",
          destinationRaw: "+15550100",
          label: "reaudit3",
        });
        await factors.completeContactFactorEnrollment({ userId, factorId: started.factor.factorId });
        return started.factor.factorId;
      })());
    const factor = await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factorId } });
    const challenge = await prisma.stepUpChallenge.create({
      data: {
        teamId,
        initiatedByUserId: userId,
        purpose: "EXTERNAL_IDENTITY_UNLINK",
        resourceKind: "external_identity_mapping",
        resourceId: mappingId,
        status: "APPROVED" as never,
        factorId: factor.id,
        factorGeneration: factor.generation,
        approvedAtUtc: new Date(),
        expiresAtUtc: new Date(Date.now() + 10 * 60_000),
      },
    });
    return challenge.id;
  }

  const unlink = (mappingId: string, token: string, payload: Record<string, unknown>, challengeId?: string) =>
    h.app.inject({
      method: "DELETE",
      url: `/v1/identity/external-mappings/${mappingId}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(challengeId ? { "x-proovra-step-up-challenge-id": challengeId } : {}),
      },
      payload,
    });

  // ---------------------------------------------------------------------------
  // N-5 / T-1a — the unlink route, from a sibling workspace
  // ---------------------------------------------------------------------------

  it("N-5: an identity administrator of a SIBLING workspace unlinks an Organization link configured from w1 through the route; another Organization and a non-existent id get the same concealed 404", async () => {
    const o = await organization();
    const other = await organization();
    // The person holds memberships in both workspaces; the link was made from w1.
    const person = await plainMember(o.w1);
    await prisma.teamMember.create({ data: { teamId: o.w2, userId: person, role: "MEMBER", status: "ACTIVE" } });
    const link = await identity.linkExternalIdentity(
      { teamId: o.w1, userId: person, provider: "OKTA", externalSubjectId: `okta|${tag()}`, actorUserId: o.owner.userId },
      prisma,
    );
    // A w1-only person's link: not this sibling's to administer.
    const w1Only = await plainMember(o.w1);
    const w1OnlyLink = await identity.linkExternalIdentity(
      { teamId: o.w1, userId: w1Only, provider: "OKTA", externalSubjectId: `okta|${tag()}`, actorUserId: o.owner.userId },
      prisma,
    );

    // The acting administrator holds NO membership in w1.
    const admin2 = await operatorIn(o.w2, o.orgId, "ADMIN", "ORG_ADMIN");
    expect(await prisma.teamMember.findUnique({ where: { teamId_userId: { teamId: o.w1, userId: admin2.userId } } })).toBeNull();

    // Another Organization's identity administrator, acting from its own workspace.
    const foreign = await operatorIn(other.w1, other.orgId, "ADMIN", "ORG_ADMIN");
    const foreignChallenge = await unlinkStepUp(other.w1, foreign.userId, link.id);
    const crossOrg = await unlink(link.id, foreign.token, {}, foreignChallenge);
    const missingId = randomUUID();
    const missing = await unlink(missingId, foreign.token, {}, await unlinkStepUp(other.w1, foreign.userId, missingId));
    expect(crossOrg.statusCode, crossOrg.body).toBe(404);
    expect(missing.statusCode, missing.body).toBe(404);
    expect(crossOrg.json()).toEqual(missing.json());
    expect(crossOrg.json()).toEqual({ error: { code: "not_found" } });
    // The concealed refusal spent nothing.
    expect((await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id: foreignChallenge } })).status).toBe("APPROVED");

    // The sibling's administrator cannot reach a link of a person who is not its member.
    const notMine = await unlink(w1OnlyLink.id, admin2.token, {}, await unlinkStepUp(o.w2, admin2.userId, w1OnlyLink.id));
    expect(notMine.statusCode, notMine.body).toBe(404);

    // Authorised by the canonical permission in the workspace acted from: a
    // w2 MEMBER (with an Organization role) is refused on w2's authority.
    const member2 = await operatorIn(o.w2, o.orgId, "MEMBER", "ORG_ADMIN");
    const denied = await unlink(link.id, member2.token, {}, await unlinkStepUp(o.w2, member2.userId, link.id));
    expect(denied.statusCode, denied.body).toBe(403);

    // Nothing was unlinked by any refusal.
    expect((await prisma.externalIdentityMapping.findUniqueOrThrow({ where: { id: link.id } })).unlinkedAtUtc).toBeNull();
    expect((await prisma.externalIdentityMapping.findUniqueOrThrow({ where: { id: w1OnlyLink.id } })).unlinkedAtUtc).toBeNull();

    // Positive control: the w2 administrator unlinks with the body the web UI sends ({}).
    const ok = await unlink(link.id, admin2.token, {}, await unlinkStepUp(o.w2, admin2.userId, link.id));
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await prisma.externalIdentityMapping.findUniqueOrThrow({ where: { id: link.id } })).unlinkedAtUtc).not.toBeNull();
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "identity.external_mapping.unlink", resourceId: link.id },
    });
    expect(audit).toMatchObject({ workspaceId: o.w2, userId: admin2.userId });
  });

  // ---------------------------------------------------------------------------
  // T-1b — the SCIM Users readers
  // ---------------------------------------------------------------------------

  it("T-1b: a sibling workspace's directory token lists, GETs and updates a user w1's token provisioned who holds a membership in w2; another Organization's token and a non-member are refused", async () => {
    const o = await organization();
    const other = await organization();
    const { ctx: ctx1, u, externalId } = await directoryUserInSibling(o);
    const ctx2 = await directory(o, o.w2); // the sibling workspace's own directory app
    const w1Only = await pushUser(ctx1, `ext-${tag()}`); // no membership in w2
    const ctxOther = await directory(other, other.w1);

    // Positive control: the provisioning token sees both.
    const fromW1 = await scim.scimListUsers(ctx1, {}, prisma);
    expect(fromW1.Resources.map((r) => r.id)).toEqual(expect.arrayContaining([u, w1Only]));

    // The sibling token lists the member of w2 — and only them.
    const fromW2 = await scim.scimListUsers(ctx2, {}, prisma);
    expect(fromW2.Resources.map((r) => r.id)).toContain(u);
    expect(fromW2.Resources.map((r) => r.id)).not.toContain(w1Only);
    expect(fromW2.totalResults).toBe(fromW2.Resources.length);
    const filtered = await scim.scimListUsers(ctx2, { filter: `externalId eq "${externalId}"` }, prisma);
    expect(filtered.totalResults).toBe(1);
    expect(filtered.Resources[0]).toMatchObject({ id: u, externalId, active: true });

    // GET /Users/{id} from the sibling.
    expect(await scim.scimReadUser(ctx2, u, prisma)).toMatchObject({ id: u, externalId, active: true });
    expect(await scim.scimReadUser(ctx2, w1Only, prisma)).toBeNull();

    // PATCH displayName from the sibling writes the Organization's link.
    const upd = await scim.scimUpdateUserAttributes(ctx2, u, { displayName: "Renamed from w2" }, prisma);
    expect(upd).toMatchObject({ ok: true, appliedFields: ["displayName"] });
    expect(await scim.scimReadUser(ctx1, u, prisma)).toMatchObject({ displayName: "Renamed from w2" });

    // Another Organization's token sees none of it.
    const foreign = await scim.scimListUsers(ctxOther, {}, prisma);
    expect(foreign.Resources.map((r) => r.id)).not.toContain(u);
    expect((await scim.scimListUsers(ctxOther, { filter: `externalId eq "${externalId}"` }, prisma)).totalResults).toBe(0);
    expect(await scim.scimReadUser(ctxOther, u, prisma)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // B-N1 — SCIM deactivation releases held work
  // ---------------------------------------------------------------------------

  async function holdWork(teamId: string, holderId: string, assignerId: string) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    const evidence = await prisma.evidence.create({
      data: { title: `N1 ${tag()}`, type: "PHOTO", status: "CREATED", teamId, organizationId: team.organizationId, ownerUserId: assignerId } as never,
      select: { id: true },
    });
    const wf = await prisma.evidenceReviewWorkflow.create({
      data: { teamId, evidenceId: evidence.id, workspaceType: "TEAM", status: "ASSIGNED" as never, assignedToUserId: holderId },
      select: { id: true },
    });
    const escalation = await prisma.reviewEscalation.create({
      data: {
        teamId,
        workflowId: wf.id,
        evidenceId: evidence.id,
        reason: "REVIEW_OVERDUE",
        severity: "WARNING",
        status: "OPEN",
        safeSummary: "Overdue",
        assignedToUserId: holderId,
        fingerprint: randomUUID(),
      },
      select: { id: true },
    });
    const group = await prisma.collaborationTeam.create({
      data: { workspaceId: teamId, name: `N1 ${tag()}`, createdByUserId: assignerId, status: "ACTIVE" },
      select: { id: true },
    });
    await prisma.collaborationTeamMember.create({ data: { teamId: group.id, userId: holderId, role: "MEMBER", status: "ACTIVE" } as never });
    const task = await prisma.collaborationTeamAssignment.create({
      data: { teamId: group.id, workspaceId: teamId, assigneeUserId: holderId, assignedByUserId: assignerId, targetType: "REVIEW", targetId: wf.id, status: "IN_PROGRESS" },
      select: { id: true },
    });
    return { workflowId: wf.id, escalationId: escalation.id, taskId: task.id };
  }

  async function expectReleased(teamId: string, holderId: string, held: Awaited<ReturnType<typeof holdWork>>) {
    const wf = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: held.workflowId } });
    expect(wf.assignedToUserId).toBeNull();
    expect(String(wf.status)).toBe("QUEUED");
    const ev = await prisma.evidenceReviewWorkflowEvent.findFirstOrThrow({ where: { workflowId: held.workflowId, eventType: "UNASSIGNED" } });
    expect(ev.previousValue).toMatchObject({ assignedToUserId: holderId });
    expect(ev.nextValue).toMatchObject({ reason: "member_suspended" });
    const esc = await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: held.escalationId } });
    expect(esc).toMatchObject({ assignedToUserId: null, status: "OPEN" });
    const task = await prisma.collaborationTeamAssignment.findUniqueOrThrow({ where: { id: held.taskId } });
    expect(task).toMatchObject({ assigneeUserId: null, status: "OPEN" });
    const audits = await prisma.adminAuditLog.findMany({
      where: { action: "workspace.member.work_released", resourceId: holderId, workspaceId: teamId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ reason: "member_suspended", reviewWorkflows: 1, escalations: 1, teamTasks: 1 });
  }

  it("B-N1: SCIM deactivation releases the work the person held in every workspace it suspends (rows kept, unassigned, one audit row each); a colleague's work is untouched", async () => {
    const o = await organization();
    const { ctx, u } = await directoryUserInSibling(o); // ACTIVE in w1 and w2
    const colleague = await plainMember(o.w1);
    const heldW1 = await holdWork(o.w1, u, o.owner.userId);
    const heldW2 = await holdWork(o.w2, u, o.owner.userId);
    const colleagues = await holdWork(o.w1, colleague, o.owner.userId);
    // SEC-08 — a directory suspension ends the person's owner links, as an
    // administrator's suspension does; a colleague's link is untouched.
    const ownerLink = async (createdByUserId: string) => {
      const team = await prisma.team.findUniqueOrThrow({ where: { id: o.w1 }, select: { organizationId: true } });
      const evidence = await prisma.evidence.create({
        data: { title: `N1 link ${tag()}`, type: "PHOTO", status: "SIGNED", teamId: o.w1, organizationId: team.organizationId, ownerUserId: createdByUserId } as never,
        select: { id: true },
      });
      return (
        await prisma.verificationShareToken.create({
          data: {
            evidenceId: evidence.id,
            teamId: o.w1,
            tokenHash: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
            purpose: "OWNER_SHARE",
            createdByUserId,
            expiresAtUtc: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
          select: { id: true },
        })
      ).id;
    };
    const theirLink = await ownerLink(u);
    const colleaguesLink = await ownerLink(colleague);

    expect(await scim.scimDeactivateUser(ctx, u, prisma)).toEqual({ ok: true });

    expect(await prisma.verificationShareToken.findUniqueOrThrow({ where: { id: theirLink } })).toMatchObject({
      revocationReason: "CREATOR_SUSPENDED",
    });
    expect((await prisma.verificationShareToken.findUniqueOrThrow({ where: { id: colleaguesLink } })).revokedAtUtc).toBeNull();

    for (const teamId of [o.w1, o.w2]) {
      expect((await prisma.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId, userId: u } } })).status).toBe("SUSPENDED");
    }
    await expectReleased(o.w1, u, heldW1);
    await expectReleased(o.w2, u, heldW2);

    // Positive control: the colleague still holds all of theirs, and no release was audited for them.
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: colleagues.workflowId } })).assignedToUserId).toBe(colleague);
    expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: colleagues.escalationId } })).assignedToUserId).toBe(colleague);
    expect((await prisma.collaborationTeamAssignment.findUniqueOrThrow({ where: { id: colleagues.taskId } })).assigneeUserId).toBe(colleague);
    expect(await prisma.adminAuditLog.count({ where: { action: "workspace.member.work_released", resourceId: colleague } })).toBe(0);
    // Suspension keeps reach: the group placement is intact.
    expect(await prisma.collaborationTeamMember.count({ where: { userId: u, status: "ACTIVE" } })).toBe(2);
  });
});
