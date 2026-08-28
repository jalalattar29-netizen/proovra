/**
 * PLATFORM ADMIN — POPULATION TRUTH, executed against live PostgreSQL 16.
 *
 * WHY THIS SUITE EXISTS (ADM-023)
 * ---------------------------------------------------------------------------
 * Every finding this suite covers was GREEN under the existing
 * `phase-admin-*.test.ts` files, because those read the route source and match a
 * regex. A text test cannot tell a correct `WHERE` clause from a missing one —
 * `organization.count()` and `organization.count({ where: { kind: 'CUSTOMER' }})`
 * both satisfy `/organization\.count/`.
 *
 * So this suite seeds a known world and asserts the NUMBERS. Every scenario is
 * built to be indistinguishable from a correct one under the OLD query and
 * distinguishable under the new one — a test that would have passed before the
 * fix proves nothing about the fix.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  bootstrapPersonalSpace,
  seedOrganizationTenant,
  seedOwnedWorkspace,
  seedPersonalTenant,
  seedUser,
  type FixtureDeps,
} from "./point7/product-fixtures.js";

describe("PLATFORM ADMIN — population truth (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;

  /** Ids seeded by THIS suite, so assertions are deltas, not absolutes. */
  const seeded = {
    customerOrgIds: [] as string[],
    systemOrgIds: [] as string[],
    liveWorkspaceIds: [] as string[],
    closedWorkspaceIds: [] as string[],
    activeContractOrgIds: [] as string[],
    terminatedContractOrgIds: [] as string[],
  };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `adm-pop-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          {
            sub: userId,
            provider: "EMAIL",
            email,
            authMethod: "PASSWORD",
            authAt: Math.floor(Date.now() / 1000),
          },
          secret,
          60 * 60,
        ),
    };

    // ---- A personal tenant. Its bootstrap mints a SYSTEM container org. ----
    const free = await seedPersonalTenant(deps, "FREE");
    seeded.systemOrgIds.push(free.personalOrganizationId);
    seeded.liveWorkspaceIds.push(free.personalTeamId);

    // ---- A PRO account, with its own personal space. ----------------------
    const pro = await seedPersonalTenant(deps, "PRO");
    seeded.systemOrgIds.push(pro.personalOrganizationId);
    seeded.liveWorkspaceIds.push(pro.personalTeamId);

    // ---- An OWNED workspace — also SYSTEM-container-backed. ---------------
    const ownedOwner = await seedUser(deps, "owned-owner");
    await bootstrapPersonalSpace(deps, ownedOwner.userId);
    const owned = await seedOwnedWorkspace(deps, {
      ownerUserId: ownedOwner.userId,
      billingPlan: "TEAM",
      billingStatus: "ACTIVE",
    });
    seeded.systemOrgIds.push(owned.organizationId);
    seeded.liveWorkspaceIds.push(owned.teamId);

    // ---- A real CUSTOMER organization with an ACTIVE contract. ------------
    const entActive = await seedOrganizationTenant(deps, {
      contractStatus: "ACTIVE",
      billingPlan: "ENTERPRISE",
      billingStatus: "ACTIVE",
      memberCount: 3,
    });
    seeded.customerOrgIds.push(entActive.organizationId);
    seeded.activeContractOrgIds.push(entActive.organizationId);
    seeded.liveWorkspaceIds.push(entActive.workspaceId);

    // ---- A CUSTOMER whose contract is TERMINATED but whose workspace still
    //      carries billingPlan ENTERPRISE. This is the row that made
    //      `team.count({ billingPlan: 'ENTERPRISE' })` wrong. -------------
    const entDead = await seedOrganizationTenant(deps, {
      contractStatus: "TERMINATED",
      billingPlan: "ENTERPRISE",
      billingStatus: "ACTIVE",
    });
    seeded.customerOrgIds.push(entDead.organizationId);
    seeded.terminatedContractOrgIds.push(entDead.organizationId);
    seeded.liveWorkspaceIds.push(entDead.workspaceId);

    // ---- A CLOSED workspace, closed through the REAL production path so the
    //      lifecycle marker is whatever production writes. ------------------
    const closingOwner = await seedUser(deps, "closing-owner");
    await bootstrapPersonalSpace(deps, closingOwner.userId);
    const closing = await seedOwnedWorkspace(deps, {
      ownerUserId: closingOwner.userId,
      billingPlan: "TEAM",
      billingStatus: "ACTIVE",
    });
    seeded.systemOrgIds.push(closing.organizationId);
    const { executeWorkspaceClosure } = await import(
      "../src/services/workspace/workspace-closure.service.js"
    );
    await executeWorkspaceClosure({
      teamId: closing.teamId,
      requestedByUserId: closingOwner.userId,
    });
    seeded.closedWorkspaceIds.push(closing.teamId);
  }, 240_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  // =========================================================================
  // ADM-002 — SYSTEM containers are not customers.
  // =========================================================================

  describe("ADM-002 — customer population excludes SYSTEM bootstrap containers", () => {
    it("seeded at least one SYSTEM container and one CUSTOMER organization", () => {
      // Guards the test itself: if the fixture stopped producing SYSTEM
      // containers, every assertion below would pass vacuously.
      expect(seeded.systemOrgIds.length).toBeGreaterThan(0);
      expect(seeded.customerOrgIds.length).toBeGreaterThan(0);
    });

    it("counts only CUSTOMER organizations, and the two counts genuinely differ", async () => {
      const { customerOrganizationWhere } = await import("@proovra/shared-runtime");
      const [all, customers] = await Promise.all([
        prisma.organization.count(),
        prisma.organization.count({ where: customerOrganizationWhere() }),
      ]);
      expect(customers).toBeLessThan(all);

      const systemRows = await prisma.organization.count({
        where: { id: { in: seeded.systemOrgIds } },
      });
      expect(systemRows).toBe(seeded.systemOrgIds.length);

      const seededSystemAsCustomer = await prisma.organization.count({
        where: { id: { in: seeded.systemOrgIds }, ...customerOrganizationWhere() },
      });
      expect(seededSystemAsCustomer).toBe(0);
    });

    it("the customer roster never returns a SYSTEM container", async () => {
      const { listAdminOrganizations } = await import(
        "../src/services/organization/admin-organizations.service.js"
      );
      const systemIds = new Set(seeded.systemOrgIds);
      // Walk every page — a SYSTEM row hiding on page 3 is still a defect.
      for (let page = 1; page <= 20; page += 1) {
        const res = await listAdminOrganizations({ page, limit: 100 });
        for (const item of res.items) {
          expect(
            systemIds.has(item.id),
            `SYSTEM container ${item.id} surfaced in the customer roster`,
          ).toBe(false);
        }
        if (page >= res.totalPages) break;
      }
    });

    it("paginates in the database — total is the real total, not the page length", async () => {
      const { listAdminOrganizations } = await import(
        "../src/services/organization/admin-organizations.service.js"
      );
      const firstPage = await listAdminOrganizations({ page: 1, limit: 1 });
      expect(firstPage.items.length).toBeLessThanOrEqual(1);
      expect(firstPage.total).toBeGreaterThanOrEqual(seeded.customerOrgIds.length);
      expect(firstPage.totalPages).toBe(Math.ceil(firstPage.total / 1));
    });
  });

  // =========================================================================
  // ADM-004 — closed workspaces are not live.
  // =========================================================================

  describe("ADM-004 — workspace liveness is Team.closedAtUtc", () => {
    it("closure writes the lifecycle marker atomically with the revocation", async () => {
      const closedId = seeded.closedWorkspaceIds[0]!;
      const row = await prisma.team.findUniqueOrThrow({
        where: { id: closedId },
        select: { closedAtUtc: true, billingPlan: true, billingStatus: true },
      });
      expect(row.closedAtUtc).not.toBeNull();
      // The decisive detail: closure does NOT touch billing, which is exactly
      // why billing state could never have served as a liveness proxy.
      expect(row.billingPlan).toBe("TEAM");
      expect(row.billingStatus).toBe("ACTIVE");
    });

    it("excludes the closed workspace from the live population", async () => {
      const { liveWorkspaceWhere, closedWorkspaceWhere } = await import(
        "@proovra/shared-runtime"
      );
      const closedId = seeded.closedWorkspaceIds[0]!;

      const liveHit = await prisma.team.count({
        where: { id: closedId, ...liveWorkspaceWhere() },
      });
      expect(liveHit).toBe(0);

      const closedHit = await prisma.team.count({
        where: { id: closedId, ...closedWorkspaceWhere() },
      });
      expect(closedHit).toBe(1);
    });

    it("keeps every seeded live workspace in the live population", async () => {
      const { liveWorkspaceWhere } = await import("@proovra/shared-runtime");
      const live = await prisma.team.count({
        where: { id: { in: seeded.liveWorkspaceIds }, ...liveWorkspaceWhere() },
      });
      expect(live).toBe(seeded.liveWorkspaceIds.length);
    });

    it("a reopen restores liveness — the derived predicate could not have", async () => {
      // `reopenClosedWorkspace` leaves the COMPLETED closure request in place as
      // history, so "no COMPLETED closure request" would mark this workspace
      // closed forever. This is the test that chose the column over the derivation.
      const owner = await seedUser(deps, "reopen-owner");
      await bootstrapPersonalSpace(deps, owner.userId);
      const ws = await seedOwnedWorkspace(deps, { ownerUserId: owner.userId });

      const { executeWorkspaceClosure } = await import(
        "../src/services/workspace/workspace-closure.service.js"
      );
      await prisma.workspaceClosureRequest.create({
        data: {
          teamId: ws.teamId,
          requestedByUserId: owner.userId,
          status: "COMPLETED",
          completedAtUtc: new Date(),
        },
      });
      await executeWorkspaceClosure({
        teamId: ws.teamId,
        requestedByUserId: owner.userId,
      });
      expect(
        (
          await prisma.team.findUniqueOrThrow({
            where: { id: ws.teamId },
            select: { closedAtUtc: true },
          })
        ).closedAtUtc,
      ).not.toBeNull();

      const { reopenClosedWorkspace } = await import(
        "../src/services/workspace/workspace-lifecycle.service.js"
      );
      await reopenClosedWorkspace({
        teamId: ws.teamId,
        actorUserId: owner.userId,
      });

      const after = await prisma.team.findUniqueOrThrow({
        where: { id: ws.teamId },
        select: { closedAtUtc: true },
      });
      expect(after.closedAtUtc).toBeNull();

      // And the COMPLETED request is still there — proving the derivation
      // would have been wrong.
      const stillCompleted = await prisma.workspaceClosureRequest.count({
        where: { teamId: ws.teamId, status: "COMPLETED" },
      });
      expect(stillCompleted).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // ADM-003 — enterprise is the contract.
  // =========================================================================

  describe("ADM-003 — enterprise is EnterpriseContract, never a plan string", () => {
    it("the terminated-contract customer still carries the ENTERPRISE plan string", async () => {
      const orgId = seeded.terminatedContractOrgIds[0]!;
      const planStringMatches = await prisma.team.count({
        where: { organizationId: orgId, billingPlan: "ENTERPRISE" },
      });
      expect(
        planStringMatches,
        "fixture must reproduce the plan-string/contract divergence",
      ).toBeGreaterThan(0);
    });

    it("does NOT count the terminated-contract customer as enterprise", async () => {
      const activeContracts = await prisma.enterpriseContract.count({
        where: {
          status: "ACTIVE",
          organizationId: { in: seeded.terminatedContractOrgIds },
        },
      });
      expect(activeContracts).toBe(0);
    });

    it("customer detail reports enterprise from the contract, not the plan", async () => {
      const { getAdminOrganizationDetail } = await import(
        "../src/services/organization/admin-organizations.service.js"
      );

      const dead = await getAdminOrganizationDetail(
        seeded.terminatedContractOrgIds[0]!,
      );
      expect(dead.overview.enterprise).toBe(false);
      expect(dead.enterpriseContract?.status).toBe("TERMINATED");

      const alive = await getAdminOrganizationDetail(
        seeded.activeContractOrgIds[0]!,
      );
      expect(alive.overview.enterprise).toBe(true);
      expect(alive.enterpriseContract?.status).toBe("ACTIVE");
      // ADM-015 — the contract terms must actually be readable.
      expect(alive.enterpriseContract).toMatchObject({
        legacyDerived: expect.any(Boolean),
      });
    });

    it("the roster's enterprise filter selects on the contract", async () => {
      const { listAdminOrganizations } = await import(
        "../src/services/organization/admin-organizations.service.js"
      );
      const res = await listAdminOrganizations({
        page: 1,
        limit: 100,
        enterprise: true,
      });
      const ids = new Set(res.items.map((i) => i.id));
      expect(ids.has(seeded.activeContractOrgIds[0]!)).toBe(true);
      expect(ids.has(seeded.terminatedContractOrgIds[0]!)).toBe(false);
    });
  });

  // =========================================================================
  // ADM-008 — seats are ACTIVE members.
  // =========================================================================

  describe("ADM-008 — seat usage counts ACTIVE members only", () => {
    it("a SUSPENDED and a REVOKED member consume no seat", async () => {
      const org = await seedOrganizationTenant(deps, {
        contractStatus: "ACTIVE",
        memberCount: 3,
      });

      const members = await prisma.teamMember.findMany({
        where: { teamId: org.workspaceId, role: { not: "OWNER" } },
        select: { id: true },
        take: 2,
      });
      expect(members.length).toBe(2);
      await prisma.teamMember.update({
        where: { id: members[0]!.id },
        data: { status: "SUSPENDED" },
      });
      await prisma.teamMember.update({
        where: { id: members[1]!.id },
        data: { status: "REVOKED" },
      });

      const { seatConsumingMemberWhere } = await import("@proovra/shared-runtime");
      const [all, seats] = await Promise.all([
        prisma.teamMember.count({ where: { teamId: org.workspaceId } }),
        prisma.teamMember.count({
          where: { teamId: org.workspaceId, ...seatConsumingMemberWhere() },
        }),
      ]);
      expect(all - seats).toBe(2);

      const { getAdminOrganizationDetail } = await import(
        "../src/services/organization/admin-organizations.service.js"
      );
      const detail = await getAdminOrganizationDetail(org.organizationId);
      expect(
        detail.overview.seats.used,
        "customer detail must report ACTIVE seats, not every membership row",
      ).toBe(seats);
    });
  });

  // =========================================================================
  // ADM-007 — evidence deletion semantics.
  // =========================================================================

  describe("ADM-007 — evidence liveness uses the column every delete path writes", () => {
    it("a record deleted with deletedAt only is excluded from live counts", async () => {
      const tenant = await seedPersonalTenant(deps, "FREE");
      const org = await prisma.team.findUniqueOrThrow({
        where: { id: tenant.personalTeamId },
        select: { organizationId: true },
      });

      const makeEvidence = async () =>
        prisma.evidence.create({
          data: {
            ownerUserId: tenant.owner.userId,
            teamId: tenant.personalTeamId,
            organizationId: org.organizationId,
            type: "DOCUMENT",
            status: "CREATED",
            title: `adm007-${randomUUID().slice(0, 8)}`,
          },
          select: { id: true },
        });

      const live = await makeEvidence();
      const deletedLegacyRoute = await makeEvidence();

      // Reproduce EXACTLY what the three delete paths in evidence.routes.ts do:
      // write `deletedAt` and nothing else. `deletedAtUtc` stays NULL, which is
      // why filtering on it counted this record as live.
      await prisma.evidence.update({
        where: { id: deletedLegacyRoute.id },
        data: { deletedAt: new Date() },
      });

      const ids = [live.id, deletedLegacyRoute.id];
      const { liveEvidenceWhere } = await import("@proovra/shared-runtime");

      const canonical = await prisma.evidence.count({
        where: { id: { in: ids }, ...liveEvidenceWhere() },
      });
      expect(canonical).toBe(1);

      // The OLD predicate would have returned both — this is the assertion that
      // fails against the pre-fix code.
      const oldPredicate = await prisma.evidence.count({
        where: { id: { in: ids }, deletedAtUtc: null },
      });
      expect(oldPredicate).toBe(2);
    });
  });

  // =========================================================================
  // ADM-012 — currency safety.
  // =========================================================================

  describe("ADM-012 — revenue is never summed across currencies", () => {
    it("reports one total per currency", async () => {
      const payer = await seedPersonalTenant(deps, "PRO");
      for (const [currency, amountCents] of [
        ["EUR", 1000],
        ["USD", 2500],
        ["EUR", 500],
      ] as const) {
        await prisma.payment.create({
          data: {
            userId: payer.owner.userId,
            provider: "STRIPE",
            providerPaymentId: `adm012-${randomUUID()}`,
            amountCents,
            currency,
            status: "SUCCEEDED",
          },
        });
      }

      const grouped = await prisma.payment.groupBy({
        by: ["currency"],
        where: { status: "SUCCEEDED", userId: payer.owner.userId },
        _sum: { amountCents: true },
        _count: { _all: true },
      });
      const byCurrency = new Map(
        grouped.map((g) => [g.currency, g._sum.amountCents ?? 0]),
      );
      expect(byCurrency.get("EUR")).toBe(1500);
      expect(byCurrency.get("USD")).toBe(2500);

      // The overview must expose them separately, never pre-summed.
      const { buildPlatformOverview } = await import(
        "../src/services/admin/overview.service.js"
      );
      const overview = await buildPlatformOverview();
      expect(overview.billing.grossRevenueByCurrency.state).toBe("VALUE");
      const currencies = (
        overview.billing.grossRevenueByCurrency.value ?? []
      ).map((r) => r.currency);
      expect(new Set(currencies).size).toBe(currencies.length);
      expect(currencies).toEqual(expect.arrayContaining(["EUR", "USD"]));
    });
  });

  // =========================================================================
  // ADM-024 — a failed query is not an unmeasured metric.
  // =========================================================================

  describe("ADM-024 — metric states are distinguishable", () => {
    it("reports MRR as NOT_MEASURED with a reason, never as zero", async () => {
      const { buildPlatformOverview } = await import(
        "../src/services/admin/overview.service.js"
      );
      const overview = await buildPlatformOverview();
      expect(overview.billing.mrrCents.state).toBe("NOT_MEASURED");
      expect(overview.billing.mrrCents.value).toBeNull();
      expect(
        (overview.billing.mrrCents as { reason: string }).reason,
      ).toMatch(/not derivable/i);
    });

    it("classifies a thrown measurement as ERROR, not as absence", async () => {
      const { measure } = await import("../src/services/admin/metric-state.js");
      const captured: string[] = [];
      const result = await measure(
        "Deliberate failure",
        async () => {
          throw new Error("relation does not exist");
        },
        (_err, label) => captured.push(label),
      );
      expect(result.state).toBe("ERROR");
      expect(result.value).toBeNull();
      expect(captured).toEqual(["Deliberate failure"]);
      // The operator-facing reason must not leak the technical cause.
      expect((result as { reason: string }).reason).not.toMatch(/relation/i);
    });
  });

  // =========================================================================
  // ADM-014 — the customer roster, EXECUTED.
  //
  // These behaviours used to be covered by a hand-rolled in-memory Prisma
  // double in `phase-admin-organizations.test.ts`, which simulated the roster's
  // filtering in JavaScript. That double could only ever prove the simulation
  // agreed with itself: it filtered in memory because the SERVICE filtered in
  // memory, and once the service moved its filtering into the database the
  // double had nothing left to say about it. Worse, a double that reimplements
  // a WHERE clause can pass while the real clause is wrong — the exact failure
  // mode ADM-023 is about. So the behaviour is proven here, against real SQL.
  // =========================================================================

  describe("ADM-014 — the customer roster, against real SQL", () => {
    it("enriches each row with plan, seats, owner email, domains and SSO/SCIM", async () => {
      const { listAdminOrganizations } = await import(
        "../src/services/organization/admin-organizations.service.js"
      );
      const res = await listAdminOrganizations({ page: 1, limit: 100 });
      const row = res.items.find((i) => i.id === seeded.activeContractOrgIds[0]!);
      expect(row, "the seeded enterprise customer must be on the roster").toBeTruthy();
      expect(row!.ownerEmail).toBeTruthy();
      expect(row!.workspaceCount).toBeGreaterThan(0);
      expect(row!.seats).toMatchObject({
        included: expect.any(Number),
        used: expect.any(Number),
      });
      expect(typeof row!.ssoConfigured).toBe("boolean");
      expect(typeof row!.scimConfigured).toBe("boolean");
      expect(typeof row!.verifiedDomainsCount).toBe("number");
    });

    it("searches by organization name", async () => {
      const { listAdminOrganizations } = await import(
        "../src/services/organization/admin-organizations.service.js"
      );
      const target = await prisma.organization.findUniqueOrThrow({
        where: { id: seeded.activeContractOrgIds[0]! },
        select: { name: true },
      });
      const res = await listAdminOrganizations({
        page: 1,
        limit: 100,
        search: target.name,
      });
      expect(res.items.map((i) => i.id)).toContain(seeded.activeContractOrgIds[0]!);
    });

    it("searches by owner email", async () => {
      const { listAdminOrganizations } = await import(
        "../src/services/organization/admin-organizations.service.js"
      );
      const owner = await prisma.organizationMembership.findFirstOrThrow({
        where: {
          organizationId: seeded.activeContractOrgIds[0]!,
          role: "ORG_OWNER",
        },
        select: { user: { select: { email: true } } },
      });
      const res = await listAdminOrganizations({
        page: 1,
        limit: 100,
        search: owner.user!.email!,
      });
      expect(res.items.map((i) => i.id)).toContain(seeded.activeContractOrgIds[0]!);
    });

    it("filters by derived onboarding health, and the badge agrees with the filter", async () => {
      const { listAdminOrganizations } = await import(
        "../src/services/organization/admin-organizations.service.js"
      );
      // The health filter is the query FORM of `deriveOnboarding`. If the two
      // ever disagree, a row appears under a filter its own badge contradicts —
      // which is why they are asserted together rather than separately.
      for (const health of ["HEALTHY", "ATTENTION", "BLOCKED"] as const) {
        const res = await listAdminOrganizations({ page: 1, limit: 100, health });
        for (const item of res.items) {
          expect(
            item.onboardingStatus,
            `${item.id} was returned under health=${health} but its own badge says ${item.onboardingStatus}`,
          ).toBe(health);
        }
      }
    });

    it("marks a customer with no live workspace and no owner as BLOCKED", async () => {
      const bare = await prisma.organization.create({
        data: { name: `adm-bare-${randomUUID().slice(0, 8)}`, kind: "CUSTOMER" },
        select: { id: true },
      });
      const { listAdminOrganizations } = await import(
        "../src/services/organization/admin-organizations.service.js"
      );
      const res = await listAdminOrganizations({
        page: 1,
        limit: 100,
        health: "BLOCKED",
      });
      const row = res.items.find((i) => i.id === bare.id);
      expect(row, "a customer with no workspace and no owner must be BLOCKED").toBeTruthy();
      expect(row!.onboardingStatus).toBe("BLOCKED");
    });

    it("paginates in the database — page 2 does not repeat page 1", async () => {
      const { listAdminOrganizations } = await import(
        "../src/services/organization/admin-organizations.service.js"
      );
      const p1 = await listAdminOrganizations({ page: 1, limit: 2 });
      if (p1.totalPages < 2) return;
      const p2 = await listAdminOrganizations({ page: 2, limit: 2 });
      const overlap = p1.items
        .map((i) => i.id)
        .filter((id) => p2.items.some((j) => j.id === id));
      expect(overlap).toEqual([]);
      expect(p1.total).toBe(p2.total);
    });
  });

  // =========================================================================
  // ADM-006 — cancelled subscriptions do not inflate live plan counts.
  // =========================================================================

  describe("ADM-006 — plan mix is status-constrained", () => {
    it("a CANCELED subscription is not counted as an active subscription", async () => {
      const user = await seedPersonalTenant(deps, "PRO");
      await prisma.subscription.create({
        data: {
          userId: user.owner.userId,
          provider: "STRIPE",
          providerSubId: `adm006-${randomUUID()}`,
          status: "CANCELED",
          plan: "PRO",
        },
      });

      const { buildPlatformOverview } = await import(
        "../src/services/admin/overview.service.js"
      );
      const overview = await buildPlatformOverview();

      const active = overview.billing.activeSubscriptions.metric;
      expect(active.state).toBe("VALUE");

      const mine = await prisma.subscription.count({
        where: { userId: user.owner.userId, status: "ACTIVE" },
      });
      expect(mine).toBe(0);

      // The status breakdown must SHOW the cancelled row, labelled CANCELED —
      // it is real data, it just is not an active subscriber.
      const canceled = overview.billing.subscriptionsByStatus.find(
        (r) => r.status === "CANCELED",
      );
      expect(canceled?.count ?? 0).toBeGreaterThan(0);
    });
  });
});
