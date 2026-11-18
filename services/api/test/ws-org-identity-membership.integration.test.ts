/**
 * WS-ORG (RG-06 / RG-07) — behavioural regressions on a disposable
 * PostgreSQL 16 through the real services and routes.
 *
 *   PRO-A2-01 / PRO-T2-01 / B5B-F-302  invitation acceptance never converts a
 *                                      self-serve account (an org-originated one
 *                                      still binds)
 *   PRO-A2-02                          the manual link refuses a self-serve
 *                                      member; a stored link is honoured only
 *                                      with owner consent (sign-in / step-up)
 *   PRO-T2-03                          restore never revives a REVOKED row
 *   PRO-T2-02                          removing a REVOKED row / re-suspending
 *                                      signs nobody out again
 *   PRO-A2Z-01 / PRO-TZ-01             reconciliation "suspend" never demotes
 *                                      the OWNER; a MEMBER is really suspended
 *   PRO-A2Z-02                         group archive undoes only its own grants
 *   PRO-LEAD-01 / PRO-G1Z-01 / B7B-F09 directory demotion and capability revoke
 *                                      end the creator's webhooks
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, OrganizationTenant } from "./point7/product-fixtures.js";

describe("WS-ORG — identity and membership roots (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let fx: typeof import("./point7/product-fixtures.js");
  let identityMode: typeof import("../src/services/identity/identity-mode.service.js");
  let acceptance: typeof import("../src/services/organization/org-invite-acceptance.service.js");
  let external: typeof import("../src/services/identity/external-identity.service.js");
  let linking: typeof import("../src/services/security/enterprise-account-linking.service.js");
  let stepUpIdp: typeof import("../src/services/identity-security/step-up-idp.js");
  let provisioning: typeof import("../src/services/identity/membership-provisioning.service.js");
  let reconciliation: typeof import("../src/services/access-control/scim-reconciliation.service.js");
  let groups: typeof import("../src/services/access-control/scim-groups.service.js");
  let rbac: typeof import("../src/services/identity/rbac.service.js");
  let deps: FixtureDeps;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function selfServeAt(domain: string, label: string) {
    const seeded = await fx.seedUser(deps, label);
    const email = `${label}-${randomUUID().slice(0, 6)}@${domain}`;
    await prisma.user.update({ where: { id: seeded.userId }, data: { email, providerUserId: email } });
    const token = deps.mintToken(seeded.userId, email);
    await fx.registerSessionForToken(deps, seeded.userId, token);
    await fx.bootstrapPersonalSpace(deps, seeded.userId);
    return { id: seeded.userId, email, token };
  }

  async function invite(org: OrganizationTenant, email: string) {
    const raw = randomUUID();
    const tokenHash = createHash("sha256").update(raw).digest("hex");
    await prisma.organizationInvite.create({
      data: {
        organizationId: org.organizationId,
        email,
        role: "ORG_MEMBER",
        tokenHash,
        invitedByUserId: org.owner.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      } as never,
    });
    return tokenHash;
  }

  async function orgMember(org: OrganizationTenant, label: string, role: "MEMBER" | "VIEWER" | "ADMIN" = "MEMBER") {
    const u = await fx.seedUser(deps, label);
    const om = await prisma.organizationMembership.create({
      data: { organizationId: org.organizationId, userId: u.userId, role: "ORG_MEMBER" },
      select: { id: true },
    });
    const tm = await prisma.teamMember.create({
      data: { teamId: org.workspaceId, userId: u.userId, role, status: "ACTIVE" },
      select: { id: true },
    });
    return { ...u, orgMembershipId: om.id, teamMemberId: tm.id };
  }

  const revocations = (userId: string) => prisma.revokedSession.count({ where: { userId } });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const jwt = await import("../src/services/jwt.js");
    fx = await import("./point7/product-fixtures.js");
    identityMode = await import("../src/services/identity/identity-mode.service.js");
    acceptance = await import("../src/services/organization/org-invite-acceptance.service.js");
    external = await import("../src/services/identity/external-identity.service.js");
    linking = await import("../src/services/security/enterprise-account-linking.service.js");
    stepUpIdp = await import("../src/services/identity-security/step-up-idp.js");
    provisioning = await import("../src/services/identity/membership-provisioning.service.js");
    reconciliation = await import("../src/services/access-control/scim-reconciliation.service.js");
    groups = await import("../src/services/access-control/scim-groups.service.js");
    rbac = await import("../src/services/identity/rbac.service.js");
    deps = {
      prisma: prisma as never,
      tag: `wsorg-${Date.now().toString(36)}`,
      mintToken: (userId: string, email: string) =>
        jwt.signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET as string,
          3600,
        ),
    };
  }, 300_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 300_000);

  // ---------------------------------------------------------------------------
  // RG-06
  // ---------------------------------------------------------------------------

  it("PRO-A2-01 — a self-serve invitee at a verified domain joins as a member and stays STANDARD", async () => {
    const org = await fx.seedOrganizationTenant(deps, { managedIdentityRequired: true });
    const domain = await fx.verifyOrganizationDomain(deps, org.organizationId, org.owner.userId);
    const person = await selfServeAt(domain, "a201-self");
    const tokenHash = await invite(org, person.email);

    await acceptance.acceptOrganizationInvite({ tokenHash, userId: person.id });

    const membership = await prisma.organizationMembership.findFirst({
      where: { organizationId: org.organizationId, userId: person.id },
      select: { status: true },
    });
    expect(membership?.status).toBe("ACTIVE");
    expect((await identityMode.resolveManagedIdentity(person.id)).state).toBe("STANDARD");
    expect(await identityMode.resolvePersonalSpaceEligibility(person.id)).toEqual({ allowed: true });
    await expect(identityMode.assertPersonalExportAllowed(person.id)).resolves.toBeUndefined();
  });

  it("PRO-A2-01 / B5B-F-302 — the canonical binding refuses DOMAIN evidence for a self-serve account by default; an Organization-originated account still binds", async () => {
    const org = await fx.seedOrganizationTenant(deps, { managedIdentityRequired: true });
    const domain = await fx.verifyOrganizationDomain(deps, org.organizationId, org.owner.userId);
    const domainRow = await prisma.organizationDomain.findFirstOrThrow({
      where: { organizationId: org.organizationId, domain },
      select: { id: true },
    });
    const person = await selfServeAt(domain, "a201-default");
    await expect(
      identityMode.setManagedIdentity({
        userId: person.id,
        managingOrganizationId: org.organizationId,
        evidence: { source: "DOMAIN", organizationDomainId: domainRow.id, userEmail: person.email },
      }),
    ).rejects.toMatchObject({ code: "MANAGED_IDENTITY_SELF_SERVE_ACCOUNT" });
    expect((await identityMode.resolveManagedIdentity(person.id)).state).toBe("STANDARD");

    const seeded = await fx.seedUser(deps, "a201-org");
    const email = `dir-${randomUUID().slice(0, 6)}@${domain}`;
    await prisma.user.update({
      where: { id: seeded.userId },
      data: { email, providerUserId: `scim-${org.organizationId}:ext-${randomUUID()}` },
    });
    await identityMode.setManagedIdentity({
      userId: seeded.userId,
      managingOrganizationId: org.organizationId,
      evidence: { source: "DOMAIN", organizationDomainId: domainRow.id, userEmail: email },
    });
    expect(await identityMode.resolveManagedIdentity(seeded.userId)).toMatchObject({
      state: "MANAGED",
      managingOrganizationId: org.organizationId,
    });
  });

  it("PRO-A2-02 — the manual link refuses a self-serve member and writes nothing", async () => {
    const org = await fx.seedOrganizationTenant(deps);
    const victim = await orgMember(org, "a202-victim");
    await expect(
      external.linkExternalIdentity({
        teamId: org.workspaceId,
        userId: victim.userId,
        provider: "GENERIC_OIDC" as never,
        externalSubjectId: `attacker-${randomUUID()}`,
        actorUserId: org.owner.userId,
      }),
    ).rejects.toMatchObject({ code: "owner_consent_required" });
    expect(await prisma.externalIdentityMapping.count({ where: { userId: victim.userId } })).toBe(0);
  });

  it("PRO-A2-02 — a legacy admin-made link on a self-serve account no longer resolves for sign-in or IdP step-up; owner-consent evidence keeps it", async () => {
    const org = await fx.seedOrganizationTenant(deps);
    const victim = await orgMember(org, "a202-legacy");
    const subject = `legacy-${randomUUID()}`;
    await prisma.externalIdentityMapping.create({
      data: {
        teamId: org.workspaceId,
        organizationId: org.organizationId,
        userId: victim.userId,
        provider: "GENERIC_OIDC",
        externalSubjectId: subject,
      },
    });
    const verdict = await linking.evaluateExternalLinkAuthority({
      userId: victim.userId,
      organizationId: org.organizationId,
      provider: "GENERIC_OIDC",
      linkSource: null,
    });
    expect(verdict.honoured).toBe(false);
    expect(
      await stepUpIdp.resolveLinkedUserForSubject(prisma as never, {
        organizationId: org.organizationId,
        provider: "GENERIC_OIDC",
        externalSubjectId: subject,
      }),
    ).toBeNull();

    // The consent flow's membership grant is the owner's evidence.
    await prisma.membershipGrant.create({
      data: {
        teamMemberId: victim.teamMemberId,
        source: "SSO_JIT",
        intent: "SSO_JIT",
        externalRef: `org-link:GENERIC_OIDC:${randomUUID()}`,
      } as never,
    });
    expect(
      await stepUpIdp.resolveLinkedUserForSubject(prisma as never, {
        organizationId: org.organizationId,
        provider: "GENERIC_OIDC",
        externalSubjectId: subject,
      }),
    ).toBe(victim.userId);
  });

  // ---------------------------------------------------------------------------
  // RG-07
  // ---------------------------------------------------------------------------

  it("PRO-T2-03 — restore refuses a self-departed (REVOKED) membership; a SUSPENDED one still restores", async () => {
    const org = await fx.seedOrganizationTenant(deps);
    const leaver = await orgMember(org, "t203-leaver");
    const left = await harness.app.inject({
      method: "POST",
      url: `/v1/orgs/${org.organizationId}/leave`,
      headers: auth(leaver.token),
      payload: {},
    });
    expect(left.statusCode, left.body).toBe(200);

    const restore = await harness.app.inject({
      method: "POST",
      url: `/v1/orgs/${org.organizationId}/members/${leaver.orgMembershipId}/restore`,
      headers: auth(org.owner.token),
      payload: {},
    });
    expect(restore.statusCode, restore.body).toBe(409);
    expect(JSON.parse(restore.body)).toMatchObject({ error: { code: "ILLEGAL_MEMBERSHIP_TRANSITION" } });
    const row = await prisma.organizationMembership.findUniqueOrThrow({
      where: { id: leaver.orgMembershipId },
      select: { status: true },
    });
    expect(row.status).toBe("REVOKED");

    const paused = await orgMember(org, "t203-paused");
    const s = await harness.app.inject({
      method: "POST",
      url: `/v1/orgs/${org.organizationId}/members/${paused.orgMembershipId}/suspend`,
      headers: auth(org.owner.token),
      payload: {},
    });
    expect(s.statusCode, s.body).toBe(200);
    const r = await harness.app.inject({
      method: "POST",
      url: `/v1/orgs/${org.organizationId}/members/${paused.orgMembershipId}/restore`,
      headers: auth(org.owner.token),
      payload: {},
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ status: "ACTIVE", changed: true });
  });

  it("PRO-T2-02 — removing an already-removed member, or suspending twice, signs nobody out again", async () => {
    const org = await fx.seedOrganizationTenant(deps);
    const gone = await orgMember(org, "t202-gone");
    const first = await harness.app.inject({
      method: "DELETE",
      url: `/v1/orgs/${org.organizationId}/members/${gone.orgMembershipId}`,
      headers: auth(org.owner.token),
    });
    expect(first.statusCode, first.body).toBe(200);
    const afterFirst = await revocations(gone.userId);
    const removedEvents = () =>
      prisma.organizationAuditEvent.count({
        where: { organizationId: org.organizationId, eventType: "ORG_MEMBER_REMOVED", targetId: gone.orgMembershipId },
      });
    const eventsAfterFirst = await removedEvents();

    const again = await harness.app.inject({
      method: "DELETE",
      url: `/v1/orgs/${org.organizationId}/members/${gone.orgMembershipId}`,
      headers: auth(org.owner.token),
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(JSON.parse(again.body)).toMatchObject({ error: { code: "MEMBERSHIP_ALREADY_REMOVED" } });
    expect(await revocations(gone.userId)).toBe(afterFirst);
    expect(await removedEvents()).toBe(eventsAfterFirst);

    const paused = await orgMember(org, "t202-paused");
    const s1 = await harness.app.inject({
      method: "POST",
      url: `/v1/orgs/${org.organizationId}/members/${paused.orgMembershipId}/suspend`,
      headers: auth(org.owner.token),
      payload: {},
    });
    expect(s1.statusCode, s1.body).toBe(200);
    const afterSuspend = await revocations(paused.userId);
    const s2 = await harness.app.inject({
      method: "POST",
      url: `/v1/orgs/${org.organizationId}/members/${paused.orgMembershipId}/suspend`,
      headers: auth(org.owner.token),
      payload: {},
    });
    expect(s2.statusCode, s2.body).toBe(200);
    expect(JSON.parse(s2.body)).toMatchObject({ changed: false });
    expect(await revocations(paused.userId)).toBe(afterSuspend);
  });

  it("PRO-A2Z-01 — reconciliation never demotes the OWNER; an unlinked MEMBER is actually suspended", async () => {
    const org = await fx.seedOrganizationTenant(deps);
    const member = await orgMember(org, "a2z01-member");
    for (const userId of [org.owner.userId, member.userId]) {
      await prisma.externalIdentityMapping.create({
        data: {
          teamId: org.workspaceId,
          organizationId: org.organizationId,
          userId,
          provider: "GENERIC_SCIM",
          externalSubjectId: `gone-${randomUUID()}`,
          linkSource: "SCIM",
          unlinkedAtUtc: new Date(),
        } as never,
      });
    }
    const admin = await orgMember(org, "a2z01-actor", "ADMIN");
    const report = await reconciliation.detectScimDrift({ teamId: org.workspaceId, actorUserId: admin.userId });
    const items = report.items.filter((i) => i.category === "UNLINKED_IDENTITY_ACTIVE_USER");
    const ownerItem = items.find((i) => i.subject.id === org.owner.userId)!;
    const memberItem = items.find((i) => i.subject.id === member.userId)!;
    expect(ownerItem).toBeTruthy();
    expect(memberItem).toBeTruthy();

    const result = await reconciliation.executeScimReconciliation({
      teamId: org.workspaceId,
      previewId: report.previewId,
      itemIds: [ownerItem.id, memberItem.id],
      actorUserId: admin.userId,
    } as never);
    expect(result.ok).toBe(true);
    const owner = await prisma.teamMember.findFirstOrThrow({
      where: { teamId: org.workspaceId, userId: org.owner.userId },
      select: { role: true, status: true },
    });
    expect(owner).toEqual({ role: "OWNER", status: "ACTIVE" });
    const m = await prisma.teamMember.findUniqueOrThrow({
      where: { id: member.teamMemberId },
      select: { role: true, status: true },
    });
    expect(m).toEqual({ role: "MEMBER", status: "SUSPENDED" });
  });

  async function projectedGroup(org: OrganizationTenant, mappedRole: "ADMIN" | "VIEWER") {
    const group = await prisma.scimGroup.create({
      data: {
        teamId: org.workspaceId,
        organizationId: org.organizationId,
        displayName: `g-${randomUUID().slice(0, 6)}`,
        mappedRole,
      },
      select: { id: true },
    });
    const projection = await prisma.scimGroupWorkspaceProjection.create({
      data: { scimGroupId: group.id, organizationId: org.organizationId, workspaceId: org.workspaceId, mappedRole },
      select: { id: true },
    });
    return { groupId: group.id, projectionId: projection.id };
  }

  async function webhookBy(teamId: string, userId: string) {
    return prisma.webhookEndpoint.create({
      data: {
        teamId,
        url: "https://hooks.example.test/in",
        secretCiphertext: "x",
        secretPrefix: "x",
        createdByUserId: userId,
      },
      select: { id: true },
    });
  }

  it("PRO-A2Z-02 / PRO-LEAD-01 — archiving a group undoes only its own grants and ends the demoted creator's webhooks", async () => {
    const org = await fx.seedOrganizationTenant(deps);
    const viewer = await orgMember(org, "a2z02-viewer", "VIEWER");
    const handAdmin = await orgMember(org, "a2z02-hand", "ADMIN");
    const groupAdmin = await orgMember(org, "a2z02-grp");

    const viewerGroup = await projectedGroup(org, "VIEWER");
    await groups.archiveScimGroupProjection({
      organizationId: org.organizationId,
      projectionId: viewerGroup.projectionId,
      actorUserId: org.owner.userId,
    });
    expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: viewer.teamMemberId } })).role).toBe("VIEWER");

    const adminGroup = await projectedGroup(org, "ADMIN");
    await provisioning.applyDirectoryRoleChange(prisma as never, {
      teamMemberId: groupAdmin.teamMemberId,
      currentRole: "MEMBER",
      desiredRole: "ADMIN",
      source: "IDP_GROUP",
      externalRef: `scim-group:${adminGroup.groupId}`,
      allowPrivilegedChange: true,
    });
    const hook = await webhookBy(org.workspaceId, groupAdmin.userId);
    const handHook = await webhookBy(org.workspaceId, handAdmin.userId);
    await groups.archiveScimGroupProjection({
      organizationId: org.organizationId,
      projectionId: adminGroup.projectionId,
      actorUserId: org.owner.userId,
    });
    expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: groupAdmin.teamMemberId } })).role).toBe("MEMBER");
    expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: handAdmin.teamMemberId } })).role).toBe("ADMIN");
    expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id } })).status).toBe("DISABLED");
    expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: handHook.id } })).status).toBe("ACTIVE");
  });

  it("PRO-G1Z-01 — revoking the capability that let a member create a webhook disables it in the same transaction", async () => {
    const org = await fx.seedOrganizationTenant(deps);
    const member = await orgMember(org, "g1z01");
    const grant = await rbac.grantCapability({
      teamId: org.workspaceId,
      teamMemberId: member.teamMemberId,
      permission: "integration.webhook.manage" as never,
      actorUserId: org.owner.userId,
    });
    const hook = await webhookBy(org.workspaceId, member.userId);
    await rbac.revokeCapability({ teamId: org.workspaceId, grantId: grant.id, actorUserId: org.owner.userId } as never);
    expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id } })).status).toBe("DISABLED");
  });
});
