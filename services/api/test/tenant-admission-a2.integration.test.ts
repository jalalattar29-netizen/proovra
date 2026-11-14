/**
 * TENANT ADMISSION — free-user audit A2-02 / A2-03 / A2-05 (live PostgreSQL).
 *
 *   A2-02  An external-review token kept working after its Organization was
 *          suspended: `lookupExternalReviewGrantByToken` checked state, expiry
 *          and legal hold only, so every token and portal path failed open.
 *   A2-03  `GET /v1/reviewer-ops/console` admitted on a bare `status ===
 *          "ACTIVE"` read and had no plan gate, while the same queue data is
 *          REVIEW_TASKS_AND_QUEUES on the reviewer-ops routes.
 *   A2-05  `POST /v1/cases` and the case access manager admitted on the same
 *          bare status read, so a member whose access had expired could create
 *          a case or widen a case's access list.
 *
 * Every refusal has a positive control on the same route.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Person = { id: string; token: string };
type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

describe("tenant admission: org lifecycle, access expiry and plan (A2-02 / A2-03 / A2-05)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let legalVersions: Record<string, string>;
  let grants: typeof import("../src/services/external-review/external-review-grant.service.js");
  const A = () => h.fixtures.teamA;
  const B = () => h.fixtures.teamB;

  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const get = (url: string, who: Person) => h.app.inject({ method: "GET", url, headers: bearer(who.token) });
  const post = (url: string, who: Person, payload: unknown) =>
    h.app.inject({ method: "POST", url, headers: bearer(who.token), payload: payload as never });
  const ownerA = (): Person => ({ id: A().ownerUserId, token: A().ownerToken });
  const ownerB = (): Person => ({ id: B().ownerUserId, token: B().ownerToken });

  async function person(teamId: string, role: Role, opts: { expired?: boolean } = {}): Promise<Person> {
    const email = `a2adm-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, provider: "EMAIL", providerUserId: email, currentWorkspaceId: teamId } as never,
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
    await prisma.teamMember.create({
      data: {
        teamId,
        userId: user.id,
        role,
        // The row still says ACTIVE: nothing flips it when access expires.
        status: "ACTIVE",
        ...(opts.expired ? { accessExpiresAtUtc: new Date(Date.now() - 60_000) } : {}),
      },
    });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, token };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    ({ REQUIRED_LEGAL_VERSIONS: legalVersions } = (await import("../src/legal/legal-versioning.js")) as never);
    grants = await import("../src/services/external-review/external-review-grant.service.js");
    // A includes cases and the shared review queues; B is a PRO workspace,
    // which includes record review but not the TEAM-tier queues.
    await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
    await prisma.team.update({ where: { id: B().teamId }, data: { billingPlan: "PRO", billingStatus: "ACTIVE" } });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  async function withOrganizationSuspended(teamId: string, fn: () => Promise<void>): Promise<void> {
    const { organizationId } = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    expect(organizationId).toBeTruthy();
    await prisma.organization.update({ where: { id: organizationId! }, data: { status: "SUSPENDED" } as never });
    try {
      await fn();
    } finally {
      await prisma.organization.update({ where: { id: organizationId! }, data: { status: "ACTIVE" } as never });
    }
  }

  // ===========================================================================
  // A2-02
  // ===========================================================================
  describe("A2-02: an external-review token answers to its Organization's lifecycle", () => {
    it("a live grant resolves; the same token is grant_not_active while the Organization is suspended", async () => {
      const issued = await grants.issueExternalReviewGrant(
        {
          teamId: A().teamId,
          invitedByUserId: A().ownerUserId,
          scopeKind: "EVIDENCE",
          evidenceId: A().evidenceId,
          reviewerEmail: `outside-${tag()}@reviewer.test`,
          expiresAtUtc: new Date(Date.now() + 86_400_000),
        },
        prisma,
      );
      if (!issued.ok) throw new Error(`grant not issued: ${issued.reason}`);
      await prisma.externalReviewGrant.update({ where: { id: issued.grant.id }, data: { state: "ACTIVE" } as never });

      const live = await grants.lookupExternalReviewGrantByToken(issued.rawToken, prisma);
      expect(live.ok).toBe(true);
      const liveContext = await h.app.inject({ method: "GET", url: `/v1/external-review/access/${issued.rawToken}/context` });
      expect(liveContext.statusCode, liveContext.body).not.toBe(401);

      await withOrganizationSuspended(A().teamId, async () => {
        expect(await grants.lookupExternalReviewGrantByToken(issued.rawToken, prisma)).toEqual({
          ok: false,
          reason: "grant_not_active",
        });
        const refused = await h.app.inject({ method: "GET", url: `/v1/external-review/access/${issued.rawToken}/context` });
        expect(refused.statusCode, refused.body).toBe(401);
        expect(refused.json()).toEqual({ error: { code: "grant_not_active" } });
      });

      // Reinstated, the same token works again: nothing was revoked or rewritten.
      expect((await grants.lookupExternalReviewGrantByToken(issued.rawToken, prisma)).ok).toBe(true);
    });
  });

  // ===========================================================================
  // A2-03
  // ===========================================================================
  describe("A2-03: the reviewer console uses the reviewer-ops admission and queues plan gate", () => {
    const consoleUrl = (teamId: string) => `/v1/reviewer-ops/console?teamId=${teamId}`;

    it("an expired member is blocked; an ACTIVE member of the same workspace is served", async () => {
      const expired = await person(A().teamId, "MEMBER", { expired: true });
      const refused = await get(consoleUrl(A().teamId), expired);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json()).toMatchObject({ error: { code: "REVIEW_ACTOR_BLOCKED", reason: "member_access_expired" } });

      const active = await person(A().teamId, "MEMBER");
      const served = await get(consoleUrl(A().teamId), active);
      expect(served.statusCode, served.body).toBe(200);
      expect(served.json()).toMatchObject({ teamId: A().teamId, reviewer: { userId: active.id } });
    });

    it("a member of a suspended Organization is blocked", async () => {
      await withOrganizationSuspended(A().teamId, async () => {
        const r = await get(consoleUrl(A().teamId), ownerA());
        expect(r.statusCode, r.body).toBe(403);
        expect(r.json()).toMatchObject({ error: { code: "REVIEW_ACTOR_BLOCKED" } });
      });
    });

    it("a PRO workspace's owner is refused the queues (ENTITLEMENT_REQUIRED), as on reviewer-ops", async () => {
      const r = await get(consoleUrl(B().teamId), ownerB());
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json()).toMatchObject({
        error: { code: "ENTITLEMENT_REQUIRED", entitlement: "REVIEW_TASKS_AND_QUEUES" },
      });
      const queue = await get(`/v1/reviewer-ops/queue?teamId=${B().teamId}`, ownerB());
      expect(queue.statusCode, queue.body).toBe(403);
    });

    it("a non-member still learns nothing (404)", async () => {
      const r = await get(consoleUrl(A().teamId), ownerB());
      expect(r.statusCode, r.body).toBe(404);
    });
  });

  // ===========================================================================
  // A2-05
  // ===========================================================================
  describe("A2-05: case creation and the case access manager answer to the canonical engine", () => {
    it("POST /v1/cases: an expired member is refused and nothing is written; an ACTIVE member creates", async () => {
      const expired = await person(A().teamId, "MEMBER", { expired: true });
      const name = `a2-05-expired-${tag()}`;
      const refused = await post("/v1/cases", expired, { name, teamId: A().teamId });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(await prisma.case.count({ where: { name } })).toBe(0);

      const active = await person(A().teamId, "MEMBER");
      const created = await post("/v1/cases", active, { name: `a2-05-active-${tag()}`, teamId: A().teamId });
      expect(created.statusCode, created.body).toBe(201);
    });

    it("POST /v1/cases: a member of a suspended Organization is refused", async () => {
      const name = `a2-05-suspended-${tag()}`;
      await withOrganizationSuspended(A().teamId, async () => {
        const r = await post("/v1/cases", ownerA(), { name, teamId: A().teamId });
        expect(r.statusCode, r.body).toBe(403);
      });
      expect(await prisma.case.count({ where: { name } })).toBe(0);
    });

    it("POST /v1/cases/:id/access: an expired ADMIN cannot widen a case's list; an ACTIVE ADMIN can", async () => {
      const caseId = (
        await prisma.case.create({
          data: { name: `a2-05-access-${tag()}`, teamId: A().teamId, ownerUserId: A().ownerUserId },
          select: { id: true },
        })
      ).id;
      const target = await person(A().teamId, "MEMBER");

      const expiredAdmin = await person(A().teamId, "ADMIN", { expired: true });
      const refused = await post(`/v1/cases/${caseId}/access`, expiredAdmin, { userId: target.id });
      // No active membership and no grant: answered exactly like a missing case (D47).
      expect(refused.statusCode, refused.body).toBe(404);
      expect(await prisma.caseAccess.count({ where: { caseId } })).toBe(0);

      const activeAdmin = await person(A().teamId, "ADMIN");
      const granted = await post(`/v1/cases/${caseId}/access`, activeAdmin, { userId: target.id });
      expect(granted.statusCode, granted.body).toBeLessThan(300);
      expect(await prisma.caseAccess.count({ where: { caseId, userId: target.id } })).toBe(1);
    });
  });
});
