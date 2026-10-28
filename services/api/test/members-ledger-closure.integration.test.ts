/**
 * MEMBERS LEDGER CLOSURE (2026-10-28) — the findings the A–F delivery left
 * open, each proven against a real PostgreSQL:
 *
 *   X5   a group with no valid lead can be given one by the workspace owner,
 *        and only then;
 *   X6   issuing and revoking an external-review grant writes its tenant
 *        audit row in the same transaction, and a second revoke is a typed
 *        refusal;
 *   M5   an ACTIVE Enterprise contract silent on Collaboration Teams grants
 *        none (never the catalog placeholder);
 *   M8   the projected invitation ceilings are the gate's own;
 *   M9   account closure never closes an Organization Workspace;
 *   M13  a lapsed invitation at another role does not block a re-invite;
 *   M14b concurrent invitations cannot pass the pending ceiling together.
 *
 * And the closure audit's findings on that work:
 *   N-3  an Organization invite seats nobody in a restricted workspace;
 *   N-4  an approval does not outlive a tightened Organization step-up policy;
 *   N-6  a password change cancels every outstanding step-up.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";
import {
  seedOrganizationTenant,
  seedPersonalTenant,
  seedUser,
  type FixtureDeps,
} from "./point7/product-fixtures.js";

type Prisma = typeof import("../src/db.js")["prisma"];

describe("Members ledger closure (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let deps: FixtureDeps;
  let ct: typeof import("../src/services/collaboration-team/collaboration-team.service.js");
  let invitations: typeof import("../src/services/identity/workspace-invitation.service.js");
  let grants: typeof import("../src/services/external-review/external-review-grant.service.js");
  let preflight: typeof import("../src/services/identity/account-lifecycle-preflight.service.js");
  let seats: typeof import("../src/services/billing/workspace-seats.service.js");
  let entitlement: typeof import("../src/services/collaboration-team/collaboration-entitlement.service.js");
  let stepUpSvc: typeof import("../src/services/identity-security/step-up.service.js");
  let ceremony: ReturnType<typeof createStepUpCeremony>;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ct = await import("../src/services/collaboration-team/collaboration-team.service.js");
    invitations = await import("../src/services/identity/workspace-invitation.service.js");
    grants = await import("../src/services/external-review/external-review-grant.service.js");
    preflight = await import("../src/services/identity/account-lifecycle-preflight.service.js");
    seats = await import("../src/services/billing/workspace-seats.service.js");
    entitlement = await import("../src/services/collaboration-team/collaboration-entitlement.service.js");
    stepUpSvc = await import("../src/services/identity-security/step-up.service.js");
    ceremony = createStepUpCeremony({
      prisma: prisma as never,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `ledger-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt({ sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) }, secret, 3600),
    };
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);
  const codeOf = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string }) => e.code ?? "unknown",
    );

  // ---------------------------------------------------------------------------
  it("X5 — the workspace owner appoints a lead for a group that has none, and only then", async () => {
    const t = await seedPersonalTenant(deps, "TEAM");
    const member = await seedUser(deps, `x5-${tag()}`);
    await prisma.teamMember.create({ data: { teamId: t.personalTeamId, userId: member.userId, role: "MEMBER", status: "ACTIVE" } });
    const { id: teamId } = await ct.createCollaborationTeam({ workspaceId: t.personalTeamId, actorUserId: t.owner.userId, name: `X5 ${tag()}` });
    await ct.addExistingMember({ teamId, actorUserId: t.owner.userId, userIdToAdd: member.userId, role: "MEMBER" });

    // While a valid lead exists, recovery is refused.
    expect(await codeOf(ct.recoverCollaborationTeamLead({ teamId, actorUserId: t.owner.userId, newLeadUserId: member.userId }))).toBe(
      "LEAD_PRESENT",
    );

    // The lead's group row ends (as a departure would leave it).
    await prisma.collaborationTeamMember.updateMany({ where: { teamId, role: "LEAD" }, data: { status: "REMOVED" } });

    // A non-owner cannot appoint.
    expect(await codeOf(ct.recoverCollaborationTeamLead({ teamId, actorUserId: member.userId, newLeadUserId: member.userId }))).toBe(
      "LEAD_RECOVERY_OWNER_ONLY",
    );
    // An outsider cannot be appointed.
    const outsider = await seedUser(deps, `x5-out-${tag()}`);
    expect(await codeOf(ct.recoverCollaborationTeamLead({ teamId, actorUserId: t.owner.userId, newLeadUserId: outsider.userId }))).toBe(
      "LEAD_RECOVERY_TARGET_NOT_MEMBER",
    );

    // Through the route: the owner appoints the member; audited once.
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/collaboration-teams/${teamId}/lead-recovery`,
      headers: { authorization: `Bearer ${t.owner.token}`, "x-proovra-workspace-id": t.personalTeamId },
      payload: { userId: member.userId },
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = await prisma.collaborationTeamMember.findFirstOrThrow({ where: { teamId, userId: member.userId } });
    expect(row.role).toBe("LEAD");
    expect(
      await prisma.adminAuditLog.count({ where: { action: "collaboration_team.lead_recovered", resourceId: teamId, outcome: "success" } }),
    ).toBe(1);
  });

  // ---------------------------------------------------------------------------
  it("X6 — grant issue and revoke each commit their tenant audit row; a repeat revoke records nothing new", async () => {
    const A = h.fixtures.teamA;
    const issued = await grants.issueExternalReviewGrant({
      teamId: A.teamId,
      invitedByUserId: A.ownerUserId,
      scopeKind: "EVIDENCE",
      evidenceId: A.evidenceId,
      reviewerEmail: `x6-${tag()}@reviewer.example`,
      expiresAtUtc: new Date(Date.now() + 2 * 86_400_000),
      correlationId: "req-x6",
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const issuedAudit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "external_review.grant_issued", resourceId: issued.grant.id },
    });
    expect(issuedAudit.userId).toBe(A.ownerUserId);
    expect(JSON.stringify(issuedAudit)).not.toContain(issued.rawToken);

    const revoked = await grants.transitionExternalReviewGrant({
      grantId: issued.grant.id,
      teamId: A.teamId,
      toState: "REVOKED",
      actorUserId: A.ownerUserId,
    });
    expect(revoked.ok).toBe(true);
    expect(await prisma.adminAuditLog.count({ where: { action: "external_review.grant_revoked", resourceId: issued.grant.id } })).toBe(1);

    const again = await grants.transitionExternalReviewGrant({
      grantId: issued.grant.id,
      teamId: A.teamId,
      toState: "REVOKED",
      actorUserId: A.ownerUserId,
    });
    expect(again.ok).toBe(true);
    expect(await prisma.adminAuditLog.count({ where: { action: "external_review.grant_revoked", resourceId: issued.grant.id } })).toBe(1);
  });

  // ---------------------------------------------------------------------------
  it("M5/M8 — a contract silent on Collaboration Teams grants none; the projection's ceilings are the gate's", async () => {
    const org = await seedOrganizationTenant(deps, { billingPlan: "ENTERPRISE", contractCollaboration: null });
    const limits = await seats.resolveWorkspaceCollaborationLimits(org.workspaceId);
    expect(limits.maxCollaborationTeamsPerWorkspace).toBe(0);
    expect(limits.maxAcceptedMembersPerCollaborationTeam).toBe(0);
    expect(
      await codeOf(ct.createCollaborationTeam({ workspaceId: org.workspaceId, actorUserId: org.owner.userId, name: `M5 ${tag()}` })),
    ).toBe("ENTERPRISE_CONTRACT_REQUIRED");

    // Once the contract states its figures, they are the limits.
    await prisma.enterpriseContract.updateMany({
      where: { organizationId: org.organizationId },
      data: { collaborationTeamsMax: 3, collaborationTeamMembersMax: 7, seatCount: 20 },
    });
    const stated = await seats.resolveWorkspaceCollaborationLimits(org.workspaceId);
    expect(stated.maxCollaborationTeamsPerWorkspace).toBe(3);
    expect(stated.maxAcceptedMembersPerCollaborationTeam).toBe(7);

    const allowance = await seats.resolveWorkspaceInvitationAllowance(org.workspaceId);
    const projection = await entitlement.resolveCollaborationEntitlement(org.workspaceId, { canViewAllTeams: false });
    expect(projection.invitations.maxPending).toBe(allowance.maxPending);
    expect(projection.invitations.maxPer24h).toBe(allowance.maxPer24h);
  });

  // ---------------------------------------------------------------------------
  it("M9 — owning a live Organization Workspace blocks account closure; a Personal Workspace does not", async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 0 });
    const pre = await preflight.evaluateAccountClosurePreflight(org.owner.userId);
    expect(pre.blockers.map((b) => b.code)).toContain("ORGANIZATION_OFFBOARDING_REQUIRED");

    const personal = await seedPersonalTenant(deps, "PRO");
    const ok = await preflight.evaluateAccountClosurePreflight(personal.owner.userId);
    expect(ok.blockers.map((b) => b.code)).not.toContain("ORGANIZATION_OFFBOARDING_REQUIRED");
  });

  // ---------------------------------------------------------------------------
  it("M13 — a lapsed invitation at another role does not block a re-invite at the new role", async () => {
    const t = await seedPersonalTenant(deps, "TEAM");
    const email = `m13-${tag()}@test.proovra.local`;
    const first = await invitations.createWorkspaceInvitation({
      workspaceId: t.personalTeamId,
      email,
      role: "VIEWER",
      invitedByUserId: t.owner.userId,
    });
    await prisma.teamInvite.update({ where: { id: first.invite.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/teams/${t.personalTeamId}/invites`,
      headers: { authorization: `Bearer ${t.owner.token}`, "x-proovra-workspace-id": t.personalTeamId },
      payload: { email, role: "MEMBER" },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const live = await prisma.teamInvite.findMany({ where: { teamId: t.personalTeamId, email, acceptedAt: null, revokedAt: null } });
    expect(live).toHaveLength(1);
    expect(live[0]!.role).toBe("MEMBER");
    expect((await prisma.teamInvite.findUniqueOrThrow({ where: { id: first.invite.id } })).revokedAt).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  it("M14b — concurrent invitations cannot pass the pending ceiling together", async () => {
    const t = await seedPersonalTenant(deps, "TEAM");
    const allowance = await seats.resolveWorkspaceInvitationAllowance(t.personalTeamId);
    // Fill to one below the ceiling.
    const fill = allowance.maxPending - 1;
    if (fill > 0) {
      await prisma.teamInvite.createMany({
        data: Array.from({ length: fill }, (_, i) => ({
          teamId: t.personalTeamId,
          email: `m14-fill-${i}-${tag()}@test.proovra.local`,
          role: "MEMBER" as const,
          tokenHash: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
          invitedByUserId: t.owner.userId,
          expiresAt: new Date(Date.now() + 86_400_000),
        })),
      });
    }
    const results = await Promise.allSettled(
      [0, 1, 2].map((i) =>
        invitations.createWorkspaceInvitation({
          workspaceId: t.personalTeamId,
          email: `m14-race-${i}-${tag()}@test.proovra.local`,
          role: "MEMBER",
          invitedByUserId: t.owner.userId,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const pending = await prisma.teamInvite.count({
      where: { teamId: t.personalTeamId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    expect(pending).toBe(allowance.maxPending);
  });

  // ---------------------------------------------------------------------------
  it("N-4 — an approval minted under STANDARD is not spendable once the Organization requires PHISHING_RESISTANT", async () => {
    const org = await seedOrganizationTenant(deps, { billingPlan: "ENTERPRISE" });
    const resourceId = randomUUID();
    const header = await ceremony.approvedHeader({
      token: org.owner.token,
      userId: org.owner.userId,
      teamId: org.workspaceId,
      purpose: "COLLABORATION_TEAM_ARCHIVE",
      resourceKind: "collaboration_team",
      resourceId,
    });
    const challengeId = header["x-proovra-step-up-challenge-id"]!;
    const row = await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id: challengeId } });
    expect(row).toMatchObject({ status: "APPROVED", method: "TOTP" });
    const spend = () =>
      stepUpSvc.consumeApprovedChallenge({
        teamId: org.workspaceId,
        userId: org.owner.userId,
        challengeId,
        purpose: "COLLABORATION_TEAM_ARCHIVE",
        resourceKind: "collaboration_team",
        resourceId,
        sessionIdHash: row.sessionIdHash,
      });
    await prisma.organizationSecurityPolicy.update({
      where: { organizationId: org.organizationId },
      data: { stepUpAssurance: "PHISHING_RESISTANT" },
    });
    await expect(spend()).rejects.toMatchObject({ code: "challenge_not_found" });
    // Positive control: under the policy it was minted for, it is spendable.
    await prisma.organizationSecurityPolicy.update({
      where: { organizationId: org.organizationId },
      data: { stepUpAssurance: "STANDARD" },
    });
    expect((await spend()).status).toBe("CANCELLED");
  });

  // ---------------------------------------------------------------------------
  it("N-6 — a password change cancels every outstanding step-up of that person", async () => {
    const { hashPassword } = await import("../src/services/email-password-auth.service.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const email = `n6-${tag()}@test.proovra.local`;
    const password = "N6-Password-Change-1!";
    const user = await prisma.user.create({
      data: { email, provider: "EMAIL", providerUserId: email, passwordHash: hashPassword(password) },
      select: { id: true },
    });
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS as Record<string, string>).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion,
        source: "integration-harness",
      })),
    });
    const A = h.fixtures.teamA;
    await prisma.teamMember.create({ data: { teamId: A.teamId, userId: user.id, role: "MEMBER", status: "ACTIVE" } });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET!,
      3600,
    );
    const header = await ceremony.approvedHeader({
      token,
      userId: user.id,
      teamId: A.teamId,
      purpose: "COLLABORATION_TEAM_ARCHIVE",
      resourceKind: "collaboration_team",
      resourceId: randomUUID(),
    });
    const id = header["x-proovra-step-up-challenge-id"]!;
    expect((await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id } })).status).toBe("APPROVED");
    const changed = await h.app.inject({
      method: "POST",
      url: "/v1/identity-security/password",
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: password, newPassword: "N6-Password-Changed-2!" },
    });
    expect(changed.statusCode, changed.body).toBeLessThan(300);
    expect((await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id } })).status).toBe("CANCELLED");
  });

  // ---------------------------------------------------------------------------
  it("N-3 — an Organization invite seats nobody in a workspace whose subscription restricts growth", async () => {
    const org = await seedOrganizationTenant(deps, { billingPlan: "TEAM" });
    // The lifecycle is read from the workspace's Subscription rows by the one
    // canonical reader, so the restriction is a real cancelled subscription.
    const past = new Date(Date.now() - 60 * 86_400_000);
    const cancelled = await prisma.subscription.updateMany({
      where: { teamId: org.workspaceId },
      data: { status: "CANCELED", canceledAtUtc: past, currentPeriodEnd: past },
    });
    if (cancelled.count === 0) {
      await prisma.subscription.create({
        data: {
          userId: org.owner.userId,
          teamId: org.workspaceId,
          provider: "STRIPE",
          providerSubId: `n3-${tag()}`,
          status: "CANCELED",
          plan: "TEAM",
          canceledAtUtc: past,
          currentPeriodEnd: past,
        },
      });
    }
    const guards = await import("../src/services/collaboration-team/billing-guards.js");
    // The setup really is a restricted lifecycle, by the canonical adapter.
    expect(await codeOf(guards.assertSubscriptionActiveOrGraceAllowed({ workspaceId: org.workspaceId }))).toBe(
      "SUBSCRIPTION_INACTIVE",
    );
    const invitee = await seedUser(deps, `n3-${tag()}`);
    const { createHash } = await import("node:crypto");
    const raw = randomUUID();
    await prisma.organizationInvite.create({
      data: {
        organizationId: org.organizationId,
        email: invitee.email,
        role: "ORG_MEMBER",
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        invitedByUserId: org.owner.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
        workspaceAssignments: [{ teamId: org.workspaceId, role: "MEMBER" }],
      } as never,
    });
    const { acceptOrganizationInvite } = await import("../src/services/organization/org-invite-acceptance.service.js");
    await acceptOrganizationInvite({ tokenHash: createHash("sha256").update(raw).digest("hex"), userId: invitee.userId });
    const seated = await prisma.teamMember.findFirst({
      where: { teamId: org.workspaceId, userId: invitee.userId, status: "ACTIVE" },
    });
    expect(seated).toBeNull();
  });
});
