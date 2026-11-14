/**
 * FREE-USER AUDIT REMEDIATION — slice E (identity & invitations), 2026-11-13.
 *
 * Real routes and services on a real PostgreSQL (testcontainers harness):
 *
 *   F-08  organization invitations are a CUSTOMER-organization surface. The
 *         SYSTEM organization every account owns (as ORG_OWNER) behind its
 *         Personal workspace is refused on single, bulk, CSV and resend — and
 *         a refusal writes no invitation row, no delivery row and sends no
 *         email. A customer organization still invites; its pending ceiling
 *         refuses a request that does not fit, whole.
 *   F-19  a REVOKED member re-invited at another role returns at the INVITED
 *         role (persisted role, effective permissions and response agree); an
 *         ACTIVE member's role is never changed by an invitation; a SUSPENDED
 *         member is not revived; replay is idempotent; the revived member
 *         takes a seat.
 *   F-20  `noPersonalSpace` binds only an EFFECTIVE (ACTIVE, unexpired)
 *         membership; a managed identity stays restricted (AUD-0047).
 *   F-16  removal ends the account's sessions (preserved security decision),
 *         and a new session is still refused the workspace while Personal works.
 *   F-15  integration API keys honour INTEGRATION_API_KEYS_MAX and webhook
 *         endpoints require FEATURE_WEBHOOKS, with Enterprise as the positive
 *         control and an existing key still authenticating.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getPlanCapabilities } from "@proovra/shared-billing";
import { mapTeamRoleToCanonical, roleHasPermission } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

// The ONE provider call organization invitations make. Recorded, never sent.
const sent = vi.hoisted(() => ({ to: [] as string[] }));
vi.mock("../src/services/email.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/email.service.js")>();
  return {
    ...actual,
    sendCustomEmailViaResend: async (input: { to: string }) => {
      sent.to.push(input.to);
      return { ok: false, errorCode: "not_configured", errorMessage: "recorded by test" };
    },
  };
});

type Prisma = import("@prisma/client").PrismaClient;

describe("slice E — identity & invitations (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let invitations: typeof import("../src/services/identity/workspace-invitation.service.js");
  let identityMode: typeof import("../src/services/identity/identity-mode.service.js");
  let rbac: typeof import("../src/services/identity/rbac.service.js");
  let seats: typeof import("../src/services/billing/workspace-seats.service.js");
  let legalVersions: Record<string, string>;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let systemOrgId: string;
  let orgAId: string;
  let orgBId: string;
  const A = () => h.fixtures.teamA;
  const B = () => h.fixtures.teamB;
  const P = () => h.fixtures.personal;

  beforeAll(async () => {
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = process.env.API_KEY_SECRET ?? "ef".repeat(32);
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    ({ signJwt } = await import("../src/services/jwt.js"));
    invitations = await import("../src/services/identity/workspace-invitation.service.js");
    identityMode = await import("../src/services/identity/identity-mode.service.js");
    rbac = await import("../src/services/identity/rbac.service.js");
    seats = await import("../src/services/billing/workspace-seats.service.js");
    legalVersions = (await import("../src/legal/legal-versioning.js")).REQUIRED_LEGAL_VERSIONS as Record<string, string>;
    stepUp = createStepUpCeremony({ prisma, inject: h.app.inject.bind(h.app) as never });

    // Workspace invitations are a plan capability; the harness default holds none.
    await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    // Workspace B is an Enterprise customer with an ACTIVE contract: the paid positive control.
    await prisma.team.update({ where: { id: B().teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
    orgAId = (await prisma.team.findUniqueOrThrow({ where: { id: A().teamId } })).organizationId!;
    orgBId = (await prisma.team.findUniqueOrThrow({ where: { id: B().teamId } })).organizationId!;
    const { upsertEnterpriseContract } = await import("../src/services/organization/enterprise-contract.service.js");
    await upsertEnterpriseContract(prisma as never, { organizationId: orgBId, status: "ACTIVE", activationState: "ACTIVATED", seatCount: 25 });
    systemOrgId = (await prisma.team.findUniqueOrThrow({ where: { id: P().teamId } })).organizationId!;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const code = (res: { json: () => unknown }) => {
    const b = res.json() as { code?: string; error?: { code?: string } };
    return b.error?.code ?? b.code;
  };

  async function user(email: string, opts: { verified?: boolean } = {}) {
    const u = await prisma.user.create({
      data: {
        email,
        firstName: "E",
        lastName: "Slice",
        provider: "EMAIL",
        providerUserId: email,
        emailVerifiedAt: opts.verified === false ? null : new Date(),
      },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(legalVersions).map(([policyKey, policyVersion]) => ({
        userId: u.id,
        policyKey,
        policyVersion,
        source: "integration-harness",
      })),
    });
    return { id: u.id, email, token: token(u.id, email) };
  }

  function token(userId: string, email: string) {
    return signJwt(
      { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
  }

  // ===========================================================================
  // F-08
  // ===========================================================================
  describe("F-08 — organization invitations need a customer organization", () => {
    const deliveriesTo = (emails: string[]) =>
      prisma.notificationDelivery.count({ where: { eventType: "org_invite_delivery", recipient: { in: emails } } });

    it("a Free account's SYSTEM organization is refused single, bulk, CSV and resend — no row, no delivery, no email", async () => {
      // The precondition the audit found: the personal bootstrap made this
      // account ORG_OWNER of a SYSTEM organization.
      const org = await prisma.organization.findUniqueOrThrow({ where: { id: systemOrgId }, select: { kind: true } });
      expect(org.kind).toBe("SYSTEM");
      const owner = await prisma.organizationMembership.findFirstOrThrow({
        where: { organizationId: systemOrgId, userId: P().userId },
      });
      expect(owner.role).toBe("ORG_OWNER");

      const emails = [`f08-a-${tag()}@victim.test`, `f08-b-${tag()}@victim.test`];
      const single = await h.app.inject({
        method: "POST",
        url: `/v1/orgs/${systemOrgId}/invites`,
        headers: bearer(P().token),
        payload: { email: emails[0] },
      });
      expect(single.statusCode, single.body).toBe(403);
      const bulk = await h.app.inject({
        method: "POST",
        url: `/v1/orgs/${systemOrgId}/invites/bulk`,
        headers: bearer(P().token),
        payload: { rows: emails.map((email) => ({ email })) },
      });
      expect(bulk.statusCode, bulk.body).toBe(403);
      const dry = await h.app.inject({
        method: "POST",
        url: `/v1/orgs/${systemOrgId}/invites/bulk/validate`,
        headers: bearer(P().token),
        payload: { rows: emails.map((email) => ({ email })) },
      });
      expect(dry.statusCode, dry.body).toBe(403);
      const csv = await h.app.inject({
        method: "POST",
        url: `/v1/orgs/${systemOrgId}/invites/csv`,
        headers: bearer(P().token),
        payload: { csv: `email\n${emails.join("\n")}\n` },
      });
      expect(csv.statusCode, csv.body).toBe(403);

      // A row that exists (written before the fix) cannot be re-sent either.
      const legacy = await prisma.organizationInvite.create({
        data: {
          organizationId: systemOrgId,
          email: `f08-legacy-${tag()}@victim.test`,
          role: "ORG_MEMBER",
          tokenHash: randomBytes(32).toString("hex"),
          invitedByUserId: P().userId,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      const resend = await h.app.inject({
        method: "POST",
        url: `/v1/orgs/${systemOrgId}/invites/${legacy.id}/resend`,
        headers: bearer(P().token),
        payload: {},
      });
      expect(resend.statusCode, resend.body).toBe(403);
      const bulkResend = await h.app.inject({
        method: "POST",
        url: `/v1/orgs/${systemOrgId}/invites/bulk/resend`,
        headers: bearer(P().token),
        payload: { inviteIds: [legacy.id] },
      });
      expect(bulkResend.statusCode, bulkResend.body).toBe(403);

      await h.handlersSettled();
      expect(await prisma.organizationInvite.count({ where: { organizationId: systemOrgId, email: { in: emails } } })).toBe(0);
      expect(await deliveriesTo([...emails, legacy.email])).toBe(0);
      expect(sent.to.filter((t) => emails.includes(t) || t === legacy.email)).toEqual([]);
      expect((await prisma.organizationInvite.findUniqueOrThrow({ where: { id: legacy.id } })).resendCount).toBe(legacy.resendCount);
    });

    it("control: a customer organization's owner still invites, and the delivery is attempted", async () => {
      const email = `f08-ok-${tag()}@invitee.test`;
      const res = await h.app.inject({
        method: "POST",
        url: `/v1/orgs/${orgAId}/invites`,
        headers: bearer(A().ownerToken),
        payload: { email },
      });
      expect(res.statusCode, res.body).toBe(201);
      await h.handlersSettled();
      expect(await prisma.organizationInvite.count({ where: { organizationId: orgAId, email } })).toBe(1);
      expect(await deliveriesTo([email])).toBe(1);
      expect(sent.to).toContain(email);
    });

    it("a customer organization at its pending ceiling is refused single and bulk, whole, before any write", async () => {
      const caps = getPlanCapabilities("ENTERPRISE");
      const pendingNow = await prisma.organizationInvite.count({
        where: { organizationId: orgAId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      });
      const filler = Array.from({ length: caps.maxPendingInvitesPerTeam - pendingNow - 1 }, (_, i) => ({
        organizationId: orgAId,
        email: `f08-fill-${i}-${tag()}@invitee.test`,
        role: "ORG_MEMBER" as const,
        tokenHash: randomBytes(32).toString("hex"),
        invitedByUserId: A().ownerUserId,
        expiresAt: new Date(Date.now() + 86_400_000),
        // Outside the 24-hour window, so only the pending ceiling is at stake.
        createdAt: new Date(Date.now() - 2 * 86_400_000),
      }));
      await prisma.organizationInvite.createMany({ data: filler });
      try {
        // One place left: a batch of two does not fit and writes nothing.
        const two = [`f08-cap-a-${tag()}@invitee.test`, `f08-cap-b-${tag()}@invitee.test`];
        const bulk = await h.app.inject({
          method: "POST",
          url: `/v1/orgs/${orgAId}/invites/bulk`,
          headers: bearer(A().ownerToken),
          payload: { rows: two.map((email) => ({ email })) },
        });
        expect(bulk.statusCode, bulk.body).toBe(409);
        expect(code(bulk)).toBe("ORG_INVITE_LIMIT_REACHED");
        expect(await prisma.organizationInvite.count({ where: { email: { in: two } } })).toBe(0);
        expect(await deliveriesTo(two)).toBe(0);

        // The last place is admitted; the next single invitation is refused.
        const last = await h.app.inject({
          method: "POST",
          url: `/v1/orgs/${orgAId}/invites`,
          headers: bearer(A().ownerToken),
          payload: { email: two[0] },
        });
        expect(last.statusCode, last.body).toBe(201);
        const over = await h.app.inject({
          method: "POST",
          url: `/v1/orgs/${orgAId}/invites`,
          headers: bearer(A().ownerToken),
          payload: { email: two[1] },
        });
        expect(over.statusCode, over.body).toBe(409);
        expect(code(over)).toBe("ORG_INVITE_LIMIT_REACHED");
        await h.handlersSettled();
        expect(await prisma.organizationInvite.count({ where: { email: two[1] } })).toBe(0);
        expect(sent.to).not.toContain(two[1]);
      } finally {
        await prisma.organizationInvite.deleteMany({ where: { organizationId: orgAId, email: { startsWith: "f08-" } } });
      }
    });
  });

  // ===========================================================================
  // F-19
  // ===========================================================================
  describe("F-19 — an ended membership returns at the invited role", () => {
    async function memberRow(userId: string) {
      return prisma.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: A().teamId, userId } } });
    }
    async function inviteAndAccept(email: string, role: "ADMIN" | "MEMBER" | "VIEWER", actor: { id: string; token: string }) {
      const created = await invitations.createWorkspaceInvitation({
        workspaceId: A().teamId,
        email,
        role,
        invitedByUserId: A().ownerUserId,
      });
      const res = await h.app.inject({
        method: "POST",
        url: `/v1/teams/invites/${created.rawToken}/accept`,
        headers: bearer(actor.token),
      });
      return { res, rawToken: created.rawToken };
    }
    async function removed(role: "ADMIN" | "VIEWER") {
      const email = `f19-${tag()}@invitee.test`;
      const person = await user(email);
      const row = await prisma.teamMember.create({
        data: { teamId: A().teamId, userId: person.id, role, status: "ACTIVE" },
      });
      // Removed through the real lifecycle owner (row kept as REVOKED, role kept as history).
      await rbac.revokeMember({ teamId: A().teamId, teamMemberId: row.id, actorUserId: A().ownerUserId, reason: "test" });
      expect((await memberRow(person.id)).status).toBe("REVOKED");
      // Sessions were ended by the removal; the person signs in again.
      await new Promise((r) => setTimeout(r, 1100));
      return { ...person, token: token(person.id, email) };
    }

    it("a removed ADMIN re-invited as VIEWER is a VIEWER: persisted, effective and reported alike", async () => {
      const person = await removed("ADMIN");
      const usedBefore = (await seats.resolveWorkspaceSeatState(A().teamId)).used;
      const { res } = await inviteAndAccept(person.email, "VIEWER", person);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ role: "VIEWER", alreadyMember: false });
      const row = await memberRow(person.id);
      expect(row).toMatchObject({ status: "ACTIVE", role: "VIEWER", revokedAtUtc: null });
      // Effective permissions follow the persisted role.
      expect(roleHasPermission(mapTeamRoleToCanonical(row.role), "evidence.create")).toBe(false);
      // An ADMIN capability is refused through the real route.
      const adminAct = await h.app.inject({
        method: "POST",
        url: `/v1/teams/${A().teamId}/invites`,
        headers: bearer(person.token),
        payload: { email: `f19-probe-${tag()}@invitee.test`, role: "VIEWER" },
      });
      expect(adminAct.statusCode, adminAct.body).toBeGreaterThanOrEqual(403);
      expect(adminAct.statusCode).toBeLessThan(500);
      // The audit row states the role that was persisted.
      const audit = await prisma.adminAuditLog.findFirst({
        where: { userId: person.id, action: "teams.invite_accept", outcome: "success" },
        orderBy: { createdAt: "desc" },
      });
      expect((audit?.metadata as { role?: string } | null)?.role).toBe("VIEWER");
      // The revived member takes a seat.
      expect((await seats.resolveWorkspaceSeatState(A().teamId)).used).toBe(usedBefore + 1);
    });

    it("a removed VIEWER re-invited as MEMBER can capture again", async () => {
      const person = await removed("VIEWER");
      const { res } = await inviteAndAccept(person.email, "MEMBER", person);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ role: "MEMBER" });
      const row = await memberRow(person.id);
      expect(row.role).toBe("MEMBER");
      expect(roleHasPermission(mapTeamRoleToCanonical(row.role), "evidence.create")).toBe(true);
    });

    it("an ACTIVE ADMIN accepting a VIEWER invitation keeps ADMIN, and the response says ADMIN; a replay changes nothing", async () => {
      const email = `f19-active-${tag()}@invitee.test`;
      const person = await user(email);
      await prisma.teamMember.create({ data: { teamId: A().teamId, userId: person.id, role: "ADMIN", status: "ACTIVE" } });
      const { res, rawToken } = await inviteAndAccept(email, "VIEWER", person);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ role: "ADMIN", alreadyMember: true });
      expect((await memberRow(person.id)).role).toBe("ADMIN");
      const replay = await h.app.inject({
        method: "POST",
        url: `/v1/teams/invites/${rawToken}/accept`,
        headers: bearer(person.token),
      });
      // The consumed invitation is not a second grant.
      expect([200, 409]).toContain(replay.statusCode);
      expect((await memberRow(person.id))).toMatchObject({ role: "ADMIN", status: "ACTIVE" });
    });

    it("a SUSPENDED member is not revived by an invitation, and keeps the held role", async () => {
      const email = `f19-susp-${tag()}@invitee.test`;
      const person = await user(email);
      await prisma.teamMember.create({ data: { teamId: A().teamId, userId: person.id, role: "ADMIN", status: "SUSPENDED" } });
      const { res } = await inviteAndAccept(email, "VIEWER", person);
      expect(res.statusCode, res.body).toBe(409);
      expect(code(res)).toBe("MEMBERSHIP_SUSPENDED");
      expect(await memberRow(person.id)).toMatchObject({ role: "ADMIN", status: "SUSPENDED" });
    });

    it("a revived member's invitation replay is idempotent at the invited role", async () => {
      const person = await removed("ADMIN");
      const { res, rawToken } = await inviteAndAccept(person.email, "MEMBER", person);
      expect(res.statusCode, res.body).toBe(200);
      const again = await h.app.inject({
        method: "POST",
        url: `/v1/teams/invites/${rawToken}/accept`,
        headers: bearer(person.token),
      });
      expect([200, 409]).toContain(again.statusCode);
      if (again.statusCode === 200) expect(again.json()).toMatchObject({ role: "MEMBER", alreadyMember: true });
      expect((await memberRow(person.id))).toMatchObject({ role: "MEMBER", status: "ACTIVE" });
      expect(await prisma.teamMember.count({ where: { teamId: A().teamId, userId: person.id } })).toBe(1);
    });

    it("an unverified address is refused EMAIL_NOT_VERIFIED and nothing is written", async () => {
      const email = `f19-unverified-${tag()}@invitee.test`;
      const person = await user(email, { verified: false });
      const { res } = await inviteAndAccept(email, "MEMBER", person);
      expect(res.statusCode, res.body).toBe(403);
      expect(code(res)).toBe("EMAIL_NOT_VERIFIED");
      expect(await prisma.teamMember.count({ where: { teamId: A().teamId, userId: person.id } })).toBe(0);
    });
  });

  // ===========================================================================
  // F-16
  // ===========================================================================
  describe("F-16 — removal ends the sessions; a new session is still refused the workspace", () => {
    it("the old token is dead, a new token is refused the workspace, and Personal still works", async () => {
      const email = `f16-${tag()}@invitee.test`;
      const person = await user(email);
      const row = await prisma.teamMember.create({ data: { teamId: A().teamId, userId: person.id, role: "MEMBER", status: "ACTIVE" } });
      await prisma.user.update({ where: { id: person.id }, data: { currentWorkspaceId: A().teamId } });
      const okBefore = await h.app.inject({
        method: "GET",
        url: `/v1/evidence/${A().evidenceId}`,
        headers: { ...bearer(person.token), "x-proovra-workspace-id": A().teamId },
      });
      expect(okBefore.statusCode, okBefore.body).toBe(200);

      await rbac.revokeMember({ teamId: A().teamId, teamMemberId: row.id, actorUserId: A().ownerUserId, reason: "test" });

      // The preserved security decision: every session of the account ended.
      const old = await h.app.inject({ method: "GET", url: "/v1/platform/context", headers: bearer(person.token) });
      expect(old.statusCode, old.body).toBe(401);

      await new Promise((r) => setTimeout(r, 1100));
      const fresh = token(person.id, email);
      const denied = await h.app.inject({
        method: "GET",
        url: `/v1/evidence/${A().evidenceId}`,
        headers: { ...bearer(fresh), "x-proovra-workspace-id": A().teamId },
      });
      expect([403, 404]).toContain(denied.statusCode);
      const switchBack = await h.app.inject({
        method: "POST",
        url: "/v1/platform/context/switch-workspace",
        headers: bearer(fresh),
        payload: { workspaceId: A().teamId },
      });
      expect(switchBack.statusCode, switchBack.body).toBe(403);
      // Return to Personal: the pointer was cleared and the context lands in Personal.
      const ctx = await h.app.inject({ method: "GET", url: "/v1/platform/context", headers: bearer(fresh) });
      expect(ctx.statusCode, ctx.body).toBe(200);
      expect((ctx.json() as { workspace: { workspaceKind: string; id: string } }).workspace.workspaceKind).toBe("PERSONAL");
    });
  });

  // ===========================================================================
  // F-20
  // ===========================================================================
  describe("F-20 — noPersonalSpace binds only an effective membership", () => {
    beforeAll(async () => {
      await prisma.organizationSecurityPolicy.updateMany({ where: { organizationId: orgBId }, data: { noPersonalSpace: true } });
    });
    afterAll(async () => {
      await prisma.organizationSecurityPolicy.updateMany({ where: { organizationId: orgBId }, data: { noPersonalSpace: false } });
    });

    async function memberOfB(status: "ACTIVE" | "SUSPENDED" | "REVOKED", validUntilUtc: Date | null = null) {
      const person = await user(`f20-${status.toLowerCase()}-${tag()}@invitee.test`);
      await prisma.organizationMembership.create({
        data: {
          organizationId: orgBId,
          userId: person.id,
          role: "ORG_MEMBER",
          status,
          validUntilUtc,
          ...(status === "SUSPENDED" ? { suspendedAtUtc: new Date() } : {}),
          ...(status === "REVOKED" ? { revokedAtUtc: new Date() } : {}),
        },
      });
      return person;
    }

    it("ACTIVE is restricted; SUSPENDED, REVOKED (removed or left) and lapsed are not", async () => {
      const active = await memberOfB("ACTIVE");
      expect(await identityMode.resolvePersonalSpaceEligibility(active.id)).toMatchObject({ allowed: false, reason: "ORG_POLICY" });
      for (const person of [
        await memberOfB("SUSPENDED"),
        await memberOfB("REVOKED"),
        await memberOfB("ACTIVE", new Date(Date.now() - 60_000)),
      ]) {
        expect(await identityMode.resolvePersonalSpaceEligibility(person.id)).toEqual({ allowed: true });
      }
    });

    it("through the switch route: a former member returns to Personal; a current member is still refused", async () => {
      const former = await memberOfB("REVOKED");
      const back = await h.app.inject({
        method: "POST",
        url: "/v1/platform/context/switch-workspace",
        headers: bearer(former.token),
        payload: { workspaceId: null },
      });
      expect(back.statusCode, back.body).toBe(200);
      const current = await memberOfB("ACTIVE");
      const refused = await h.app.inject({
        method: "POST",
        url: "/v1/platform/context/switch-workspace",
        headers: bearer(current.token),
        payload: { workspaceId: null },
      });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(code(refused)).toBe("ORG_POLICY_NO_PERSONAL_SPACE");
    });

    it("a managed identity stays restricted whatever its membership status (AUD-0047)", async () => {
      const managed = await memberOfB("REVOKED");
      await prisma.user.update({
        where: { id: managed.id },
        data: { identityMode: "MANAGED_ENTERPRISE", managingOrganizationId: orgBId } as never,
      });
      const v = await identityMode.resolvePersonalSpaceEligibility(managed.id);
      expect(v).toMatchObject({ allowed: false, reason: "MANAGED_IDENTITY" });
    });
  });

  // ===========================================================================
  // F-15
  // ===========================================================================
  describe("F-15 — integration keys and webhooks follow the packaging entitlements", () => {
    const createKey = async (teamId: string, ownerId: string, ownerToken: string, scopes = ["integration.evidence.read"]) => {
      const header = await stepUp.approvedHeader({
        token: ownerToken,
        userId: ownerId,
        teamId,
        purpose: "INTEGRATION_API_KEY_CREATE",
        resourceKind: "team",
        resourceId: teamId,
      });
      return h.app.inject({
        method: "POST",
        url: "/v1/integrations/api-keys",
        headers: { ...bearer(ownerToken), ...header },
        payload: { teamId, name: `key ${tag()}`, scopes },
      });
    };

    it("a Free Personal workspace gets its default single key; the second is refused and writes nothing", async () => {
      const first = await createKey(P().teamId, P().userId, P().token);
      expect(first.statusCode, first.body).toBe(201);
      const raw = (first.json() as { rawKey: string }).rawKey;
      const second = await createKey(P().teamId, P().userId, P().token);
      expect(second.statusCode, second.body).toBe(429);
      expect(code(second)).toBe("api_key_limit_reached");
      expect(await prisma.apiCredential.count({ where: { teamId: P().teamId, status: "ACTIVE" } })).toBe(1);
      // The existing key still authenticates (no running integration is broken).
      const use = await h.app.inject({ method: "GET", url: "/v1/integrations/api/evidence", headers: bearer(raw) });
      expect(use.statusCode, use.body).not.toBe(401);
      // Revoking frees the place: the count is of ACTIVE keys.
      await prisma.apiCredential.updateMany({ where: { teamId: P().teamId }, data: { status: "REVOKED", revokedAtUtc: new Date() } });
      const third = await createKey(P().teamId, P().userId, P().token);
      expect(third.statusCode, third.body).toBe(201);
    });

    it("a Free Personal workspace cannot create a webhook endpoint (before any step-up), and an existing one stays listed", async () => {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/integrations/webhooks",
        headers: bearer(P().token),
        payload: { teamId: P().teamId, url: "https://203.0.113.10/hook" },
      });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({ denial: "ENTITLEMENT_REQUIRED", key: "FEATURE_WEBHOOKS" });
      expect(await prisma.webhookEndpoint.count({ where: { teamId: P().teamId } })).toBe(0);

      const { createWebhookEndpoint } = await import("../src/services/integrations/webhooks.service.js");
      const existing = await createWebhookEndpoint({
        teamId: P().teamId,
        url: `https://203.0.113.10/existing/${tag()}`,
        eventTypes: [],
        description: null,
        actorUserId: P().userId,
      });
      const list = await h.app.inject({
        method: "GET",
        url: `/v1/integrations/webhooks?teamId=${P().teamId}`,
        headers: bearer(P().token),
      });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.body).toContain(existing.endpoint.id);
    });

    it("control: an Enterprise workspace with an ACTIVE contract creates several keys and a webhook endpoint", async () => {
      for (let i = 0; i < 3; i += 1) {
        const res = await createKey(B().teamId, B().ownerUserId, B().ownerToken);
        expect(res.statusCode, res.body).toBe(201);
      }
      const header = await stepUp.approvedHeader({
        token: B().ownerToken,
        userId: B().ownerUserId,
        teamId: B().teamId,
        purpose: "INTEGRATION_WEBHOOK_CREATE",
        resourceKind: "team",
        resourceId: B().teamId,
      });
      const hook = await h.app.inject({
        method: "POST",
        url: "/v1/integrations/webhooks",
        headers: { ...bearer(B().ownerToken), ...header },
        payload: { teamId: B().teamId, url: `https://203.0.113.10/ent/${tag()}` },
      });
      expect(hook.statusCode, hook.body).toBe(201);
    });

    it("an Owned non-contract workspace member cannot reach another workspace's keys (scope unchanged)", async () => {
      const res = await createKey(A().teamId, A().ownerUserId, A().ownerToken);
      // teamA has no contract and no product line: the default single key.
      expect(res.statusCode, res.body).toBe(201);
      const cross = await h.app.inject({
        method: "GET",
        url: `/v1/integrations/api-keys?teamId=${B().teamId}`,
        headers: bearer(A().ownerToken),
      });
      expect(cross.statusCode).toBe(404);
    });
  });
});
