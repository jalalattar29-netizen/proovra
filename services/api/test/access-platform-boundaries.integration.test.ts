/**
 * Round 3, batch access-platform — live PostgreSQL 16, the real routes.
 *
 *   PRO-003            high-security readiness reads only the target
 *                      organization's managed identities, all of them, and
 *                      readiness and activation agree.
 *   PRO-039 / RT-020   suspending an organization member pauses their access
 *                      to the organization's workspaces; restore reinstates
 *                      exactly what the suspension paused.
 *   PRO-043            a support grant's start audit names the staff anchor.
 *   PRO-081            the two targeted staff detail reads are audited.
 *   PRO-082            anonymous analytics intake cannot attribute events.
 *
 * Every refusal is checked on the rows it must not have written; every case
 * has its authorized positive control.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = import("@prisma/client").PrismaClient;

describe("access and platform boundaries (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let fixtures: typeof import("./point7/product-fixtures.js");
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let policy: typeof import("../src/services/identity/org-security-policy.service.js");
  let rbac: typeof import("../src/services/identity/rbac.service.js");
  let support: typeof import("../src/services/identity/support-access.service.js");

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const deps = () => ({
    prisma: prisma as never,
    tag: `ap-${randomUUID().slice(0, 8)}`,
    mintToken: (userId: string, email: string) =>
      signJwt(
        { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000), mfaAt: Math.floor(Date.now() / 1000) },
        process.env.AUTH_JWT_SECRET as string,
        3600,
      ),
  });
  const orgOf = async (teamId: string) =>
    (await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } })).organizationId as string;

  /**
   * A token minted strictly after the user's deny-list watermark, with its
   * session registered as a real login would (see registerSessionForToken).
   */
  async function freshToken(userId: string): Promise<string> {
    const row = await prisma.revokedSession.findFirst({
      where: { userId, scope: "ALL_FOR_USER" },
      orderBy: { revokedBeforeIat: "desc" },
      select: { revokedBeforeIat: true },
    });
    const floor = Number(row?.revokedBeforeIat ?? 0n);
    const deadline = Date.now() + 5_000;
    while (Math.floor(Date.now() / 1000) <= floor && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    const d = deps();
    const token = d.mintToken(userId, user.email ?? "");
    await fixtures.registerSessionForToken(d, userId, token);
    return token;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    fixtures = await import("./point7/product-fixtures.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
    policy = await import("../src/services/identity/org-security-policy.service.js");
    rbac = await import("../src/services/identity/rbac.service.js");
    support = await import("../src/services/identity/support-access.service.js");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // PRO-003
  // ===========================================================================
  describe("PRO-003 — high-security readiness is scoped to the target organization", () => {
    it("another organization's managed user never appears; the organization's own does, past the first page; activation agrees", async () => {
      const { teamA, teamB } = h.fixtures;
      const orgA = await orgOf(teamA.teamId);
      const orgB = await orgOf(teamB.teamId);
      const url = `/v1/security-policy/high-security/readiness?organizationId=${orgA}`;
      const created: { users: string[]; evidence: string[] } = { users: [], evidence: [] };
      try {
        // The victim: B's owner, managed by B, with personal custody.
        await prisma.user.update({
          where: { id: teamB.ownerUserId },
          data: { identityMode: "MANAGED_ENTERPRISE", managingOrganizationId: orgB },
        });
        const victimEvidence = await prisma.evidence.create({
          data: { type: "PHOTO", status: "CREATED", title: "ap B personal custody", ownerUserId: teamB.ownerUserId },
          select: { id: true },
        });
        created.evidence.push(victimEvidence.id);

        const foreignOnly = await h.app.inject({ method: "GET", url, headers: bearer(teamA.ownerToken) });
        expect(foreignOnly.statusCode, foreignOnly.body).toBe(200);
        const foreignBody = JSON.parse(foreignOnly.body);
        expect(foreignBody.prerequisites.unresolvedPersonalCustodyUserIds).not.toContain(teamB.ownerUserId);
        expect(foreignBody.readiness.missing ?? []).not.toContain("unresolved_personal_custody");
        // The activation transaction reads the same set: B's custody does not block A.
        const activationForeign = await policy.activateHighSecurityMode({ organizationId: orgA, actorUserId: teamA.ownerUserId });
        expect(activationForeign.ok).toBe(false);
        if (!activationForeign.ok) expect(activationForeign.missing).not.toContain("unresolved_personal_custody");

        // A's own managed population, more than one page of it (the read used
        // to stop at 500). The identity with custody sorts LAST.
        const ids = Array.from({ length: 503 }, () => randomUUID()).sort();
        await prisma.user.createMany({
          data: ids.map((id) => ({
            id,
            email: `ap-managed-${id}@test.proovra.local`,
            provider: "EMAIL" as const,
            providerUserId: `ap-managed-${id}@test.proovra.local`,
            identityMode: "MANAGED_ENTERPRISE" as const,
            managingOrganizationId: orgA,
          })),
        });
        created.users.push(...ids);
        const last = ids[ids.length - 1]!;
        const own = await prisma.evidence.create({
          data: { type: "PHOTO", status: "CREATED", title: "ap A personal custody", ownerUserId: last },
          select: { id: true },
        });
        created.evidence.push(own.id);

        const res = await h.app.inject({ method: "GET", url, headers: bearer(teamA.ownerToken) });
        expect(res.statusCode, res.body).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.prerequisites.unresolvedPersonalCustodyUserIds).toEqual([last]);
        expect(body.readiness.missing).toContain("unresolved_personal_custody");
        const activation = await policy.activateHighSecurityMode({ organizationId: orgA, actorUserId: teamA.ownerUserId });
        expect(activation.ok).toBe(false);
        if (!activation.ok) expect(activation.missing).toContain("unresolved_personal_custody");
      } finally {
        await prisma.evidence.deleteMany({ where: { id: { in: created.evidence } } });
        await prisma.user.deleteMany({ where: { id: { in: created.users } } });
        await prisma.user.update({
          where: { id: teamB.ownerUserId },
          data: { identityMode: "STANDARD", managingOrganizationId: null },
        });
      }
    }, 180_000);
  });

  // ===========================================================================
  // PRO-039 / RT-020
  // ===========================================================================
  describe("PRO-039 / RT-020 — organization member suspension pauses workspace access", () => {
    it("suspend: workspace access stops after a fresh sign-in; restore: it returns; an individually suspended workspace membership stays suspended", async () => {
      // An Enterprise organization with seats to spare, so a reinstatement is
      // not refused for capacity (that refusal is its own, correct, outcome).
      const d = deps();
      const t = await fixtures.seedOrganizationTenant(d);
      const orgA = t.organizationId;
      const workspaceId = t.workspaceId;
      const join = async (label: string) => {
        const u = await fixtures.seedUser(d, label);
        const m = await prisma.organizationMembership.create({
          data: { organizationId: orgA, userId: u.userId, role: "ORG_MEMBER" },
          select: { id: true },
        });
        await prisma.teamMember.create({ data: { teamId: workspaceId, userId: u.userId, role: "MEMBER", status: "ACTIVE" } });
        return { userId: u.userId, membershipId: m.id };
      };
      const memberRow = await join("ap-member");
      const viewerRow = await join("ap-viewer");
      const member = memberRow.userId;
      const viewer = viewerRow.userId;
      const memberMembership = memberRow.membershipId;
      const viewerMembership = viewerRow.membershipId;
      const evidence = await prisma.evidence.create({
        data: {
          teamId: workspaceId,
          organization: { connect: { id: orgA } },
          type: "PHOTO",
          ownerUserId: t.owner.userId,
          uploadedByUserId: t.owner.userId,
          status: "SIGNED",
          title: "ap org workspace record",
        },
        select: { id: true },
      });
      const teamRow = (userId: string) =>
        prisma.teamMember.findUniqueOrThrow({
          where: { teamId_userId: { teamId: workspaceId, userId } },
          select: { status: true, suspensionReason: true },
        });
      const read = (token: string) =>
        h.app.inject({ method: "GET", url: `/v1/evidence/${evidence.id}`, headers: bearer(token) });
      const act = (membershipId: string, action: "suspend" | "restore") =>
        h.app.inject({
          method: "POST",
          url: `/v1/orgs/${orgA}/members/${membershipId}/${action}`,
          headers: { ...bearer(t.owner.token), "content-type": "application/json" },
          payload: action === "suspend" ? { reason: "ap suspension probe" } : {},
        });

      // Positive control before anything moves.
      const before = await read(await freshToken(member));
      expect(before.statusCode, before.body).toBe(200);

      // A workspace administrator's own suspension of the viewer, with its own
      // reason, before the organization acts.
      await prisma.teamMember.update({
        where: { teamId_userId: { teamId: workspaceId, userId: viewer } },
        data: { status: "SUSPENDED", suspendedAtUtc: new Date(), suspensionReason: "workspace admin decision" },
      });

      {
        const suspended = await act(memberMembership, "suspend");
        expect(suspended.statusCode, suspended.body).toBe(200);
        expect(JSON.parse(suspended.body)).toMatchObject({ status: "SUSPENDED", workspacesSuspended: 1 });
        expect(await teamRow(member)).toEqual({ status: "SUSPENDED", suspensionReason: rbac.ORG_MEMBER_SUSPENSION_WORKSPACE_MARKER });

        // The defect: a fresh sign-in read the record again (200).
        const afterLogin = await read(await freshToken(member));
        expect(afterLogin.statusCode, "a suspended organization member read workspace evidence after signing in again").not.toBe(200);
        expect(afterLogin.body).not.toContain("ap org workspace record");

        const viewerSuspended = await act(viewerMembership, "suspend");
        expect(viewerSuspended.statusCode, viewerSuspended.body).toBe(200);
        expect(JSON.parse(viewerSuspended.body).workspacesSuspended).toBe(0);

        // Restore returns exactly what the suspension paused.
        const restored = await act(memberMembership, "restore");
        expect(restored.statusCode, restored.body).toBe(200);
        expect(JSON.parse(restored.body)).toMatchObject({ status: "ACTIVE", workspacesRestored: 1 });
        expect(await teamRow(member)).toEqual({ status: "ACTIVE", suspensionReason: null });
        expect((await read(await freshToken(member))).statusCode).toBe(200);

        const viewerRestored = await act(viewerMembership, "restore");
        expect(viewerRestored.statusCode, viewerRestored.body).toBe(200);
        expect(JSON.parse(viewerRestored.body).workspacesRestored).toBe(0);
        expect(await teamRow(viewer), "an organization restore reinstated a workspace administrator's own suspension").toEqual({
          status: "SUSPENDED",
          suspensionReason: "workspace admin decision",
        });
      }
    }, 180_000);

    it("a workspace owner cannot be suspended at the organization level until ownership moves (removal's rule)", async () => {
      const d = deps();
      const t = await fixtures.seedOrganizationTenant(d);
      const coOwner = await fixtures.seedUser(d, "co-owner");
      const coMembership = await prisma.organizationMembership.create({
        data: { organizationId: t.organizationId, userId: coOwner.userId, role: "ORG_OWNER" },
        select: { id: true },
      });
      // The co-owner owns a second workspace of the organization.
      const second = await prisma.team.create({
        data: {
          name: `ap-second-${randomUUID().slice(0, 6)}`,
          ownerUserId: coOwner.userId,
          billingOwnerUserId: coOwner.userId,
          organizationId: t.organizationId,
          isPersonal: false,
          workspaceKind: "ORGANIZATION",
          billingPlan: "ENTERPRISE",
          billingStatus: "ACTIVE",
        },
        select: { id: true },
      });
      await prisma.teamMember.create({ data: { teamId: second.id, userId: coOwner.userId, role: "OWNER", status: "ACTIVE" } });
      const res = await h.app.inject({
        method: "POST",
        url: `/v1/orgs/${t.organizationId}/members/${coMembership.id}/suspend`,
        headers: { ...bearer(t.owner.token), "content-type": "application/json" },
        payload: { reason: "ap owner probe" },
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body).error.code).toBe("OWNERSHIP_TRANSFER_REQUIRED");
      const row = await prisma.organizationMembership.findUniqueOrThrow({ where: { id: coMembership.id }, select: { status: true } });
      expect(row.status).toBe("ACTIVE");
      const ws = await prisma.teamMember.findUniqueOrThrow({
        where: { teamId_userId: { teamId: second.id, userId: coOwner.userId } },
        select: { status: true },
      });
      expect(ws.status).toBe("ACTIVE");
    }, 180_000);
  });

  // ===========================================================================
  // PRO-043
  // ===========================================================================
  describe("PRO-043 — the support grant's audit names the staff anchor beside the customer", () => {
    it("records anchorTeamId on identity.support_access.started", async () => {
      const { teamA, teamB } = h.fixtures;
      const orgB = await orgOf(teamB.teamId);
      const grant = await support.startSupportAccess({
        supportUserId: teamA.adminUserId,
        organizationId: orgB,
        reason: "ap support anchor probe",
        approvedByUserId: teamB.ownerUserId,
        anchorTeamId: teamA.teamId,
      });
      const audit = await prisma.adminAuditLog.findFirst({
        where: { action: "identity.support_access.started", resourceId: orgB, userId: teamA.adminUserId },
        orderBy: { createdAt: "desc" },
        select: { metadata: true, organizationId: true },
      });
      expect(audit?.organizationId).toBe(orgB);
      expect(audit?.metadata).toMatchObject({ grantId: grant.id, anchorTeamId: teamA.teamId });
      await support.revokeSupportAccess({ grantId: grant.id, revokedByUserId: teamA.adminUserId });
    });
  });

  // ===========================================================================
  // PRO-081
  // ===========================================================================
  describe("PRO-081 — targeted staff reads of named customer data are audited (ADM-022)", () => {
    it("evidence-health record by id and contact-sales detail each write one audit row; the rosters write none", async () => {
      const d = deps();
      const admin = await fixtures.seedUser(d, "ap-admin");
      await prisma.user.update({ where: { id: admin.userId }, data: { platformRole: "admin" } });
      const lead = await prisma.contactSalesRequest.create({
        data: {
          fullName: "Ap Lead",
          workEmail: `ap-lead-${randomUUID().slice(0, 6)}@test.proovra.local`,
          organization: "Ap Lead Co",
          discussionTopic: "pricing",
          stage: "evaluating",
          currentChallenge: "synthetic",
        },
        select: { id: true },
      });
      const rows = () => prisma.adminAuditLog.count({ where: { userId: admin.userId } });
      const get = (url: string) => h.app.inject({ method: "GET", url, headers: bearer(admin.token) });

      const before = await rows();
      const roster = await get("/v1/admin/contact-sales");
      expect(roster.statusCode, roster.body).toBe(200);
      expect(await rows(), "the roster is not a targeted read").toBe(before);

      const detail = await get(`/v1/admin/contact-sales/${lead.id}`);
      expect(detail.statusCode, detail.body).toBe(200);
      expect(await rows()).toBe(before + 1);
      const leadAudit = await prisma.adminAuditLog.findFirst({
        where: { userId: admin.userId, resourceId: lead.id },
        select: { action: true, resourceType: true },
      });
      expect(leadAudit).toEqual({ action: "admin.contact_sales.view", resourceType: "contact_sales_request" });

      const record = await get(`/v1/admin/evidence-health/records?evidenceId=${h.fixtures.teamB.evidenceId}`);
      expect(record.statusCode, record.body).toBe(200);
      expect(await rows()).toBe(before + 2);
      const recordAudit = await prisma.adminAuditLog.findFirst({
        where: { userId: admin.userId, resourceId: h.fixtures.teamB.evidenceId },
        select: { action: true, resourceType: true },
      });
      expect(recordAudit).toEqual({ action: "admin.evidence_record_viewed", resourceType: "evidence" });

      // A non-staff caller is refused and leaves no read audit.
      const refused = await h.app.inject({
        method: "GET",
        url: `/v1/admin/contact-sales/${lead.id}`,
        headers: bearer(h.fixtures.teamA.ownerToken),
      });
      expect([401, 403, 404]).toContain(refused.statusCode);
      expect(
        await prisma.adminAuditLog.count({ where: { resourceId: lead.id, action: "admin.contact_sales.view", userId: h.fixtures.teamA.ownerUserId } }),
      ).toBe(0);
    });
  });

  // ===========================================================================
  // PRO-082
  // ===========================================================================
  describe("PRO-082 — analytics intake takes identity from authentication only", () => {
    it("a body userId is ignored when anonymous or with an invalid token; a valid token attributes to its subject", async () => {
      const victim = h.fixtures.teamB.ownerUserId;
      const track = (headers: Record<string, string>, sessionId: string) =>
        h.app.inject({
          method: "POST",
          url: "/v1/analytics/track",
          headers: { "content-type": "application/json", ...headers },
          payload: { eventType: "page_view", userId: victim, sessionId, visitorId: `v-${sessionId}`, path: "/pricing" },
        });
      const eventUser = async (sessionId: string) => {
        const event = await prisma.analyticsEvent.findFirst({ where: { sessionId }, select: { userId: true } });
        const session = await prisma.analyticsSession.findUnique({ where: { id: sessionId }, select: { userId: true } });
        return { event: event?.userId ?? null, session: session?.userId ?? null };
      };

      const anon = `ap-anon-${randomUUID()}`;
      const anonRes = await track({}, anon);
      expect(anonRes.statusCode, anonRes.body).toBe(200);
      expect(await eventUser(anon)).toEqual({ event: null, session: null });

      const forged = `ap-forged-${randomUUID()}`;
      const forgedRes = await track({ authorization: "Bearer not-a-real-token" }, forged);
      expect(forgedRes.statusCode, forgedRes.body).toBe(200);
      expect(await eventUser(forged)).toEqual({ event: null, session: null });

      // Positive control: a verified token attributes to its own subject.
      const signed = `ap-signed-${randomUUID()}`;
      const signedRes = await track(bearer(h.fixtures.teamA.ownerToken), signed);
      expect(signedRes.statusCode, signedRes.body).toBe(200);
      expect(await eventUser(signed)).toEqual({ event: h.fixtures.teamA.ownerUserId, session: h.fixtures.teamA.ownerUserId });

      expect(await prisma.analyticsEvent.count({ where: { userId: victim, sessionId: { startsWith: "ap-" } } })).toBe(0);
    });
  });
});
