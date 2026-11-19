/* eslint-disable @typescript-eslint/no-explicit-any -- JSON response bodies and mocked payloads of many shapes. */
/**
 * FREE-USER AUDIT 0ea0 — GROUP API-G2-IDENTITY (live PostgreSQL + Redis).
 *
 * Identity, sessions, roles and membership authority. Every refusal below has
 * a positive control on the same rows, so a test cannot pass by refusing
 * everybody. Real routes and real rows; the only stub is the session-inventory
 * write fault in the B1-F-008 block (a flag, off by default).
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { makeEnterpriseOrganizationWorkspace } from "./support/enterprise-organization.js";
import type { FixtureDeps, SeededUser } from "./point7/product-fixtures.js";

const inventoryFault = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("../src/services/access-control/session-inventory.service.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/access-control/session-inventory.service.js")>();
  return {
    ...real,
    recordAuthenticatedSession: async (...args: Parameters<typeof real.recordAuthenticatedSession>) => {
      if (inventoryFault.userId && args[0].userId === inventoryFault.userId) {
        throw new Error("simulated session-inventory write failure");
      }
      return real.recordAuthenticatedSession(...args);
    },
  };
});

type Res = { statusCode: number; body: string; headers: Record<string, unknown> };
type Prisma = (typeof import("../src/db.js"))["prisma"];

const tag = () => randomUUID().slice(0, 8);

describe("free-audit 0ea0 — API-G2-IDENTITY (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let fx: typeof import("./point7/product-fixtures.js");
  let deps: FixtureDeps;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let inventory: typeof import("../src/services/access-control/session-inventory.service.js");
  let quarantine: typeof import("../src/services/access-control/session-quarantine.service.js");
  let collab: typeof import("../src/services/collaboration-team/collaboration-team.service.js");
  let resetSvc: typeof import("../src/services/email-password-auth.service.js");
  let mfaSvc: typeof import("../src/services/security/mfa.service.js");
  let recovery: typeof import("../src/services/security/mfa-recovery.js");
  let rateLimit: typeof import("../src/services/rate-limit.js");
  let hashSessionId: (sid: string) => string;
  let ceremony: ReturnType<typeof import("./support/step-up-ceremony.js").createStepUpCeremony>;
  let cronHeader: string;
  let orgId: string;
  let ip = 1;
  const A = () => h.fixtures.teamA;
  const password = "Str0ng-g2-identity-passphrase!";

  const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, token: string | null, payload?: unknown, extra: Record<string, string> = {}): Promise<Res> =>
    h.app.inject({
      method,
      url,
      remoteAddress: `198.51.100.${(ip++ % 250) + 1}`,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    }) as unknown as Promise<Res>;
  const json = (r: Res) => JSON.parse(r.body) as Record<string, any>;
  const owner = () => A().ownerToken;
  const admin = () => A().adminToken;
  const member = () => A().memberToken;
  const viewer = () => A().viewerToken;

  /** A real user with current terms and a registered session, optionally a member of team A. */
  async function person(
    label: string,
    membership?: { role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER"; status?: "ACTIVE" | "SUSPENDED" | "REVOKED"; accessExpiresAtUtc?: Date },
  ): Promise<SeededUser & { memberId: string | null }> {
    const u = await fx.seedUser(deps, label);
    let memberId: string | null = null;
    if (membership) {
      memberId = (
        await prisma.teamMember.create({
          data: {
            teamId: A().teamId,
            userId: u.userId,
            role: membership.role,
            status: membership.status ?? "ACTIVE",
            ...(membership.accessExpiresAtUtc ? { accessExpiresAtUtc: membership.accessExpiresAtUtc } : {}),
          },
          select: { id: true },
        })
      ).id;
    }
    return { ...u, memberId };
  }
  const past = () => new Date(Date.now() - 60 * 60 * 1000);
  const future = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

  beforeAll(async () => {
    process.env.MESSAGING_TRANSPORT = "recording";
    process.env.IDENTITY_RECONCILE_CRON_SECRET = `g2-cron-${randomUUID()}`;
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    fx = await import("./point7/product-fixtures.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
    inventory = await import("../src/services/access-control/session-inventory.service.js");
    quarantine = await import("../src/services/access-control/session-quarantine.service.js");
    collab = await import("../src/services/collaboration-team/collaboration-team.service.js");
    resetSvc = await import("../src/services/email-password-auth.service.js");
    mfaSvc = await import("../src/services/security/mfa.service.js");
    recovery = await import("../src/services/security/mfa-recovery.js");
    rateLimit = await import("../src/services/rate-limit.js");
    ({ hashSessionId } = await import("../src/services/identity-security/session-revocation.service.js"));
    ({ REVIEWER_OPS_CRON_HEADER: cronHeader } = await import("../src/middleware/cron-secret.js"));
    const { createStepUpCeremony } = await import("./support/step-up-ceremony.js");
    ceremony = createStepUpCeremony({
      prisma: prisma as never,
      inject: (opts) => h.app.inject(opts as never) as never,
    });
    deps = {
      prisma: prisma as never,
      tag: `g2-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    await prisma.team.updateMany({
      where: { id: A().teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" },
    });
    // PRO-K1-03 (WS-ENT) — graph, diagnostics and SIU are Enterprise organization tools.
    await makeEnterpriseOrganizationWorkspace(prisma, A().teamId);
    orgId = (await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } }))
      .organizationId as string;
  }, 180_000);

  afterAll(async () => {
    inventoryFault.userId = null;
    await h?.cleanup();
  });

  // ===========================================================================
  // B7A-F-002 / B1-F-003 — session and device inventories are administrators'
  // ===========================================================================
  describe("B7A-F-002 / B1-F-003: read-only roles do not read co-members' sessions or devices", () => {
    it("GET /v1/admin/identity/sessions and /quarantined-sessions: VIEWER and MEMBER 403, ADMIN 200", async () => {
      for (const url of [
        `/v1/admin/identity/sessions?teamId=${A().teamId}`,
        `/v1/admin/identity/quarantined-sessions?teamId=${A().teamId}`,
      ]) {
        for (const token of [viewer(), member()]) {
          const r = await call("GET", url, token);
          expect(r.statusCode, `${url} ${r.body}`).toBe(403);
          expect(json(r).error.code).toBe("permission_denied");
        }
        const ok = await call("GET", url, admin());
        expect(ok.statusCode, `${url} ${ok.body}`).toBe(200);
      }
    });

    it("GET /v1/identity-security/devices and /sessions: a VIEWER gets only their own rows; an ADMIN the workspace's", async () => {
      const device = (userId: string) =>
        prisma.trustedDevice.create({
          data: {
            teamId: A().teamId,
            userId,
            deviceIdHash: createHash("sha256").update(randomUUID()).digest("hex"),
            uaPreview: "g2-agent",
            ipPreview: "203.0.113.0/24",
            trustedUntilUtc: future(),
          },
          select: { id: true },
        });
      const ownerDevice = await device(A().ownerUserId);
      const viewerDevice = await device(A().viewerUserId);
      const revoked = (userId: string) =>
        prisma.revokedSession.create({
          data: {
            teamId: A().teamId,
            userId,
            sessionIdHash: createHash("sha256").update(randomUUID()).digest("hex"),
            reason: "G2_TEST",
          },
          select: { id: true },
        });
      const ownerRevoked = await revoked(A().ownerUserId);
      const viewerRevoked = await revoked(A().viewerUserId);

      const vd = await call("GET", `/v1/identity-security/devices?teamId=${A().teamId}`, viewer());
      expect(vd.statusCode, vd.body).toBe(200);
      expect(json(vd).scope).toBe("self");
      const vdIds = (json(vd).devices as Array<{ id: string; userId: string }>).map((d) => d.id);
      expect(vdIds).toContain(viewerDevice.id);
      expect(vdIds).not.toContain(ownerDevice.id);
      expect((json(vd).devices as Array<{ userId: string }>).every((d) => d.userId === A().viewerUserId)).toBe(true);

      const ad = await call("GET", `/v1/identity-security/devices?teamId=${A().teamId}`, admin());
      expect(ad.statusCode, ad.body).toBe(200);
      expect(json(ad).scope).toBe("team");
      const adIds = (json(ad).devices as Array<{ id: string }>).map((d) => d.id);
      expect(adIds).toEqual(expect.arrayContaining([viewerDevice.id, ownerDevice.id]));

      const vs = await call("GET", `/v1/identity-security/sessions?teamId=${A().teamId}`, viewer());
      expect(vs.statusCode, vs.body).toBe(200);
      const vsIds = (json(vs).revoked as Array<{ id: string }>).map((r) => r.id);
      expect(vsIds).toContain(viewerRevoked.id);
      expect(vsIds).not.toContain(ownerRevoked.id);

      const as = await call("GET", `/v1/identity-security/sessions?teamId=${A().teamId}`, admin());
      expect(as.statusCode, as.body).toBe(200);
      expect((json(as).revoked as Array<{ id: string }>).map((r) => r.id)).toEqual(
        expect.arrayContaining([viewerRevoked.id, ownerRevoked.id]),
      );
    });

    it("GET /v1/identity-security/session-policy-impact: VIEWER and MEMBER 403, ADMIN 200", async () => {
      const url = `/v1/identity-security/session-policy-impact?teamId=${A().teamId}`;
      for (const token of [viewer(), member()]) {
        const r = await call("GET", url, token);
        expect(r.statusCode, r.body).toBe(403);
      }
      const ok = await call("GET", url, admin());
      expect(ok.statusCode, ok.body).toBe(200);
      expect(Array.isArray(json(ok).impact)).toBe(true);
    });
  });

  // ===========================================================================
  // B7A-F-001 — removal ends the workspace's authority over the person
  // ===========================================================================
  describe("B7A-F-001: a removed member drops out of the workspace's session scope", () => {
    it("after removal: the session started in the person's own space is not listed, revocable or quarantinable; the one started here still is", async () => {
      const u = await person("g2-departed", { role: "MEMBER" });
      const session = (teamId: string | null) =>
        prisma.authenticatedSession.create({
          data: {
            userId: u.userId,
            teamId,
            sessionIdHash: createHash("sha256").update(randomUUID()).digest("hex"),
            expiresAtUtc: future(),
          },
          select: { id: true },
        });
      const startedHere = await session(A().teamId);
      const startedElsewhere = await session(null);
      const listed = async () =>
        (await inventory.listActiveSessions({ teamId: A().teamId, userId: u.userId, limit: 50 }, prisma as never)).sessions.map(
          (s) => s.id,
        );

      // PRO-A2-04 (DEC-08) — an independent (self-serve) member: the workspace
      // answers for what it issued. The session started in the person's own
      // space is not the workspace's even while they are a member.
      const whileIndependentMember = await listed();
      expect(whileIndependentMember).toContain(startedHere.id);
      expect(whileIndependentMember).not.toContain(startedElsewhere.id);

      // Control: an identity this Organization's directory originated — while
      // the person is a member, both sessions reach the workspace.
      await prisma.user.update({
        where: { id: u.userId },
        data: { providerUserId: `scim-${orgId}:g2-departed-${randomUUID().slice(0, 8)}` },
      });
      expect(await listed()).toEqual(expect.arrayContaining([startedHere.id, startedElsewhere.id]));

      await prisma.teamMember.update({ where: { id: u.memberId! }, data: { status: "REVOKED" } });

      const viaRoute = await call("GET", `/v1/admin/identity/sessions?teamId=${A().teamId}&userId=${u.userId}`, admin());
      expect(viaRoute.statusCode, viaRoute.body).toBe(200);
      const routeIds = (json(viaRoute).sessions as Array<{ id: string }>).map((s) => s.id);
      expect(routeIds).toContain(startedHere.id);
      expect(routeIds).not.toContain(startedElsewhere.id);

      expect(
        await inventory.revokeActiveSession(
          { teamId: A().teamId, sessionId: startedElsewhere.id, actorUserId: A().adminUserId },
          prisma as never,
        ),
      ).toEqual({ ok: false, reason: "not_found" });
      expect(
        await quarantine.quarantineSession(
          { teamId: A().teamId, sessionId: startedElsewhere.id, actorUserId: A().adminUserId, reason: "MANUAL" } as never,
          prisma as never,
        ),
      ).toBeNull();
      const untouched = await prisma.authenticatedSession.findUniqueOrThrow({
        where: { id: startedElsewhere.id },
        select: { revokedAtUtc: true, quarantinedAtUtc: true },
      });
      expect(untouched).toEqual({ revokedAtUtc: null, quarantinedAtUtc: null });

      // The session started in this workspace before removal stays revocable.
      const ended = await inventory.revokeActiveSession(
        { teamId: A().teamId, sessionId: startedHere.id, actorUserId: A().adminUserId },
        prisma as never,
      );
      expect(ended.ok).toBe(true);
    });
  });

  // ===========================================================================
  // B3A-F-001 — the org roster's contact details follow the directory rule
  // ===========================================================================
  describe("B3A-F-001: ORG_MEMBER sees no addresses and cannot search by address", () => {
    it("as ORG_MEMBER every row's email is null and q=<address> matches nothing; ORG_OWNER unchanged", async () => {
      const orgMember = await person("g2-orgmember");
      await prisma.organizationMembership.create({
        data: { organizationId: orgId, userId: orgMember.userId, role: "ORG_MEMBER" },
      });
      const suspended = await person("g2-orgsuspended");
      await prisma.organizationMembership.create({
        data: { organizationId: orgId, userId: suspended.userId, role: "ORG_MEMBER", status: "SUSPENDED", suspendedAtUtc: new Date(), statusChangedAtUtc: new Date() } as never,
      });

      const list = await call("GET", `/v1/orgs/${orgId}/members?limit=200`, orgMember.token);
      expect(list.statusCode, list.body).toBe(200);
      const rows = json(list).members as Array<{ userId: string; email: string | null }>;
      expect(rows.length).toBeGreaterThan(1);
      expect(rows.every((m) => m.email === null)).toBe(true);
      expect(list.body).not.toContain(suspended.email);

      const byAddress = await call("GET", `/v1/orgs/${orgId}/members?q=${encodeURIComponent(suspended.email)}`, orgMember.token);
      expect(byAddress.statusCode, byAddress.body).toBe(200);
      expect(json(byAddress).members).toEqual([]);

      const asOwner = await call("GET", `/v1/orgs/${orgId}/members?q=${encodeURIComponent(suspended.email)}`, owner());
      expect(asOwner.statusCode, asOwner.body).toBe(200);
      expect((json(asOwner).members as Array<{ email: string }>).map((m) => m.email)).toEqual([suspended.email]);
    });
  });

  // ===========================================================================
  // B3A-F-006 — formula neutralisation in the org CSV reports
  // ===========================================================================
  describe("B3A-F-006: members.csv neutralises a formula-leading display name", () => {
    it("a displayName '=1+1' exports as the quoted text \"'=1+1\"", async () => {
      const evil = await person("g2-formula");
      await prisma.user.update({ where: { id: evil.userId }, data: { displayName: "=1+1" } });
      await prisma.organizationMembership.create({
        data: { organizationId: orgId, userId: evil.userId, role: "ORG_MEMBER" },
      });
      const csv = await call("GET", `/v1/orgs/${orgId}/reports/members.csv`, owner());
      expect(csv.statusCode, csv.body).toBe(200);
      const line = csv.body.split("\r\n").find((l) => l.includes(evil.userId))!;
      expect(line).toContain(`"'=1+1"`);
      expect(line).not.toMatch(/,=1\+1(,|$)/);
    });
  });

  // ===========================================================================
  // B3A-F-005 — the canonical authority, not raw membership rows
  // ===========================================================================
  describe("B3A-F-005: expiry, organization status and existence are decided canonically", () => {
    it("notification policy: an ORG_ADMIN whose membership lapsed gets 404 on GET and PUT and writes nothing; a live one writes", async () => {
      const lapsed = await person("g2-lapsed-orgadmin");
      await prisma.organizationMembership.create({
        data: { organizationId: orgId, userId: lapsed.userId, role: "ORG_ADMIN", validUntilUtc: past() } as never,
      });
      const live = await person("g2-live-orgadmin");
      await prisma.organizationMembership.create({
        data: { organizationId: orgId, userId: live.userId, role: "ORG_ADMIN", validUntilUtc: future() } as never,
      });
      const body = {
        category: "ESCALATION",
        mandatoryInApp: true,
        mandatoryEmail: false,
        quietHoursCriticalOverride: true,
      };
      const before = await prisma.organizationNotificationPolicy.count({ where: { organizationId: orgId } });
      const get = await call("GET", `/v1/orgs/${orgId}/notification-policy`, lapsed.token);
      expect(get.statusCode, get.body).toBe(404);
      const put = await call("PUT", `/v1/orgs/${orgId}/notification-policy`, lapsed.token, body);
      expect(put.statusCode, put.body).toBe(404);
      expect(await prisma.organizationNotificationPolicy.count({ where: { organizationId: orgId } })).toBe(before);

      const ok = await call("PUT", `/v1/orgs/${orgId}/notification-policy`, live.token, body);
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it("collaboration invite accept: a workspace member past their access window is refused WORKSPACE_MEMBERSHIP_REQUIRED", async () => {
      const expired = await person("g2-expired-collab", { role: "MEMBER", accessExpiresAtUtc: past() });
      const live = await person("g2-live-collab", { role: "MEMBER" });
      const group = await prisma.collaborationTeam.create({
        data: { workspaceId: A().teamId, name: `g2-group-${tag()}`, createdByUserId: A().ownerUserId },
        select: { id: true },
      });
      // PRO-K2-14 / DEC-28: an invitation is honoured only while its inviter is
      // still an effective member of the group allowed to invite (else
      // INVITE_REVOKED) — the inviter is the group's LEAD.
      await prisma.collaborationTeamMember.create({
        data: { teamId: group.id, userId: A().ownerUserId, role: "LEAD", status: "ACTIVE" } as never,
      });
      const invite = async () => {
        const raw = `g2-invite-${randomUUID()}`;
        await prisma.collaborationTeamInvite.create({
          data: {
            teamId: group.id,
            workspaceId: A().teamId,
            channel: "LINK",
            tokenHash: createHash("sha256").update(raw).digest("hex"),
            role: "MEMBER",
            expiresAtUtc: future(),
            createdByUserId: A().ownerUserId,
          },
        });
        return raw;
      };
      const refused = await collab
        .acceptInvite({ rawToken: await invite(), actorUserId: expired.userId }, prisma as never)
        .then(() => null, (e: { code?: string }) => e.code ?? String(e));
      expect(refused).toBe("WORKSPACE_MEMBERSHIP_REQUIRED");

      const control = await collab
        .acceptInvite({ rawToken: await invite(), actorUserId: live.userId }, prisma as never)
        .then(() => "accepted", (e: { code?: string }) => e.code ?? String(e));
      expect(control).not.toBe("WORKSPACE_MEMBERSHIP_REQUIRED");
    });

    it("workspace operations health: removed and expired members get the 404 a missing workspace gets; a live VIEWER reads it", async () => {
      const removed = await person("g2-removed-ops", { role: "MEMBER", status: "REVOKED" });
      const expired = await person("g2-expired-ops", { role: "MEMBER", accessExpiresAtUtc: past() });
      const missing = await call("GET", `/v1/teams/${randomUUID()}/operations/health`, removed.token);
      expect(missing.statusCode).toBe(404);
      for (const who of [removed, expired]) {
        const r = await call("GET", `/v1/teams/${A().teamId}/operations/health`, who.token);
        expect(r.statusCode, r.body).toBe(404);
        expect(json(r).error.code).toBe(json(missing).error.code);
      }
      const ok = await call("GET", `/v1/teams/${A().teamId}/operations/health`, viewer());
      expect(ok.statusCode, ok.body).toBe(200);
    });
  });

  // ===========================================================================
  // B5B-F-303 — SIU saved views on the canonical authority; shared views need a manager
  // ===========================================================================
  describe("B5B-F-303 / A2-14: SIU saved views", () => {
    const view = (visibility: "private" | "team" | "organization") => ({
      teamId: undefined as unknown as string,
      name: `g2-siu-${tag()}`,
      filter: {},
      sort: { key: "updatedAtUtc", direction: "desc" },
      visibility,
    });

    it("an expired member is refused /custom, create and /use; a VIEWER cannot publish (create or PATCH); private views work; members publish", async () => {
      const expired = await person("g2-expired-siu", { role: "MEMBER", accessExpiresAtUtc: past() });
      const teamView = await call("POST", "/v1/siu/saved-views", admin(), { ...view("team"), teamId: A().teamId });
      expect(teamView.statusCode, teamView.body).toBe(201);
      const teamViewId = json(teamView).view.id as string;

      const custom = await call("GET", `/v1/siu/saved-views/custom?teamId=${A().teamId}`, expired.token);
      expect(custom.statusCode, custom.body).toBe(403);
      expect(json(custom).error.code).toBe("permission_denied");
      const create = await call("POST", "/v1/siu/saved-views", expired.token, { ...view("private"), teamId: A().teamId });
      expect(create.statusCode, create.body).toBe(403);
      const use = await call("POST", `/v1/siu/saved-views/${teamViewId}/use`, expired.token, { teamId: A().teamId });
      expect(use.statusCode, use.body).toBe(403);
      expect(use.body).not.toContain("worklist\":{");

      const viewerTeam = await call("POST", "/v1/siu/saved-views", viewer(), { ...view("team"), teamId: A().teamId });
      expect(viewerTeam.statusCode, viewerTeam.body).toBe(403);
      const viewerOrg = await call("POST", "/v1/siu/saved-views", viewer(), { ...view("organization"), teamId: A().teamId });
      expect(viewerOrg.statusCode, viewerOrg.body).toBe(403);
      const viewerPrivate = await call("POST", "/v1/siu/saved-views", viewer(), { ...view("private"), teamId: A().teamId });
      expect(viewerPrivate.statusCode, viewerPrivate.body).toBe(201);
      const viewerPublish = await call(
        "PATCH",
        `/v1/siu/saved-views/${json(viewerPrivate).view.id}?teamId=${A().teamId}`,
        viewer(),
        { visibility: "team" },
      );
      expect(viewerPublish.statusCode, viewerPublish.body).toBe(403);
      expect((await prisma.caseSiuSavedView.findUniqueOrThrow({ where: { id: json(viewerPrivate).view.id } })).visibility).toBe(
        "private",
      );
      const memberTeam = await call("POST", "/v1/siu/saved-views", member(), { ...view("team"), teamId: A().teamId });
      expect(memberTeam.statusCode, memberTeam.body).toBe(201);

      const liveCustom = await call("GET", `/v1/siu/saved-views/custom?teamId=${A().teamId}`, member());
      expect(liveCustom.statusCode, liveCustom.body).toBe(200);
    });
  });

  // ===========================================================================
  // B2A-F-09 / B5A-F-14 / A2-14 — shared saved views are a write
  // ===========================================================================
  describe("B2A-F-09 / B5A-F-14 / A2-14: a VIEWER cannot publish shared saved views", () => {
    it("search: VIEWER TEAM view 403, PRIVATE 201; MEMBER and ADMIN TEAM 201", async () => {
      const body = (visibility: "TEAM" | "PRIVATE") => ({
        teamId: A().teamId,
        name: `g2-search-${tag()}`,
        visibility,
        pinned: true,
        query: { teamId: A().teamId, q: "g2" },
      });
      const vt = await call("POST", "/v1/search/saved-views", viewer(), body("TEAM"));
      expect(vt.statusCode, vt.body).toBe(403);
      const vp = await call("POST", "/v1/search/saved-views", viewer(), body("PRIVATE"));
      expect(vp.statusCode, vp.body).toBe(201);
      const at = await call("POST", "/v1/search/saved-views", admin(), body("TEAM"));
      expect(at.statusCode, at.body).toBe(201);
      const mt = await call("POST", "/v1/search/saved-views", member(), body("TEAM"));
      expect(mt.statusCode, mt.body).toBe(201);
    });

    it("evidence: VIEWER team view 403, personal view 201; a MEMBER's team view 201; an ADMIN cannot move the MEMBER's default", async () => {
      const body = (teamId: string | null) => ({
        name: `g2-evidence-${tag()}`,
        ...(teamId ? { teamId } : {}),
        scope: "active",
        filters: {},
      });
      const vt = await call("POST", "/v1/evidence/saved-views", viewer(), body(A().teamId));
      expect(vt.statusCode, vt.body).toBe(403);
      const vp = await call("POST", "/v1/evidence/saved-views", viewer(), body(null));
      expect(vp.statusCode, vp.body).toBe(201);
      const mt = await call("POST", "/v1/evidence/saved-views", member(), body(A().teamId));
      expect(mt.statusCode, mt.body).toBe(201);
      const id = json(mt).savedView.id as string;

      const adminDefault = await call("POST", `/v1/evidence/saved-views/${id}/default`, admin(), {});
      expect(adminDefault.statusCode, adminDefault.body).toBe(403);
      const adminPatchDefault = await call("PATCH", `/v1/evidence/saved-views/${id}`, admin(), { isDefault: true });
      expect(adminPatchDefault.statusCode, adminPatchDefault.body).toBe(403);
      expect((await prisma.evidenceSavedView.findUniqueOrThrow({ where: { id } })).isDefault).toBe(false);
      const adminRename = await call("PATCH", `/v1/evidence/saved-views/${id}`, admin(), { name: "renamed by admin" });
      expect(adminRename.statusCode, adminRename.body).toBe(200);

      const ownDefault = await call("POST", `/v1/evidence/saved-views/${id}/default`, member(), {});
      expect(ownDefault.statusCode, ownDefault.body).toBe(200);
    });
  });

  // ===========================================================================
  // R1-F-05 — a thread resolver must be able to take part
  // ===========================================================================
  describe("R1-F-05: a discussion thread cannot be assigned to a VIEWER", () => {
    it("assigning the VIEWER answers 422 assignee_not_eligible; the MEMBER is assignable", async () => {
      const created = await call("POST", "/v1/collaboration/threads", admin(), {
        teamId: A().teamId,
        evidenceId: A().evidenceId,
        kind: "EVIDENCE_GENERAL",
        visibility: "INTERNAL",
        title: `g2-thread-${tag()}`,
      });
      expect([200, 201]).toContain(created.statusCode);
      const threadId = json(created).thread.id as string;
      const toViewer = await call("POST", `/v1/collaboration/threads/${threadId}/assign`, admin(), {
        teamId: A().teamId,
        assignedToUserId: A().viewerUserId,
      });
      expect(toViewer.statusCode, toViewer.body).toBe(422);
      expect(json(toViewer).error.code).toBe("assignee_not_eligible");
      expect(
        await prisma.discussionParticipant.count({ where: { threadId, userId: A().viewerUserId } }),
      ).toBe(0);
      const toMember = await call("POST", `/v1/collaboration/threads/${threadId}/assign`, admin(), {
        teamId: A().teamId,
        assignedToUserId: A().memberUserId,
      });
      expect(toMember.statusCode, toMember.body).toBe(200);
    });
  });

  // ===========================================================================
  // B3A-F-007 / B3A-F-008 — member removal with transfers; reopen oracle
  // ===========================================================================
  describe("B3A-F-007 / B3A-F-008: workspace member lifecycle", () => {
    it("a stale-terms admin: removal WITH a transfer is 428 and moves nothing; plain removal is not legal-gated", async () => {
      const staleAdmin = await person("g2-stale-admin", { role: "ADMIN" });
      await prisma.userLegalAcceptance.deleteMany({ where: { userId: staleAdmin.userId } });
      const target = await person("g2-removal-target", { role: "MEMBER" });
      const withTransfer = await call(
        "DELETE",
        `/v1/teams/${A().teamId}/members/${target.memberId}`,
        staleAdmin.token,
        { transferToUserId: A().ownerUserId },
      );
      expect(withTransfer.statusCode, withTransfer.body).toBe(428);
      expect(json(withTransfer).error.code).toBe("LEGAL_REACCEPT_REQUIRED");
      const withGrants = await call(
        "DELETE",
        `/v1/teams/${A().teamId}/members/${target.memberId}`,
        staleAdmin.token,
        { transferShareGrantsToOwner: true },
      );
      expect(withGrants.statusCode, withGrants.body).toBe(428);
      expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: target.memberId! } })).status).toBe("ACTIVE");

      const plain = await call("DELETE", `/v1/teams/${A().teamId}/members/${target.memberId}`, staleAdmin.token);
      expect(plain.statusCode, plain.body).not.toBe(428);
    });

    it("reopen: a non-owner and an unknown UUID get the same 404", async () => {
      const unknown = await call("POST", `/v1/teams/${randomUUID()}/reopen`, admin(), {});
      const notOwner = await call("POST", `/v1/teams/${A().teamId}/reopen`, admin(), {});
      const otherTenant = await call("POST", `/v1/teams/${A().teamId}/reopen`, h.fixtures.teamB.ownerToken, {});
      expect(unknown.statusCode).toBe(404);
      expect(notOwner.statusCode, notOwner.body).toBe(404);
      expect(otherTenant.statusCode, otherTenant.body).toBe(404);
      expect(notOwner.body).toBe(unknown.body);
      expect(otherTenant.body).toBe(unknown.body);
    });
  });

  // ===========================================================================
  // B1-F-008 — no session without its inventory row
  // ===========================================================================
  describe("B1-F-008: a sign-in whose inventory write fails issues no session", () => {
    it("password sign-in: 503 SECURITY_CONTEXT_UNAVAILABLE, no token, no cookie, no row; the control signs in", async () => {
      const t = await fx.seedPersonalTenant(deps, "FREE");
      await prisma.user.update({
        where: { id: t.owner.userId },
        data: { passwordHash: await resetSvc.hashPassword(password), emailVerifiedAt: new Date() },
      });
      const before = await prisma.authenticatedSession.count({ where: { userId: t.owner.userId } });
      inventoryFault.userId = t.owner.userId;
      try {
        const refused = await call("POST", "/v1/auth/email/login", null, { email: t.owner.email, password });
        expect(refused.statusCode, refused.body).toBe(503);
        expect(json(refused).error.code).toBe("SECURITY_CONTEXT_UNAVAILABLE");
        expect(json(refused).token).toBeUndefined();
        expect(String(refused.headers["set-cookie"] ?? "")).not.toContain("proovra_session=");
        expect(await prisma.authenticatedSession.count({ where: { userId: t.owner.userId } })).toBe(before);
      } finally {
        inventoryFault.userId = null;
      }
      const ok = await call("POST", "/v1/auth/email/login", null, { email: t.owner.email, password });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(typeof json(ok).token).toBe("string");
      expect(await prisma.authenticatedSession.count({ where: { userId: t.owner.userId } })).toBe(before + 1);
    });
  });

  // ===========================================================================
  // B1-F-013 — session-light agrees with requireAuth
  // ===========================================================================
  describe("B1-F-013: session-light is false whenever requireAuth would refuse", () => {
    it("unsupported provenance and an ended inventory row read as not signed in; a live session reads as signed in", async () => {
      const u = await person("g2-light");
      const probe = async (token: string) => json(await call("GET", "/v1/auth/session-light", token)).authenticated;
      expect(await probe(u.token)).toBe(true);
      expect((await call("GET", "/v1/auth/me", u.token)).statusCode).toBe(200);

      const noProvenance = signJwt({ sub: u.userId, provider: "EMAIL", email: u.email } as never, process.env.AUTH_JWT_SECRET!, 600);
      expect((await call("GET", "/v1/auth/me", noProvenance)).statusCode).toBe(401);
      expect(await probe(noProvenance)).toBe(false);

      const sid = JSON.parse(Buffer.from(u.token.split(".")[1]!, "base64url").toString("utf8")).sid as string;
      await prisma.authenticatedSession.updateMany({
        where: { userId: u.userId, sessionIdHash: hashSessionId(sid) },
        data: { revokedAtUtc: new Date() },
      });
      expect((await call("GET", "/v1/auth/me", u.token)).statusCode).toBe(401);
      expect(await probe(u.token)).toBe(false);
    });
  });

  // ===========================================================================
  // B1-F-017 — one reset retires every outstanding link
  // ===========================================================================
  describe("B1-F-017: a successful reset retires the account's other reset links", () => {
    it("the second link answers invalid_or_expired after the first resets the password", async () => {
      const t = await fx.seedPersonalTenant(deps, "FREE");
      await prisma.user.update({
        where: { id: t.owner.userId },
        data: { passwordHash: await resetSvc.hashPassword(password) },
      });
      const first = await resetSvc.createPasswordResetTokenForEmail(t.owner.email);
      // PRO-A1-09 — a second link is minted only after the per-address
      // cooldown; age the first one past it.
      await prisma.passwordResetToken.updateMany({
        where: { userId: t.owner.userId },
        data: { createdAt: new Date(Date.now() - 2 * 60_000) },
      });
      const second = await resetSvc.createPasswordResetTokenForEmail(t.owner.email);
      expect(first && second).toBeTruthy();
      const done = await resetSvc.resetPasswordWithToken({ token: first!.rawToken, newPassword: "An0ther-strong-passphrase!" });
      expect(done.ok).toBe(true);
      const stale = await resetSvc.resetPasswordWithToken({ token: second!.rawToken, newPassword: "Th1rd-strong-passphrase!!" });
      expect(stale).toEqual({ ok: false, reason: "invalid_or_expired" });
    });
  });

  // ===========================================================================
  // B1-F-020 / B1-F-011 — the self-check spends nothing; the throttle is shared
  // ===========================================================================
  describe("B1-F-020 / B1-F-011: MFA challenge verify", () => {
    it("a recovery-code self-check succeeds and leaves the code unused (and still usable)", async () => {
      await rateLimit.clearAllRateLimitBuckets();
      const u = await person("g2-selfcheck");
      const { recoveryCodes } = await mfaSvc.regenerateRecoveryBatch({ userId: u.userId });
      const code = recoveryCodes[0]!;
      const unused = async () =>
        (await prisma.mfaRecoveryCode.findFirstOrThrow({
          where: { userId: u.userId, codeLookupHash: recovery.computeLookupHash(code) },
        })).usedAt === null;
      const check = await call("POST", "/v1/identity/mfa/challenge/verify", u.token, { recoveryCode: code });
      expect(check.statusCode, check.body).toBe(200);
      expect(json(check)).toMatchObject({ ok: true, used: "recovery_code", consumed: false });
      expect(await unused()).toBe(true);
      expect(await prisma.mfaRecoveryCode.count({ where: { userId: u.userId, usedAt: null, batchInvalidatedAt: null } })).toBe(
        recoveryCodes.length,
      );
      const wrong = await call("POST", "/v1/identity/mfa/challenge/verify", u.token, { recoveryCode: "ZZZZZ-ZZZZZ" });
      expect(wrong.statusCode, wrong.body).toBe(400);
      // A sign-in still spends it.
      expect((await mfaSvc.consumeRecoveryCode({ userId: u.userId, code })).ok).toBe(true);
      expect(await unused()).toBe(false);
    });

    it("the attempt budget is one shared bucket: attempts counted elsewhere refuse this instance", async () => {
      await rateLimit.clearAllRateLimitBuckets();
      const u = await person("g2-throttle");
      // Five attempts recorded by another API instance — same canonical
      // limiter, same key, the shared store.
      for (let i = 0; i < 5; i += 1) {
        await rateLimit.enforceRateLimit({ key: `mfa:challenge-verify:${u.userId}`, max: 5, windowSec: 60, bound: "global" });
      }
      const r = await call("POST", "/v1/identity/mfa/challenge/verify", u.token, { code: "123456" });
      expect(r.statusCode, r.body).toBe(429);
      expect(json(r).error).toBe("rate_limited");
      const other = await person("g2-throttle-control");
      const ctl = await call("POST", "/v1/identity/mfa/challenge/verify", other.token, { code: "123456" });
      expect(ctl.statusCode, ctl.body).not.toBe(429);
      await rateLimit.clearAllRateLimitBuckets();
    });
  });

  // ===========================================================================
  // B7A-F-003 — a workspace operator's reconcile runs no platform-wide delete
  // ===========================================================================
  describe("B7A-F-003: operator reconciles leave other tenants' rows alone", () => {
    it("operator reconcile-stale and runtime/reconcile keep platform rows; the scheduler (machine) sweeps them", async () => {
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const handoff = await prisma.ssoNativeHandoff.create({
        data: { stateHash: createHash("sha256").update(randomUUID()).digest("hex"), codeChallenge: "x".repeat(43), expiresAtUtc: old },
        select: { id: true },
      });
      const geo = await prisma.geoIntelligenceLookup.create({
        data: { ipHash: createHash("sha256").update(randomUUID()).digest("hex"), provider: "g2-test", expiresAtUtc: old },
        select: { id: true },
      });
      const stepUp = () =>
        ceremony.approvedHeader({
          token: admin(),
          userId: A().adminUserId,
          teamId: A().teamId,
          purpose: "ORG_SECURITY_POLICY_UPDATE",
          resourceKind: "team",
          resourceId: A().teamId,
        });

      const stale = await call("POST", "/v1/admin/identity/sessions/reconcile-stale", admin(), { teamId: A().teamId }, { ...(await stepUp()), "x-proovra-workspace-id": A().teamId });
      expect(stale.statusCode, stale.body).toBe(200);
      expect(json(stale).callbackAttempts).toMatchObject({ swept: 0, skipped: "scheduler_only" });
      expect(await prisma.ssoNativeHandoff.count({ where: { id: handoff.id } })).toBe(1);

      const runtime = await call("POST", "/v1/admin/identity/runtime/reconcile", admin(), { teamId: A().teamId }, { ...(await stepUp()), "x-proovra-workspace-id": A().teamId });
      expect(runtime.statusCode, runtime.body).toBe(200);
      expect(json(runtime).geo).toMatchObject({ swept: 0, skipped: "scheduler_only" });
      expect(await prisma.geoIntelligenceLookup.count({ where: { id: geo.id } })).toBe(1);

      // The scheduler still runs the platform legs.
      const machine = { [cronHeader]: process.env.IDENTITY_RECONCILE_CRON_SECRET! };
      const ms = await call("POST", "/v1/admin/identity/sessions/reconcile-stale", null, { teamId: A().teamId }, machine);
      expect(ms.statusCode, ms.body).toBe(200);
      expect(await prisma.ssoNativeHandoff.count({ where: { id: handoff.id } })).toBe(0);
      const mr = await call("POST", "/v1/admin/identity/runtime/reconcile", null, { teamId: A().teamId }, machine);
      expect(mr.statusCode, mr.body).toBe(200);
      expect(await prisma.geoIntelligenceLookup.count({ where: { id: geo.id } })).toBe(0);
    });
  });

  // ===========================================================================
  // WS-SCHED / PRO-W2C2-02 — the scheduler runs the runtime sweeps for the fleet
  // ===========================================================================
  describe("WS-SCHED PRO-W2C2-02: the machine reconcile with no workspace sweeps every workspace", () => {
    const machine = () => ({ [cronHeader]: process.env.IDENTITY_RECONCILE_CRON_SECRET! });
    const idle = () => new Date(Date.now() - 3 * 60 * 60 * 1000);
    const session = (teamId: string, userId: string, data: Record<string, unknown> = {}) =>
      prisma.authenticatedSession.create({
        data: {
          userId,
          teamId,
          sessionIdHash: createHash("sha256").update(randomUUID()).digest("hex"),
          expiresAtUtc: future(),
          lastSeenAtUtc: idle(),
          ...data,
        } as never,
        select: { id: true },
      });
    const read = (id: string) =>
      prisma.authenticatedSession.findUniqueOrThrow({
        where: { id },
        select: { revokedAtUtc: true, quarantinedAtUtc: true, lastRiskRecomputedAtUtc: true },
      });
    const sweepAll = async () => {
      await prisma.workerSweepCursor.deleteMany({ where: { key: "identity_runtime_reconcile_teams" } });
      const r = await call("POST", "/v1/admin/identity/runtime/reconcile", null, {}, machine());
      expect(r.statusCode, r.body).toBe(200);
      return json(r);
    };

    it("with no operator action: due quarantines are released, sessions are re-scored, platform retention runs; nothing is revoked or decayed while enforcement is off", async () => {
      const B = h.fixtures.teamB;
      const quarantined = await session(A().teamId, A().viewerUserId, {
        quarantinedAtUtc: past(),
        quarantineReason: "SUSPICIOUS_SESSION_AUTO",
        quarantineReleaseAtUtc: past(),
      });
      const idleHere = await session(A().teamId, A().viewerUserId);
      const idleOtherWorkspace = await session(B.teamId, B.ownerUserId);
      const device = await prisma.trustedDevice.create({
        data: {
          teamId: A().teamId,
          userId: A().viewerUserId,
          deviceIdHash: createHash("sha256").update(randomUUID()).digest("hex"),
          uaPreview: "ws-sched-agent",
          ipPreview: "203.0.113.0/24",
          trustedUntilUtc: future(),
          lastSeenAtUtc: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
        } as never,
        select: { id: true },
      });
      const geo = await prisma.geoIntelligenceLookup.create({
        data: { ipHash: createHash("sha256").update(randomUUID()).digest("hex"), provider: "ws-sched", expiresAtUtc: past() },
        select: { id: true },
      });

      delete process.env.IDENTITY_RUNTIME_SCHEDULED_ENFORCEMENT;
      const out = await sweepAll();
      expect(out).toMatchObject({ scope: "all_workspaces", enforcement: false, failedTeams: 0 });
      expect(out.teamsVisited).toBeGreaterThanOrEqual(2);
      expect(out.totals.quarantineReleased).toBeGreaterThanOrEqual(1);
      expect(out.totals.staleSessionsRevoked).toBe(0);
      expect(out.totals.escalatedToQuarantine).toBe(0);

      expect((await read(quarantined.id)).quarantinedAtUtc).toBeNull();
      // Both workspaces were reached (the second one had no operator at all).
      expect((await read(idleHere.id)).lastRiskRecomputedAtUtc).toBeInstanceOf(Date);
      expect((await read(idleOtherWorkspace.id)).lastRiskRecomputedAtUtc).toBeInstanceOf(Date);
      // Idle is detected, never revoked, and the stale device keeps its trust.
      expect(out.totals.staleSessionsDetected).toBeGreaterThanOrEqual(2);
      expect((await read(idleHere.id)).revokedAtUtc).toBeNull();
      expect((await read(idleOtherWorkspace.id)).revokedAtUtc).toBeNull();
      expect((await prisma.trustedDevice.findUniqueOrThrow({ where: { id: device.id } })).status).toBe("ACTIVE");
      expect(await prisma.geoIntelligenceLookup.count({ where: { id: geo.id } })).toBe(0);

      await prisma.trustedDevice.delete({ where: { id: device.id } });
    });

    it("with enforcement on: idle sessions are revoked only where the organization configured an idle timeout, at that value; stale devices decay", async () => {
      const B = h.fixtures.teamB;
      const orgB = (await prisma.team.findUniqueOrThrow({ where: { id: B.teamId }, select: { organizationId: true } })).organizationId;
      const policy = await prisma.organizationSecurityPolicy.findFirst({ where: { organizationId: orgId }, select: { id: true, idleTimeoutSeconds: true } });
      const policyId = policy
        ? policy.id
        : (await prisma.organizationSecurityPolicy.create({ data: { organizationId: orgId } as never, select: { id: true } })).id;
      await prisma.organizationSecurityPolicy.update({ where: { id: policyId }, data: { idleTimeoutSeconds: 3600 } });
      if (orgB && orgB !== orgId) {
        await prisma.organizationSecurityPolicy.updateMany({ where: { organizationId: orgB }, data: { idleTimeoutSeconds: null } });
      }

      const idlePastPolicy = await session(A().teamId, A().viewerUserId);
      const idleWithinPolicy = await session(A().teamId, A().viewerUserId, { lastSeenAtUtc: new Date(Date.now() - 40 * 60 * 1000) });
      const idleNoPolicy = orgB && orgB !== orgId ? await session(B.teamId, B.ownerUserId) : null;
      const device = await prisma.trustedDevice.create({
        data: {
          teamId: A().teamId,
          userId: A().viewerUserId,
          deviceIdHash: createHash("sha256").update(randomUUID()).digest("hex"),
          uaPreview: "ws-sched-agent",
          ipPreview: "203.0.113.0/24",
          trustedUntilUtc: future(),
          lastSeenAtUtc: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
        } as never,
        select: { id: true },
      });

      process.env.IDENTITY_RUNTIME_SCHEDULED_ENFORCEMENT = "true";
      try {
        const out = await sweepAll();
        expect(out).toMatchObject({ scope: "all_workspaces", enforcement: true });
        expect((await read(idlePastPolicy.id)).revokedAtUtc).toBeInstanceOf(Date);
        // 40 minutes idle is past the operator sweep's 30-minute default but
        // inside the hour this organization configured.
        expect((await read(idleWithinPolicy.id)).revokedAtUtc).toBeNull();
        if (idleNoPolicy) expect((await read(idleNoPolicy.id)).revokedAtUtc).toBeNull();
        const after = await prisma.trustedDevice.findUniqueOrThrow({ where: { id: device.id }, select: { trustScoreDecay: true, status: true } });
        expect(after.trustScoreDecay > 0 || after.status === "REVOKED").toBe(true);

        // A second sweep is a no-op for the revoked session (no double revoke).
        const again = await sweepAll();
        expect(again.failedTeams).toBe(0);
      } finally {
        delete process.env.IDENTITY_RUNTIME_SCHEDULED_ENFORCEMENT;
        await prisma.organizationSecurityPolicy.update({ where: { id: policyId }, data: { idleTimeoutSeconds: policy?.idleTimeoutSeconds ?? null } });
        await prisma.trustedDevice.deleteMany({ where: { id: device.id } });
      }
    });

    it("the per-workspace machine call and the operator path are unchanged", async () => {
      const one = await call("POST", "/v1/admin/identity/runtime/reconcile", null, { teamId: A().teamId }, machine());
      expect(one.statusCode, one.body).toBe(200);
      expect(json(one).teamId).toBe(A().teamId);
      expect(json(one).scope).toBeUndefined();
      // No secret and no session: the fleet mode is not reachable.
      const anon = await call("POST", "/v1/admin/identity/runtime/reconcile", null, {});
      expect(anon.statusCode).toBe(401);
    });
  });

  // ===========================================================================
  // B1-F-015 — closure says the account export holds no records
  // ===========================================================================
  describe("B1-F-015: the closure preview states that records are not in the account export", () => {
    it("an owner of records sees RECORDS_NOT_IN_ACCOUNT_EXPORT among the consequences", async () => {
      const r = await call("GET", "/v1/identity/account-closure", h.fixtures.personal.token);
      expect(r.statusCode, r.body).toBe(200);
      const c = (json(r).consequences as Array<{ code: string; message: string; count: number }>).find(
        (x) => x.code === "RECORDS_NOT_IN_ACCOUNT_EXPORT",
      );
      expect(c).toBeDefined();
      expect(c!.count).toBeGreaterThanOrEqual(1);
      expect(c!.message).toMatch(/not evidence files, reports or verification packages/);
      const empty = await person("g2-no-records");
      const none = await call("GET", "/v1/identity/account-closure", empty.token);
      expect(none.statusCode, none.body).toBe(200);
      expect((json(none).consequences as Array<{ code: string }>).some((x) => x.code === "RECORDS_NOT_IN_ACCOUNT_EXPORT")).toBe(false);
    });
  });

  // ===========================================================================
  // B5B-F-302 recheck — the organization-link approval is web-only
  // ===========================================================================
  describe("B5B-F-302 recheck: approving an organization link needs the browser's pending-link cookie", () => {
    it("a native (bearer, cookie-less) caller sees no pending link and cannot approve one, even naming a ticket in the body or a header", async () => {
      const u = await person("g2-native-link");
      const pending = await call("GET", "/v1/identity/links/organization", u.token);
      expect(pending.statusCode, pending.body).toBe(200);
      expect(json(pending).pending).toBeNull();
      const memberships = () => prisma.organizationMembership.count({ where: { userId: u.userId } });
      const before = await memberships();
      const approve = await call(
        "POST",
        "/v1/identity/links/organization",
        u.token,
        { ticket: "forged.ticket.value" },
        { "x-proovra-organization-link": "forged.ticket.value" },
      );
      expect(approve.statusCode, approve.body).toBe(404);
      expect(json(approve).error.code).toBe("organization_link_not_found");
      expect(await memberships()).toBe(before);
    });
  });

  // ===========================================================================
  // B7A-F-005 — staff listing records with titles and owner emails is audited
  // ===========================================================================
  describe("B7A-F-005: a platform staff evidence-records roster read writes one audit row", () => {
    it("GET /v1/admin/evidence-health/records?signal=… writes admin.evidence_records_listed with the filter", async () => {
      const staff = await person("g2-staff");
      await prisma.user.update({ where: { id: staff.userId }, data: { platformRole: "admin" } });
      const token = await h.mintSessionToken(staff.userId, staff.email, { mfaVerified: true });
      await fx.registerSessionForToken(deps, staff.userId, token);
      const rows = () => prisma.adminAuditLog.count({ where: { userId: staff.userId, action: "admin.evidence_records_listed" } });
      const before = await rows();
      const r = await call("GET", "/v1/admin/evidence-health/records?signal=TSA_FAILED", token);
      expect(r.statusCode, r.body).toBe(200);
      expect(await rows()).toBe(before + 1);
      const row = await prisma.adminAuditLog.findFirstOrThrow({
        where: { userId: staff.userId, action: "admin.evidence_records_listed" },
        orderBy: { createdAt: "desc" },
      });
      expect(JSON.stringify(row)).toContain("TSA_FAILED");
    });
  });
});
