/**
 * PHASE 12 CORRECTIVE PASS §1 — ARCH-003, RUNTIME PROOF.
 *
 * The finding
 * ---------------------------------------------------------------------------
 * The platform-context envelope carried a field called `organizations` whose
 * entries were built with `id: m.team.id` — WORKSPACE ids, in a field named
 * after Organizations, next to a `memberCount` that counted WORKSPACE members
 * and a `membershipStatus` that described the WORKSPACE membership. A consumer
 * reading `organizations[i].id` and handing it to an Organization endpoint was
 * handing it a Workspace id, and nothing in the type said so.
 *
 * Two identifier spaces sharing one field name is the defect.
 *
 * What this file drives
 * ---------------------------------------------------------------------------
 * The real builder against a disposable PostgreSQL 16 + pgvector, through the
 * real authorization chain. Table-driven where the cases are variations of one
 * question, so this is one focused gate rather than fifteen files.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootIntegrationHarness,
  type IntegrationHarness,
} from "./integration-harness.js";

describe("§1 — ARCH-003: one versioned context, two separated id spaces", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let build: typeof import("../src/services/platform-context/platform-context.service.js").buildPlatformContext;
  let lifecycle: typeof import("../src/services/identity/org-membership-lifecycle.service.js");

  let organizationId: string;
  let orgWorkspaceId: string;
  let ownerUserId: string;
  let memberUserId: string;
  let memberMembershipId: string;

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as
      import("@prisma/client").PrismaClient;
    build = (
      await import("../src/services/platform-context/platform-context.service.js")
    ).buildPlatformContext;
    lifecycle = await import(
      "../src/services/identity/org-membership-lifecycle.service.js"
    );

    orgWorkspaceId = h.fixtures.teamA.teamId;
    ownerUserId = h.fixtures.teamA.ownerUserId;
    memberUserId = h.fixtures.teamA.memberUserId;

    const team = await prisma.team.findUniqueOrThrow({
      where: { id: orgWorkspaceId },
      select: { organizationId: true },
    });
    organizationId = team.organizationId;

    const existing = await prisma.organizationMembership.findFirst({
      where: { organizationId, userId: memberUserId },
      select: { id: true },
    });
    memberMembershipId =
      existing?.id ??
      (
        await prisma.organizationMembership.create({
          data: { organizationId, userId: memberUserId, role: "ORG_MEMBER" },
          select: { id: true },
        })
      ).id;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const contextFor = async (userId: string) => {
    const res = await build({ userId, requestId: randomUUID() });
    expect(res.ok, "the builder must resolve for a real user").toBe(true);
    if (!res.ok) throw new Error("unreachable");
    return res.envelope;
  };

  const restoreBaseline = async (): Promise<void> => {
    const row = await prisma.organizationMembership.findUnique({
      where: { id: memberMembershipId },
      select: { status: true },
    });
    if (row && row.status !== "ACTIVE") {
      await lifecycle.restoreOrganizationMembership({
        organizationId,
        membershipId: memberMembershipId,
        actorUserId: ownerUserId,
        source: "MANUAL",
      });
    }
    await prisma.organization.update({
      where: { id: organizationId },
      data: { status: "ACTIVE" },
    });
    await prisma.user.update({
      where: { id: memberUserId },
      data: { currentWorkspaceId: orgWorkspaceId },
    });
  };

  // ===========================================================================
  // The id-space separation — the finding itself
  // ===========================================================================

  it("1 — `organizations` holds ORGANIZATION ids; workspaces hold WORKSPACE ids", async () => {
    await restoreBaseline();
    const env = await contextFor(memberUserId);
    const c = env.canonical;

    expect(c.contextVersion).toBe(2);

    // Every id in `organizations` resolves as an ORGANIZATION and NEVER as a
    // workspace — the exact confusion the legacy field embodied.
    expect(c.organizations.length).toBeGreaterThan(0);
    for (const org of c.organizations) {
      const asOrg = await prisma.organization.count({
        where: { id: org.organizationId },
      });
      const asWorkspace = await prisma.team.count({
        where: { id: org.organizationId },
      });
      expect(asOrg, `${org.organizationId} must be an Organization`).toBe(1);
      expect(
        asWorkspace,
        "WorkspaceIdsInOrganizationFields must be 0",
      ).toBe(0);
    }

    // …and the converse.
    for (const ws of [
      ...c.ownedWorkspaces,
      ...c.organizationWorkspaces,
      ...(c.personalSpace ? [c.personalSpace] : []),
    ]) {
      expect(
        await prisma.team.count({ where: { id: ws.workspaceId } }),
        `${ws.workspaceId} must be a Workspace`,
      ).toBe(1);
      expect(
        await prisma.organization.count({ where: { id: ws.workspaceId } }),
        "a Workspace id must not resolve as an Organization",
      ).toBe(0);
    }
  }, 180_000);

  it("2 — the two membership id spaces are distinct rows", async () => {
    await restoreBaseline();
    const c = (await contextFor(memberUserId)).canonical;

    const orgMembershipIds = new Set(
      c.organizationMemberships.map((m) => m.organizationMembershipId),
    );
    const workspaceMembershipIds = new Set(
      [...c.ownedWorkspaces, ...c.organizationWorkspaces]
        .map((w) => w.workspaceMembershipId)
        .filter((x): x is string => x !== null),
    );
    expect(orgMembershipIds.size).toBeGreaterThan(0);
    expect(workspaceMembershipIds.size).toBeGreaterThan(0);
    for (const id of orgMembershipIds) {
      expect(
        workspaceMembershipIds.has(id),
        "an Organization membership id must never also be a Workspace membership id",
      ).toBe(false);
      expect(
        await prisma.organizationMembership.count({ where: { id } }),
      ).toBe(1);
    }
    for (const id of workspaceMembershipIds) {
      expect(await prisma.teamMember.count({ where: { id } })).toBe(1);
    }
  }, 180_000);

  it("3 — the legacy field is a PROJECTION, not a second query", async () => {
    await restoreBaseline();
    const env = await contextFor(memberUserId);
    // The legacy `organizations` entries are workspaces (that IS the finding).
    // What must hold now is that they cannot DISAGREE with the canonical set —
    // every legacy entry is one of the canonical org workspaces.
    const canonicalWorkspaceIds = new Set(
      env.canonical.organizationWorkspaces.map((w) => w.workspaceId),
    );
    for (const legacy of env.organizations) {
      expect(
        canonicalWorkspaceIds.has(legacy.id),
        `legacy organizations[] entry ${legacy.id} is not in the canonical set`,
      ).toBe(true);
    }
  }, 180_000);

  // ===========================================================================
  // Lifecycle — ACTIVE only, no silent fallback
  // ===========================================================================

  const LIFECYCLE_CASES: ReadonlyArray<{
    name: string;
    apply: () => Promise<void>;
    expectOrganizations: number;
  }> = [
    {
      name: "an ACTIVE member sees the Organization",
      apply: async () => {},
      expectOrganizations: 1,
    },
    {
      name: "a SUSPENDED member does not",
      apply: async () => {
        await lifecycle.suspendOrganizationMembership({
          organizationId,
          membershipId: memberMembershipId,
          actorUserId: ownerUserId,
          source: "MANUAL",
        });
      },
      expectOrganizations: 0,
    },
    {
      name: "a REVOKED member does not",
      apply: async () => {
        await lifecycle.revokeOrganizationMembership({
          organizationId,
          membershipId: memberMembershipId,
          actorUserId: ownerUserId,
          source: "MANUAL",
        });
      },
      expectOrganizations: 0,
    },
    {
      name: "a SUSPENDED Organization disappears for everyone",
      apply: async () => {
        await prisma.organization.update({
          where: { id: organizationId },
          data: { status: "SUSPENDED" },
        });
      },
      expectOrganizations: 0,
    },
  ];

  for (const testCase of LIFECYCLE_CASES) {
    it(`4 — ${testCase.name}`, async () => {
      await restoreBaseline();
      await testCase.apply();
      const c = (await contextFor(memberUserId)).canonical;
      expect(
        c.organizations.length,
        `${testCase.name}: organizations`,
      ).toBe(testCase.expectOrganizations);
      expect(
        c.organizationMemberships.length,
        `${testCase.name}: memberships`,
      ).toBe(testCase.expectOrganizations);
      if (testCase.expectOrganizations === 0) {
        // …and nothing was substituted in its place.
        expect(
          c.currentOrganization,
          "no silent fallback to another Organization",
        ).toBeNull();
      }
    }, 180_000);
  }

  it("5 — a dirty pointer heals HOME and says so; it never lands elsewhere", async () => {
    await restoreBaseline();
    const healthy = (await contextFor(memberUserId)).canonical;
    expect(healthy.currentWorkspaceSource).toBe("POINTER");

    // The two dirty shapes: a FOREIGN workspace, and an id that exists nowhere.
    for (const [label, pointer] of [
      ["a foreign workspace", h.fixtures.teamB.teamId],
      ["an id that exists nowhere", randomUUID()],
    ] as const) {
      await prisma.user.update({
        where: { id: memberUserId },
        data: { currentWorkspaceId: pointer },
      });
      const c = (await contextFor(memberUserId)).canonical;

      // It heals rather than producing a broken shell — and the healing is
      // REPORTED, which is what makes it not a silent fallback.
      expect(c.currentWorkspaceSource, label).toBe("REPAIRED_TO_PERSONAL");
      expect(c.currentWorkspace, label).not.toBeNull();
      expect(
        c.currentWorkspace!.workspaceId,
        `${label}: it heals to the caller's OWN Personal Space`,
      ).toBe(c.personalSpace!.workspaceId);
      expect(c.currentWorkspace!.kind).toBe("PERSONAL");

      // The load-bearing assertion: it never lands on the workspace the dirty
      // pointer named, and a Personal Space has no Organization.
      expect(c.currentWorkspace!.workspaceId, label).not.toBe(pointer);
      expect(c.currentOrganization, label).toBeNull();
    }
  }, 180_000);

  it("6 — currentWorkspace is only ever one the caller may already enter", async () => {
    await restoreBaseline();
    const c = (await contextFor(memberUserId)).canonical;
    if (c.currentWorkspace) {
      const enterable = new Set(
        [
          ...(c.personalSpace ? [c.personalSpace.workspaceId] : []),
          ...c.ownedWorkspaces.map((w) => w.workspaceId),
          ...c.organizationWorkspaces.map((w) => w.workspaceId),
        ],
      );
      expect(
        enterable.has(c.currentWorkspace.workspaceId),
        "the pointer is a NAVIGATION preference; it can never widen the set",
      ).toBe(true);
    }
  }, 180_000);

  it("7 — noPersonalSpace removes the Personal Space, without substituting", async () => {
    await restoreBaseline();
    const before = (await contextFor(memberUserId)).canonical;
    expect(before.personalSpace).not.toBeNull();

    const identity = await import(
      "../src/services/identity/identity-mode.service.js"
    );
    // Drive the real policy rather than faking the projection.
    await prisma.user.update({
      where: { id: memberUserId },
      data: {
        identityMode: "MANAGED_ENTERPRISE",
        managingOrganizationId: organizationId,
      },
    });
    await prisma.organizationSecurityPolicy.upsert({
      where: { organizationId },
      create: { organizationId, teamId: orgWorkspaceId, noPersonalSpace: true },
      update: { noPersonalSpace: true },
    });
    expect(
      await identity.personalSpaceAllowed(memberUserId),
      "the identity authority must say the Personal Space is not allowed",
    ).toBe(false);

    const after = (await contextFor(memberUserId)).canonical;
    expect(
      after.personalSpace,
      "noPersonalSpace removes it; it does not swap in another workspace",
    ).toBeNull();

    await prisma.organizationSecurityPolicy.update({
      where: { organizationId },
      data: { noPersonalSpace: false },
    });
    await prisma.user.update({
      where: { id: memberUserId },
      data: { identityMode: "STANDARD", managingOrganizationId: null },
    });
  }, 300_000);

  it("8 — a second account restores none of the first account's tenants", async () => {
    await restoreBaseline();
    const mine = (await contextFor(memberUserId)).canonical;
    const theirs = (await contextFor(h.fixtures.teamB.ownerUserId)).canonical;

    const myWorkspaces = new Set(
      [...mine.ownedWorkspaces, ...mine.organizationWorkspaces].map(
        (w) => w.workspaceId,
      ),
    );
    for (const w of [...theirs.ownedWorkspaces, ...theirs.organizationWorkspaces]) {
      expect(
        myWorkspaces.has(w.workspaceId),
        "one account's context must contain nothing of another's",
      ).toBe(false);
    }
    expect(mine.account.accountId).not.toBe(theirs.account.accountId);
  }, 180_000);

  it("9 — commercialContext names a SHAPE, never a tenancy kind", async () => {
    await restoreBaseline();
    const c = (await contextFor(memberUserId)).canonical;
    if (c.currentWorkspace) {
      expect(["SINGLE_OCCUPANT", "SHARED"]).toContain(
        c.commercialContext.billingShape,
      );
      // A SHARED shape for an ORGANIZATION workspace — derived from the kind,
      // not from the plan.
      if (c.currentWorkspace.kind === "ORGANIZATION") {
        expect(c.commercialContext.billingShape).toBe("SHARED");
      }
    }
  }, 180_000);
});
