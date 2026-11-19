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
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  let orgLifecycle: typeof import("../src/services/identity/org-membership-lifecycle.service.js");
  let orgAccess: typeof import("../src/services/organization/org-access.js");
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
    orgLifecycle = await import("../src/services/identity/org-membership-lifecycle.service.js");
    orgAccess = await import("../src/services/organization/org-access.js");
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
  // B-03 — the organization invitation path follows the same revival rules
  // ===========================================================================
  describe("B-03 — an organization re-invite revives a removed membership at the invited role", () => {
    async function orgMember(status: "REVOKED" | "SUSPENDED") {
      const email = `b03-${tag()}@invitee.test`;
      const person = await user(email);
      const { revokeOrganizationMembership, suspendOrganizationMembership } = orgLifecycle;
      const row = await prisma.organizationMembership.create({
        data: { organizationId: orgAId, userId: person.id, role: "ORG_ADMIN" },
      });
      const move = status === "REVOKED" ? revokeOrganizationMembership : suspendOrganizationMembership;
      const moved = await move({
        prisma: prisma as never,
        organizationId: orgAId,
        membershipId: row.id,
        actorUserId: A().ownerUserId,
        source: "MANUAL",
        reason: "b03",
      });
      expect(moved.ok).toBe(true);
      return { ...person, membershipId: row.id };
    }
    async function invite(email: string, createdAt: Date) {
      const raw = randomBytes(32).toString("hex");
      const row = await prisma.organizationInvite.create({
        data: {
          organizationId: orgAId,
          email,
          role: "ORG_MEMBER",
          tokenHash: createHash("sha256").update(raw, "utf8").digest("hex"),
          invitedByUserId: A().ownerUserId,
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
          createdAt,
        },
      });
      return { raw, id: row.id };
    }
    const accept = (raw: string, person: { token: string }) =>
      h.app.inject({ method: "POST", url: `/v1/org-invites/${raw}/accept`, headers: bearer(person.token) });
    const membership = (id: string) =>
      prisma.organizationMembership.findUniqueOrThrow({ where: { id }, select: { status: true, role: true } });

    it("an invitation issued after the removal reactivates the REVOKED membership at the invited role", async () => {
      const person = await orgMember("REVOKED");
      const { revokedAtUtc } = await prisma.organizationMembership.findUniqueOrThrow({ where: { id: person.membershipId } });
      const inv = await invite(person.email, new Date(revokedAtUtc!.getTime() + 1000));
      const res = await accept(inv.raw, person);
      expect(res.statusCode, res.body).toBe(200);
      expect(await membership(person.membershipId)).toEqual({ status: "ACTIVE", role: "ORG_MEMBER" });
      expect(await prisma.organizationMembership.count({ where: { organizationId: orgAId, userId: person.id } })).toBe(1);
      expect((await orgAccess.checkOrgAccess(prisma as never, { orgId: orgAId, userId: person.id })).kind).toBe("ok");
    });

    it("an invitation issued before the removal is refused INVITE_SUPERSEDED and nothing commits", async () => {
      const email = `b03-pre-${tag()}@invitee.test`;
      const inv = await invite(email, new Date(Date.now() - 60_000));
      const person = await user(email);
      const row = await prisma.organizationMembership.create({
        data: { organizationId: orgAId, userId: person.id, role: "ORG_ADMIN" },
      });
      await orgLifecycle.revokeOrganizationMembership({
        prisma: prisma as never,
        organizationId: orgAId,
        membershipId: row.id,
        actorUserId: A().ownerUserId,
        source: "MANUAL",
      });
      const res = await accept(inv.raw, person);
      expect(res.statusCode, res.body).toBe(409);
      expect(code(res)).toBe("INVITE_SUPERSEDED");
      expect(await membership(row.id)).toEqual({ status: "REVOKED", role: "ORG_ADMIN" });
      expect((await prisma.organizationInvite.findUniqueOrThrow({ where: { id: inv.id } })).acceptedAt).toBeNull();
    });

    it("a SUSPENDED membership is not revived by an invitation and keeps its role", async () => {
      const person = await orgMember("SUSPENDED");
      const inv = await invite(person.email, new Date());
      const res = await accept(inv.raw, person);
      expect(res.statusCode, res.body).toBe(409);
      expect(code(res)).toBe("MEMBERSHIP_SUSPENDED");
      expect(await membership(person.membershipId)).toEqual({ status: "SUSPENDED", role: "ORG_ADMIN" });
      expect((await prisma.organizationInvite.findUniqueOrThrow({ where: { id: inv.id } })).acceptedAt).toBeNull();
    });
  });

  // ===========================================================================
  // B-15 / B-16 / B-17 (round 3)
  // ===========================================================================
  describe("B-15 / B-16 / B-17 — accept transport, refusal codes, leave by a removed member", () => {
    async function orgInvite(email: string, over: { expiresAt?: Date; revokedAt?: Date } = {}) {
      const raw = randomBytes(32).toString("hex");
      const row = await prisma.organizationInvite.create({
        data: {
          organizationId: orgAId,
          email,
          role: "ORG_MEMBER",
          tokenHash: createHash("sha256").update(raw, "utf8").digest("hex"),
          invitedByUserId: A().ownerUserId,
          expiresAt: over.expiresAt ?? new Date(Date.now() + 7 * 86_400_000),
          revokedAt: over.revokedAt ?? null,
        },
      });
      return { raw, id: row.id };
    }
    const acceptBody = (raw: string, person: { token: string }) =>
      h.app.inject({
        method: "POST",
        url: "/v1/org-invites/accept",
        headers: { ...bearer(person.token), "content-type": "application/json" },
        payload: { token: raw },
      });
    const orgRows = (userId: string) =>
      prisma.organizationMembership.findMany({ where: { organizationId: orgAId, userId }, select: { status: true, role: true } });
    const accepted = async (id: string) => (await prisma.organizationInvite.findUniqueOrThrow({ where: { id } })).acceptedAt;

    it("B-15: the organization accept takes the token in the body; the path form still accepts (compatibility)", async () => {
      const a = await user(`b15-org-${tag()}@invitee.test`);
      const invA = await orgInvite(a.email);
      const res = await acceptBody(invA.raw, a);
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as { organizationId: string }).organizationId).toBe(orgAId);
      expect(await orgRows(a.id)).toEqual([{ status: "ACTIVE", role: "ORG_MEMBER" }]);
      expect(await accepted(invA.id)).not.toBeNull();

      // A link already sent to an app build that still uses the path.
      const b = await user(`b15-org-legacy-${tag()}@invitee.test`);
      const invB = await orgInvite(b.email);
      const legacy = await h.app.inject({ method: "POST", url: `/v1/org-invites/${invB.raw}/accept`, headers: bearer(b.token) });
      expect(legacy.statusCode, legacy.body).toBe(200);
      expect(legacy.headers["referrer-policy"]).toBe("no-referrer");
      expect(await orgRows(b.id)).toEqual([{ status: "ACTIVE", role: "ORG_MEMBER" }]);

      // A body without a token is answered like an unknown token; nothing is written.
      const c = await user(`b15-org-empty-${tag()}@invitee.test`);
      const empty = await h.app.inject({
        method: "POST",
        url: "/v1/org-invites/accept",
        headers: { ...bearer(c.token), "content-type": "application/json" },
        payload: {},
      });
      expect(empty.statusCode).toBe(404);
      expect(code(empty)).toBe("INVITE_NOT_FOUND");
      expect(await orgRows(c.id)).toEqual([]);
    });

    it("B-15: the workspace accept takes the token in the body; the path form still accepts", async () => {
      const a = await user(`b15-ws-${tag()}@invitee.test`);
      const created = await invitations.createWorkspaceInvitation({
        workspaceId: A().teamId,
        email: a.email,
        role: "MEMBER",
        invitedByUserId: A().ownerUserId,
      });
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/teams/invites/accept",
        headers: { ...bearer(a.token), "content-type": "application/json" },
        payload: { token: created.rawToken },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as { workspaceId: string }).workspaceId).toBe(A().teamId);
      expect(
        (await prisma.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: A().teamId, userId: a.id } } })).status,
      ).toBe("ACTIVE");

      const b = await user(`b15-ws-legacy-${tag()}@invitee.test`);
      const createdB = await invitations.createWorkspaceInvitation({
        workspaceId: A().teamId,
        email: b.email,
        role: "VIEWER",
        invitedByUserId: A().ownerUserId,
      });
      const legacy = await h.app.inject({
        method: "POST",
        url: `/v1/teams/invites/${createdB.rawToken}/accept`,
        headers: bearer(b.token),
      });
      expect(legacy.statusCode, legacy.body).toBe(200);
      expect(legacy.headers["referrer-policy"]).toBe("no-referrer");

      const garbage = await h.app.inject({
        method: "POST",
        url: "/v1/teams/invites/accept",
        headers: { ...bearer(b.token), "content-type": "application/json" },
        payload: { token: 42 },
      });
      expect(garbage.statusCode).toBe(404);
      expect(code(garbage)).toBe("INVITE_NOT_FOUND");
    });

    it("B-16: each organization refusal names its code, and none of them writes a membership or consumes the invite", async () => {
      const other = await user(`b16-other-${tag()}@invitee.test`);
      const mismatch = await orgInvite(`b16-invited-${tag()}@invitee.test`);
      const r1 = await acceptBody(mismatch.raw, other);
      expect(r1.statusCode).toBe(403);
      expect(code(r1)).toBe("INVITE_EMAIL_MISMATCH");
      expect((r1.json() as { message?: string }).message).toBe("Invite email does not match your account.");
      expect(await accepted(mismatch.id)).toBeNull();

      const exp = await user(`b16-exp-${tag()}@invitee.test`);
      const expired = await orgInvite(exp.email, { expiresAt: new Date(Date.now() - 60_000) });
      const r2 = await acceptBody(expired.raw, exp);
      expect(r2.statusCode).toBe(410);
      expect(code(r2)).toBe("INVITE_EXPIRED");
      expect(await accepted(expired.id)).toBeNull();

      const rev = await user(`b16-rev-${tag()}@invitee.test`);
      const revoked = await orgInvite(rev.email, { revokedAt: new Date() });
      const r3 = await acceptBody(revoked.raw, rev);
      expect(r3.statusCode).toBe(410);
      expect(code(r3)).toBe("INVITE_REVOKED");

      const r4 = await acceptBody(randomBytes(32).toString("hex"), rev);
      expect(r4.statusCode).toBe(404);
      expect(code(r4)).toBe("INVITE_NOT_FOUND");

      for (const p of [other, exp, rev]) expect(await orgRows(p.id)).toEqual([]);
    });

    it("B-17: /leave by a member already removed is 404 and writes no ORG_MEMBER_LEFT; an ACTIVE member's leave writes exactly one", async () => {
      const removedPerson = await user(`b17-${tag()}@invitee.test`);
      const row = await prisma.organizationMembership.create({
        data: { organizationId: orgAId, userId: removedPerson.id, role: "ORG_MEMBER" },
      });
      const moved = await orgLifecycle.revokeOrganizationMembership({
        prisma: prisma as never,
        organizationId: orgAId,
        membershipId: row.id,
        actorUserId: A().ownerUserId,
        source: "MANUAL",
        reason: "b17",
      });
      expect(moved.ok).toBe(true);
      const leftEvents = (membershipId: string) =>
        prisma.organizationAuditEvent.count({
          where: { organizationId: orgAId, eventType: "ORG_MEMBER_LEFT", targetId: membershipId },
        });

      const res = await h.app.inject({ method: "POST", url: `/v1/orgs/${orgAId}/leave`, headers: bearer(removedPerson.token) });
      expect(res.statusCode, res.body).toBe(404);
      expect(code(res)).toBe("membership_not_found");
      expect(await leftEvents(row.id)).toBe(0);
      expect((await prisma.organizationMembership.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("REVOKED");

      // Control: an ACTIVE member leaves once; a second call is the same 404 and adds nothing.
      const active = await user(`b17-active-${tag()}@invitee.test`);
      const activeRow = await prisma.organizationMembership.create({
        data: { organizationId: orgAId, userId: active.id, role: "ORG_MEMBER" },
      });
      const left = await h.app.inject({ method: "POST", url: `/v1/orgs/${orgAId}/leave`, headers: bearer(active.token) });
      expect(left.statusCode, left.body).toBe(200);
      expect(await leftEvents(activeRow.id)).toBe(1);
      const again = await h.app.inject({ method: "POST", url: `/v1/orgs/${orgAId}/leave`, headers: bearer(active.token) });
      expect(again.statusCode).toBe(404);
      expect(await leftEvents(activeRow.id)).toBe(1);
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

      // PRO-T1-05 (DEC-08) — the removal ends EVERY session only for an identity the
      // Organization's directory originated; that person is seeded beside the independent one.
      const dirEmail = `f16-dir-${tag()}@invitee.test`;
      const dirPerson = await user(dirEmail);
      await prisma.user.update({ where: { id: dirPerson.id }, data: { providerUserId: `scim-${orgAId}:${dirEmail}` } });
      const dirRow = await prisma.teamMember.create({ data: { teamId: A().teamId, userId: dirPerson.id, role: "MEMBER", status: "ACTIVE" } });
      const dirBefore = await h.app.inject({ method: "GET", url: "/v1/platform/context", headers: bearer(dirPerson.token) });
      expect(dirBefore.statusCode, dirBefore.body).toBe(200);

      await rbac.revokeMember({ teamId: A().teamId, teamMemberId: row.id, actorUserId: A().ownerUserId, reason: "test" });
      await rbac.revokeMember({ teamId: A().teamId, teamMemberId: dirRow.id, actorUserId: A().ownerUserId, reason: "test" });

      // The preserved security decision: every session of the Organization-originated account ended.
      const old = await h.app.inject({ method: "GET", url: "/v1/platform/context", headers: bearer(dirPerson.token) });
      expect(old.statusCode, old.body).toBe(401);
      // PRO-T1-05 (DEC-08) — the independent account keeps its own session, and that
      // session is refused the workspace at the per-request membership evaluation.
      const kept = await h.app.inject({ method: "GET", url: "/v1/platform/context", headers: bearer(person.token) });
      expect(kept.statusCode, kept.body).toBe(200);
      expect((kept.json() as { workspace: { workspaceKind: string } }).workspace.workspaceKind).toBe("PERSONAL");
      const keptDenied = await h.app.inject({
        method: "GET",
        url: `/v1/evidence/${A().evidenceId}`,
        headers: { ...bearer(person.token), "x-proovra-workspace-id": A().teamId },
      });
      expect([403, 404]).toContain(keptDenied.statusCode);

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
      // PRO-A2-03 / DEC-07 — the policy governs accounts the Organization
      // originated; these people were created by its directory.
      await prisma.user.update({ where: { id: person.id }, data: { providerUserId: `scim-${orgBId}:${person.id}` } });
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

    it("A2-11 — a Free Personal workspace mints no key; a granted ceiling admits keys up to it; a key it holds outlives the grant", async () => {
      // Pricing: "Integrations & APIs — Not included" off Enterprise. The
      // unprovisioned default is 0 (it was 1, so every account minted one).
      const refused = await createKey(P().teamId, P().userId, P().token);
      expect(refused.statusCode, refused.body).toBe(429);
      expect(code(refused)).toBe("api_key_limit_reached");
      expect((refused.json() as { error: { details: { limit: number } } }).error.details.limit).toBe(0);
      expect(await prisma.apiCredential.count({ where: { teamId: P().teamId, status: "ACTIVE" } })).toBe(0);

      // A ceiling written for the workspace (as a product line writes one)
      // admits keys up to it, and no further.
      const { upsertEntitlementGrant } = await import("../src/services/packaging/entitlement.service.js");
      await upsertEntitlementGrant({
        teamId: P().teamId,
        key: "INTEGRATION_API_KEYS_MAX",
        value: 1,
        kind: "LIMIT",
        source: "CUSTOM",
        grantedByUserId: P().userId,
      });
      const first = await createKey(P().teamId, P().userId, P().token);
      expect(first.statusCode, first.body).toBe(201);
      const raw = (first.json() as { rawKey: string }).rawKey;
      const second = await createKey(P().teamId, P().userId, P().token);
      expect(second.statusCode, second.body).toBe(429);
      expect(await prisma.apiCredential.count({ where: { teamId: P().teamId, status: "ACTIVE" } })).toBe(1);

      // The grant ends (a downgrade): PRO-G1-14 / DEC-09 (WS-ENT) — the key
      // already issued is paused, not revoked (403 ENTITLEMENT_REQUIRED; it
      // works again when the entitlement returns) — and no new one is minted.
      await prisma.entitlementGrant.deleteMany({ where: { teamId: P().teamId, key: "INTEGRATION_API_KEYS_MAX" } });
      const use = await h.app.inject({ method: "GET", url: "/v1/integrations/api/evidence", headers: bearer(raw) });
      expect(use.statusCode, use.body).toBe(403);
      expect(use.json()).toMatchObject({ error: { code: "ENTITLEMENT_REQUIRED", key: "INTEGRATION_API_KEYS_MAX" } });
      expect(await prisma.apiCredential.count({ where: { teamId: P().teamId, status: "ACTIVE" } })).toBe(1);
      const third = await createKey(P().teamId, P().userId, P().token);
      expect(third.statusCode, third.body).toBe(429);
      expect(await prisma.apiCredential.count({ where: { teamId: P().teamId, status: "ACTIVE" } })).toBe(1);
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

      // An endpoint kept from an entitled past, seeded as stored: the service
      // create now applies the endpoint ceiling (PRO-G1-05, WS-ENT), which is 0 here.
      const existing = {
        endpoint: await prisma.webhookEndpoint.create({
          data: {
            teamId: P().teamId,
            url: `https://203.0.113.10/existing/${tag()}`,
            status: "ACTIVE",
            secretCiphertext: "x",
            secretPrefix: "whsec_ex",
            eventTypes: [],
            createdByUserId: P().userId,
          },
        }),
      };
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
      // teamA has no contract and no product line: no key (A2-11 default 0).
      expect(res.statusCode, res.body).toBe(429);
      expect(code(res)).toBe("api_key_limit_reached");
      const cross = await h.app.inject({
        method: "GET",
        url: `/v1/integrations/api-keys?teamId=${B().teamId}`,
        headers: bearer(A().ownerToken),
      });
      expect(cross.statusCode).toBe(404);
    });
  });
});
