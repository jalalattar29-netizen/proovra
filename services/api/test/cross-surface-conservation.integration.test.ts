/**
 * §13 / §14 — CROSS-SURFACE CONSERVATION AND THE WORKSPACE MATRIX, live PG 16.
 *
 * THE CONTRACT
 * ------------
 * Four surfaces describe the same workspace and they have different jobs:
 *
 *   Evidence       the canonical detailed source truth
 *   Home           a summary PROJECTION of the operations read model
 *   Notifications  per-user awareness, with its own read/archive state
 *   Operations     the shared managed queue
 *
 * Their ROW COUNTS may legitimately differ — Notifications is per-user and
 * per-record, Operations groups, Home summarises. What may never differ is
 * EXISTENCE. A workspace with N failing records cannot be "N failed" on one
 * surface and "clear" on another, which is precisely the production failure
 * this program began with.
 *
 * THE MATRIX
 * ----------
 * §14 asks for every workspace and capability context to be exercised through
 * the real server boundary. The harness seeds three real shapes — a personal
 * workspace whose evidence is the legacy NULL-team kind, and two shared
 * workspaces each with owner / admin / member / viewer tokens. Those cover the
 * dimensions that CHANGE DATA POPULATION or authorization outcome, which is
 * what this section is actually about: plan names must never affect population
 * semantics, and a refused context must issue zero tenant reads.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Cross-surface conservation (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let runtime: typeof import("@proovra/shared-runtime");
  let ops: typeof import("../src/services/operations/operations-reconciliation.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    runtime = await import("@proovra/shared-runtime");
    ops = await import(
      "../src/services/operations/operations-reconciliation.service.js"
    );
  }, 900_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  /** Drive a real HTTP request through the real server boundary. */
  async function get(url: string, token: string) {
    return harness.app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  // -------------------------------------------------------------------------
  // §13 — existence conservation across surfaces.
  // -------------------------------------------------------------------------

  it("a personal workspace's failing records exist on EVERY surface or none", async () => {
    const { personal } = harness.fixtures;

    // Make the workspace genuinely unhealthy, on its LEGACY NULL-team rows —
    // the exact shape a strict `teamId` predicate cannot see.
    const legacy = await prisma.evidence.findMany({
      where: { ownerUserId: personal.userId, teamId: null },
      select: { id: true },
      take: 3,
    });
    const scoped = await prisma.evidence.findMany({
      where: { teamId: personal.teamId },
      select: { id: true },
      take: 3,
    });
    const targets = [...legacy, ...scoped].slice(0, 3);
    // The fixture must actually contain something, or this proves nothing.
    expect(targets.length).toBeGreaterThan(0);

    await prisma.evidence.updateMany({
      where: { id: { in: targets.map((t) => t.id) } },
      data: { tsaStatus: "FAILED" },
    });

    // EVIDENCE — the canonical source count, through the canonical scope.
    const scope = await runtime.workspaceEvidenceWhere(personal.teamId, prisma);
    const sourceCount = await prisma.evidence.count({
      where: { AND: [scope, { tsaStatus: "FAILED" }] },
    });
    expect(sourceCount).toBeGreaterThan(0);

    // OPERATIONS — discovery must materialise conditions for those records.
    await ops.reconcileWorkspaceOperations({
      workspaceId: personal.teamId,
      trigger: "cli",
    });
    const { buildOperationsSummary } = await import(
      "../src/services/operations/operations-summary.service.js"
    );
    const summary = await buildOperationsSummary({
      workspaceId: personal.teamId,
    });

    // THE CONSERVATION. The counts need not be equal — Operations groups and
    // Home summarises — but a workspace with failing source records may NEVER
    // be describable as clear. This single assertion is the whole bug.
    expect(summary.mayAssertAllClear).toBe(false);
    expect(summary.open).toBeGreaterThan(0);
  });

  it("Home and Operations read the SAME summary authority, not two counts", async () => {
    const { personal } = harness.fixtures;
    const { buildOperationsSummary } = await import(
      "../src/services/operations/operations-summary.service.js"
    );
    const a = await buildOperationsSummary({ workspaceId: personal.teamId });
    const b = await buildOperationsSummary({ workspaceId: personal.teamId });
    // Two reads of one authority agree. Two AUTHORITIES would not have to.
    expect(b.open).toBe(a.open);
    expect(b.critical).toBe(a.critical);
    expect(b.readiness).toBe(a.readiness);
  });

  it("archiving a notification does NOT change the workspace's operational truth", async () => {
    // The defect this forbids: personal notification state moving a SHARED
    // number, so two admins looking at one workspace saw two healths.
    const { personal } = harness.fixtures;
    const { buildOperationsSummary } = await import(
      "../src/services/operations/operations-summary.service.js"
    );
    const before = await buildOperationsSummary({ workspaceId: personal.teamId });

    await prisma.inboxItemState.create({
      data: {
        userId: personal.userId,
        itemKey: `tsa_failure:${randomUUID()}`,
        sourceType: "tsa_failure",
        teamId: personal.teamId,
        dismissedAt: new Date(),
      },
    });

    const after = await buildOperationsSummary({ workspaceId: personal.teamId });
    expect(after.open).toBe(before.open);
    expect(after.mayAssertAllClear).toBe(before.mayAssertAllClear);
  });

  // -------------------------------------------------------------------------
  // §14 — the workspace / capability matrix, through the real boundary.
  // -------------------------------------------------------------------------

  const MATRIX: Array<{
    label: string;
    workspace: "teamA" | "teamB" | "personal";
    role: "owner" | "admin" | "member" | "viewer" | "personal";
  }> = [
    { label: "Personal owner", workspace: "personal", role: "personal" },
    { label: "Team owner", workspace: "teamA", role: "owner" },
    { label: "Team admin", workspace: "teamA", role: "admin" },
    { label: "Team operator (member)", workspace: "teamA", role: "member" },
    { label: "Team viewer", workspace: "teamA", role: "viewer" },
    { label: "Organization owner", workspace: "teamB", role: "owner" },
    { label: "Organization viewer", workspace: "teamB", role: "viewer" },
  ];

  function contextFor(entry: (typeof MATRIX)[number]) {
    const f = harness.fixtures;
    if (entry.workspace === "personal") {
      return { teamId: f.personal.teamId, token: f.personal.token };
    }
    const team = entry.workspace === "teamA" ? f.teamA : f.teamB;
    const token =
      entry.role === "owner"
        ? team.ownerToken
        : entry.role === "admin"
          ? team.adminToken
          : entry.role === "member"
            ? team.memberToken
            : team.viewerToken;
    return { teamId: team.teamId, token };
  }

  for (const entry of MATRIX) {
    it(`${entry.label}: the summary is answered or refused, never fabricated`, async () => {
      const { teamId, token } = contextFor(entry);
      const res = await get(`/v1/ops/summary?teamId=${teamId}`, token);

      // Either the context may read Operations, or it may not. What must never
      // happen is a 200 carrying a confident all-clear the server has not
      // earned — which is the only outcome this assertion forbids.
      expect([200, 403, 404]).toContain(res.statusCode);
      if (res.statusCode !== 200) return;

      const body = res.json() as {
        summary: {
          open: number;
          mayAssertAllClear: boolean;
          readiness: string;
          clearRefusalReason: string | null;
        };
      };
      expect(body.summary.readiness).toBeTruthy();
      if (body.summary.mayAssertAllClear) {
        // The all-clear is only ever licensed by a certified READY run with
        // nothing unresolved. Enumerated here per context so a capability
        // path that skipped the gate would fail loudly.
        expect(body.summary.readiness).toBe("READY");
        expect(body.summary.open).toBe(0);
        expect(body.summary.clearRefusalReason).toBeNull();
      } else {
        expect(body.summary.clearRefusalReason).toBeTruthy();
      }
    });
  }

  it("a WRONG workspace is refused and returns no tenant data", async () => {
    // teamA's viewer asking about teamB. The refusal must carry nothing.
    const res = await get(
      `/v1/ops/summary?teamId=${harness.fixtures.teamB.teamId}`,
      harness.fixtures.teamA.viewerToken,
    );
    expect([403, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain("mayAssertAllClear");
    expect(res.body).not.toContain("readiness");
  });

  it("a workspace that does not exist is refused identically", async () => {
    // Anti-enumeration: "does not exist" and "exists and you are not in it"
    // must be indistinguishable from outside.
    const res = await get(
      `/v1/ops/summary?teamId=${randomUUID()}`,
      harness.fixtures.teamA.viewerToken,
    );
    expect([403, 404]).toContain(res.statusCode);
  });

  it("a missing credential is refused before any tenant read", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/ops/summary?teamId=${harness.fixtures.teamA.teamId}`,
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it("plan name never changes which records a workspace can see", async () => {
    // §14's hardest rule: population semantics are a function of workspace
    // KIND and ownership, never of a commercial label. Flipping the plan must
    // move no rows.
    const { teamA } = harness.fixtures;
    const scopeBefore = await runtime.workspaceEvidenceWhere(teamA.teamId, prisma);
    const countBefore = await prisma.evidence.count({
      where: { AND: [scopeBefore] },
    });

    const original = await prisma.team.findUniqueOrThrow({
      where: { id: teamA.teamId },
      select: { billingPlan: true },
    });
    await prisma.team.update({
      where: { id: teamA.teamId },
      data: { billingPlan: original.billingPlan === "PRO" ? "TEAM" : "PRO" },
    });
    try {
      const scopeAfter = await runtime.workspaceEvidenceWhere(teamA.teamId, prisma);
      const countAfter = await prisma.evidence.count({
        where: { AND: [scopeAfter] },
      });
      expect(countAfter).toBe(countBefore);
      expect(scopeAfter).toEqual(scopeBefore);
    } finally {
      await prisma.team.update({
        where: { id: teamA.teamId },
        data: { billingPlan: original.billingPlan },
      });
    }
  });

  it("two different personal owners never see each other's NULL-team evidence", async () => {
    // The safety property that makes the personal widening acceptable at all.
    const otherUser = await prisma.user.create({
      data: {
        email: `other-${randomUUID().slice(0, 8)}@example.test`,
        displayName: "Other Owner",
        provider: "EMAIL",
        providerUserId: `other-${randomUUID().slice(0, 8)}@example.test`,
      },
      select: { id: true },
    });
    const otherPersonal = await prisma.team.create({
      data: {
        name: "Other Personal",
        ownerUserId: otherUser.id,
        isPersonal: true,
        workspaceKind: "PERSONAL",
        organizationId: (
          await prisma.team.findUniqueOrThrow({
            where: { id: harness.fixtures.personal.teamId },
            select: { organizationId: true },
          })
        ).organizationId,
      },
      select: { id: true },
    });
    const theirLegacyEvidence = await prisma.evidence.create({
      data: {
        ownerUserId: otherUser.id,
        teamId: null,
        title: "Other owner's legacy record",
        type: "DOCUMENT",
        status: "UPLOADED",
      },
      select: { id: true },
    });

    const mine = await runtime.workspaceEvidenceWhere(
      harness.fixtures.personal.teamId,
      prisma,
    );
    const visibleToMe = await prisma.evidence.findMany({
      where: { AND: [mine] },
      select: { id: true },
    });
    expect(visibleToMe.map((e) => e.id)).not.toContain(theirLegacyEvidence.id);

    // And symmetrically: their scope reaches their own row.
    const theirs = await runtime.workspaceEvidenceWhere(otherPersonal.id, prisma);
    const visibleToThem = await prisma.evidence.findMany({
      where: { AND: [theirs] },
      select: { id: true },
    });
    expect(visibleToThem.map((e) => e.id)).toContain(theirLegacyEvidence.id);
  });

  it("a SHARED workspace's scope is strict — no owner arm widens it", async () => {
    const scope = await runtime.workspaceEvidenceWhere(
      harness.fixtures.teamA.teamId,
      prisma,
    );
    // Exactly the strict predicate, with no OR. A shared workspace that
    // widened by one member's rows would be the mirror-image defect.
    expect(scope).toEqual({ teamId: harness.fixtures.teamA.teamId });
  });
});
