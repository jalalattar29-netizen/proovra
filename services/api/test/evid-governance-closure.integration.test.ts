/**
 * Closure evidence (governance / workspace rows) — behavioural proofs against a
 * disposable PostgreSQL, through the real routes and services:
 *
 *   PRO-G1Z-04  the Integration API detail route answers every record its list
 *               returns (a personal workspace's legacy NULL-team record); another
 *               workspace's record stays 404
 *   PRO-G2-08   the governance policy write and its audit row commit together: an
 *               audit failure leaves the policy unchanged
 *   PRO-T1-10   a grant reviving an ENDED membership drops the ended access window;
 *               an invitation never reverses a suspension (window kept)
 *   PRO-K2-24   (API) a roster read with status=ACTIVE uses effective membership;
 *               a combined role+status member PATCH is refused before any write
 *
 * The only double is an audit fault switch for one action.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps } from "./point7/product-fixtures.js";

const faults = vi.hoisted(() => ({ policyAudit: false }));

vi.mock("../src/services/audit/tenant-audit.service.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/audit/tenant-audit.service.js")>();
  return {
    ...real,
    emitTenantAudit: async (...args: Parameters<typeof real.emitTenantAudit>) => {
      if (faults.policyAudit && (args[0] as { action?: string }).action === "governance.workspace_policy_updated") {
        throw new Error("simulated audit append failure");
      }
      return real.emitTenantAudit(...args);
    },
  };
});

type Res = { statusCode: number; body: string; json: () => Record<string, unknown> };

describe("closure evidence — governance / workspace rows (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let fx: typeof import("./point7/product-fixtures.js");
  let jwt: typeof import("../src/services/jwt.js");
  let keys: typeof import("../src/services/integrations/api-keys.service.js");
  let entitlements: typeof import("../src/services/packaging/entitlement.service.js");
  let provisioning: typeof import("../src/services/identity/membership-provisioning.service.js");
  let access: typeof import("../src/services/identity/access-policy.service.js");
  let collab: typeof import("../src/services/collaboration-team/collaboration-team.service.js");
  let ceremony: ReturnType<(typeof import("./support/step-up-ceremony.js"))["createStepUpCeremony"]>;
  let clearRates: () => Promise<unknown>;
  let deps: FixtureDeps;
  let ip = 1;
  const A = () => h.fixtures.teamA;

  const call = (method: string, url: string, token: string, payload?: unknown, extra: Record<string, string> = {}): Promise<Res> =>
    h.app.inject({
      method: method as never,
      url,
      remoteAddress: `198.18.3.${(ip++ % 250) + 1}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    }) as unknown as Promise<Res>;

  beforeAll(async () => {
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = "integration-only-api-key-secret-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    fx = await import("./point7/product-fixtures.js");
    jwt = await import("../src/services/jwt.js");
    keys = await import("../src/services/integrations/api-keys.service.js");
    entitlements = await import("../src/services/packaging/entitlement.service.js");
    provisioning = await import("../src/services/identity/membership-provisioning.service.js");
    access = await import("../src/services/identity/access-policy.service.js");
    collab = await import("../src/services/collaboration-team/collaboration-team.service.js");
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    const { createStepUpCeremony } = await import("./support/step-up-ceremony.js");
    ceremony = createStepUpCeremony({ prisma: prisma as never, inject: (o) => h.app.inject(o as never) as never });
    deps = {
      prisma: prisma as never,
      tag: `evidgov-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        jwt.signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } as never });
  }, 300_000);

  beforeEach(async () => {
    faults.policyAudit = false;
    await clearRates();
  });

  afterAll(async () => {
    faults.policyAudit = false;
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // PRO-G1Z-04
  // ===========================================================================
  describe("PRO-G1Z-04: the Integration API detail route answers what its list returns", () => {
    async function personalWithLegacyRecord() {
      const t = await fx.seedPersonalTenant(deps, "PRO");
      const legacy = await prisma.evidence.create({
        data: { title: `legacy ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId: null, ownerUserId: t.owner.userId } as never,
        select: { id: true },
      });
      // The workspace holds a key allowance (a CUSTOM grant), as a provisioned customer does.
      await entitlements.upsertEntitlementGrant({ prisma: prisma as never, teamId: t.personalTeamId, key: "INTEGRATION_API_KEYS_MAX" as never, value: 3, kind: "LIMIT" as never, source: "CUSTOM", grantedByUserId: t.owner.userId });
      const { rawKey } = await keys.createApiCredential(
        { teamId: t.personalTeamId, name: `evid ${randomUUID().slice(0, 6)}`, scopes: ["integration.evidence.read"], actorUserId: t.owner.userId },
        prisma as never,
      );
      return { t, legacyId: legacy.id, rawKey };
    }

    it("allowed: a personal workspace's legacy NULL-team record is listed AND fetched by its key", async () => {
      const { legacyId, rawKey } = await personalWithLegacyRecord();
      const list = await call("GET", "/v1/integrations/api/evidence", rawKey);
      expect(list.statusCode, list.body).toBe(200);
      expect(JSON.stringify(list.json())).toContain(legacyId);
      const detail = await call("GET", `/v1/integrations/api/evidence/${legacyId}`, rawKey);
      expect(detail.statusCode, detail.body).toBe(200);
      expect((detail.json().evidence as { id: string }).id).toBe(legacyId);
    });

    it("refused: another personal workspace's legacy record is 404 to this key", async () => {
      const mine = await personalWithLegacyRecord();
      const theirs = await personalWithLegacyRecord();
      const r = await call("GET", `/v1/integrations/api/evidence/${theirs.legacyId}`, mine.rawKey);
      expect(r.statusCode, r.body).toBe(404);
    });
  });

  // ===========================================================================
  // PRO-G2-08
  // ===========================================================================
  describe("PRO-G2-08: a governance policy change and its audit row commit together", () => {
    async function readVersion(teamId: string) {
      const r = await prisma.workspaceGovernancePolicy.findFirst({ where: { teamId }, select: { version: true, allowPublicVerify: true } as never });
      return r as { version: number; allowPublicVerify: boolean } | null;
    }
    async function put(teamId: string, body: Record<string, unknown>) {
      const stepUp = await ceremony.approvedHeader({
        token: A().ownerToken,
        userId: A().ownerUserId,
        teamId,
        purpose: "GOVERNANCE_POLICY_UPDATE",
        resourceKind: "workspace_governance_policy",
        resourceId: teamId,
      });
      return call("PUT", "/v1/governance/policy", A().ownerToken, body, { ...stepUp, "x-proovra-workspace-id": teamId });
    }

    it("refused: when the audit row cannot be written the change is rolled back (the policy is as before)", async () => {
      await prisma.user.update({ where: { id: A().ownerUserId }, data: { currentWorkspaceId: A().teamId } });
      const before = await readVersion(A().teamId);
      faults.policyAudit = true;
      const r = await put(A().teamId, { expectedVersion: before?.version ?? 0, allowPublicVerify: !(before?.allowPublicVerify ?? true) });
      faults.policyAudit = false;
      expect(r.statusCode, r.body).toBeGreaterThanOrEqual(500);
      expect(await readVersion(A().teamId)).toEqual(before);
    });

    it("allowed: with the audit working the change commits with its audit row", async () => {
      await prisma.user.update({ where: { id: A().ownerUserId }, data: { currentWorkspaceId: A().teamId } });
      const before = await readVersion(A().teamId);
      const r = await put(A().teamId, { expectedVersion: before?.version ?? 0, allowPublicVerify: !(before?.allowPublicVerify ?? true) });
      expect(r.statusCode, r.body).toBe(200);
      const version = r.json().version as number;
      expect(version).toBe((before?.version ?? 0) + 1);
      const audit = await prisma.adminAuditLog.findFirst({
        where: { action: "governance.workspace_policy_updated", workspaceId: A().teamId },
        orderBy: { createdAt: "desc" },
        select: { metadata: true },
      });
      expect(audit?.metadata).toMatchObject({ newVersion: version });
    });
  });

  // ===========================================================================
  // PRO-T1-10
  // ===========================================================================
  describe("PRO-T1-10: a revived grant drops the ended access window", () => {
    async function setup(status: "REVOKED" | "SUSPENDED") {
      const o = await fx.seedOrganizationTenant(deps, { memberCount: 0 });
      const u = await fx.seedUser(deps, `t110-${status.toLowerCase()}`);
      const ended = new Date(Date.now() - 3 * 24 * 3600_000);
      await prisma.teamMember.create({
        data: {
          teamId: o.workspaceId,
          userId: u.userId,
          role: "MEMBER",
          status,
          accessExpiresAtUtc: new Date(Date.now() - 24 * 3600_000),
          ...(status === "REVOKED" ? { revokedAtUtc: ended } : { suspendedAtUtc: ended }),
        } as never,
      });
      return { o, u };
    }
    const grant = (o: { organizationId: string; workspaceId: string }, userId: string) =>
      prisma.$transaction((tx) =>
        provisioning.grantWorkspaceMembership(tx as never, {
          organizationId: o.organizationId,
          userId,
          assignment: { teamId: o.workspaceId, role: "MEMBER" },
          accessReason: "invitation",
          invitationCreatedAt: new Date(),
        }),
      );
    const row = (teamId: string, userId: string) =>
      prisma.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId, userId } }, select: { status: true, accessExpiresAtUtc: true } });

    it("allowed: re-adding a removed member gives an ACTIVE membership with no inherited expiry, and access is granted", async () => {
      const { o, u } = await setup("REVOKED");
      const r = await grant(o, u.userId);
      expect(r).toEqual({ ok: true });
      expect(await row(o.workspaceId, u.userId)).toEqual({ status: "ACTIVE", accessExpiresAtUtc: null });
      const decision = await access.evaluateMemberAccess({ teamId: o.workspaceId, userId: u.userId, permission: "evidence.read" as never });
      expect(decision.allowed, JSON.stringify(decision)).toBe(true);
    });

    it("refused: an invitation does not reverse a suspension, and the suspended member's window stays", async () => {
      const { o, u } = await setup("SUSPENDED");
      const before = await row(o.workspaceId, u.userId);
      const r = await grant(o, u.userId);
      expect(r).toEqual({ ok: false, reason: "membership_suspended" });
      expect(await row(o.workspaceId, u.userId)).toEqual(before);
    });
  });

  // ===========================================================================
  // PRO-K2-24 (API)
  // ===========================================================================
  describe("PRO-K2-24: collaboration roster and member PATCH", () => {
    it("status=ACTIVE lists only people who can be handed work now (a suspended workspace member is left out)", async () => {
      const active = await fx.seedUser(deps, "k224-active");
      const paused = await fx.seedUser(deps, "k224-paused");
      await prisma.teamMember.create({ data: { teamId: A().teamId, userId: active.userId, role: "MEMBER", status: "ACTIVE" } });
      await prisma.teamMember.create({ data: { teamId: A().teamId, userId: paused.userId, role: "MEMBER", status: "SUSPENDED", suspendedAtUtc: new Date() } as never });
      const group = await prisma.collaborationTeam.create({
        data: { workspaceId: A().teamId, name: `k224 ${randomUUID().slice(0, 6)}`, createdByUserId: A().ownerUserId, status: "ACTIVE" },
        select: { id: true },
      });
      await prisma.collaborationTeamMember.createMany({
        data: [active.userId, paused.userId].map((userId) => ({ teamId: group.id, userId, status: "ACTIVE" })),
      });
      const listed = await collab.listCollaborationTeamMembers(
        { teamId: group.id, workspaceId: A().teamId, viewerCanSeeContact: false, status: "ACTIVE" },
        prisma as never,
      );
      const ids = listed.members.map((m) => m.userId);
      expect(ids).toContain(active.userId);
      expect(ids).not.toContain(paused.userId);
      // History is still read as asked.
      const suspendedHistory = await collab.listCollaborationTeamMembers(
        { teamId: group.id, workspaceId: A().teamId, viewerCanSeeContact: false, status: "SUSPENDED" },
        prisma as never,
      );
      expect(suspendedHistory.members.map((m) => m.userId)).not.toContain(active.userId);
    });

    it("refused: a PATCH carrying both role and status is 400 and changes nothing; allowed: a role-only PATCH is applied", async () => {
      const person = await fx.seedUser(deps, "k224-patch");
      await prisma.teamMember.create({ data: { teamId: A().teamId, userId: person.userId, role: "MEMBER", status: "ACTIVE" } });
      const group = await prisma.collaborationTeam.create({
        data: { workspaceId: A().teamId, name: `k224p ${randomUUID().slice(0, 6)}`, createdByUserId: A().ownerUserId, status: "ACTIVE" },
        select: { id: true },
      });
      await prisma.collaborationTeamMember.createMany({
        data: [
          { teamId: group.id, userId: A().ownerUserId, status: "ACTIVE", role: "LEAD" },
          { teamId: group.id, userId: person.userId, status: "ACTIVE", role: "MEMBER" },
        ] as never,
      });
      const member = await prisma.collaborationTeamMember.findFirstOrThrow({ where: { teamId: group.id, userId: person.userId } });
      const url = `/v1/collaboration-teams/${group.id}/members/${member.id}`;
      const hdr = { "x-proovra-workspace-id": A().teamId };

      const both = await call("PATCH", url, A().ownerToken, { role: "VIEWER", status: "SUSPENDED" }, hdr);
      expect(both.statusCode, both.body).toBe(400);
      expect((both.json().error as { code: string }).code).toBe("invalid_body");
      expect(await prisma.collaborationTeamMember.findUniqueOrThrow({ where: { id: member.id }, select: { role: true, status: true } })).toEqual({
        role: "MEMBER",
        status: "ACTIVE",
      });

      const roleOnly = await call("PATCH", url, A().ownerToken, { role: "VIEWER" }, hdr);
      expect(roleOnly.statusCode, roleOnly.body).toBe(200);
      expect((await prisma.collaborationTeamMember.findUniqueOrThrow({ where: { id: member.id } })).role).toBe("VIEWER");
    });
  });
});
