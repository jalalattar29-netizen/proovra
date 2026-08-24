/**
 * ORG HEALTH — ONE ARITHMETIC, PROVEN ACROSS EVERY POPULATION SHAPE.
 *
 * THE DEFECT THIS CLOSES
 * ----------------------
 * The projection was computed in two places — `services/api`'s
 * `refresh-org-health.service.ts` and the Worker's `processOrgHealthRefreshJob`
 * — and the two DISAGREED:
 *
 *     pendingReportCount   API: status IN (SIGNED, REPORTED) AND no report
 *                          Worker: no report            ← no status filter
 *     pendingPackageCount  API: status = REPORTED AND no package
 *                          Worker: no package           ← no status filter
 *
 * A workspace with ten stalled uploads and nothing else therefore read as ten
 * reports outstanding from one path and zero from the other, and which number
 * Home displayed depended on whether the Worker's cached row or the API's live
 * aggregator had written last.
 *
 * WHY THESE CASES
 * ---------------
 * Two implementations can agree on one fixture and diverge on the next — that
 * is exactly how this survived, because both counted a fully-processed
 * workspace identically. The populations below are chosen to be the ones where
 * a missing status filter CHANGES the answer: pre-pipeline records, terminal
 * failures, soft-deleted rows, and mixtures of all three.
 *
 * Every case drives the REAL authority against a REAL PostgreSQL 16, and every
 * case asserts the exact expected integers rather than only that the two
 * callers agree — two callers of one function agree trivially. What has to be
 * proven is that the ONE function is right.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Org Health arithmetic (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let runtime: typeof import("@proovra/shared-runtime");

  let personal: { userId: string; teamId: string };
  let teamA: { teamId: string; organizationId: string };

  /** A workspace nobody else touches, so counts are exactly what we seeded. */
  let scratch: { teamId: string; ownerUserId: string };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    runtime = await import("@proovra/shared-runtime");

    personal = {
      userId: harness.fixtures.personal.userId,
      teamId: harness.fixtures.personal.teamId,
    };
    const row = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamA.teamId },
      select: { organizationId: true },
    });
    // `Team.organizationId` is NOT NULL in the schema; asserting it here keeps
    // every `create` below honest instead of threading a nullable through.
    expect(row.organizationId).toBeTruthy();
    teamA = {
      teamId: harness.fixtures.teamA.teamId,
      organizationId: row.organizationId!,
    };
  }, 900_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  beforeEach(async () => {
    // A FRESH workspace per case. Reusing a seeded one would make every
    // expected integer depend on fixture drift rather than on the arithmetic.
    const owner = await prisma.user.create({
      data: {
        email: `orghealth-${randomUUID().slice(0, 8)}@example.test`,
        displayName: "Org Health Probe",
        provider: "EMAIL",
        providerUserId: `orghealth-${randomUUID().slice(0, 8)}@example.test`,
      },
      select: { id: true },
    });
    const team = await prisma.team.create({
      data: {
        name: `orghealth-${randomUUID().slice(0, 8)}`,
        ownerUserId: owner.id,
        isPersonal: false,
        workspaceKind: "ORGANIZATION",
        organizationId: teamA.organizationId,
      },
      select: { id: true },
    });
    scratch = { teamId: team.id, ownerUserId: owner.id };
  });

  type Seed = {
    status: string;
    /** null = the legacy personal shape: owner-bound, no workspace column. */
    teamId: string | null;
    ownerUserId: string;
    withReport?: boolean;
    withPackage?: boolean;
    deleted?: boolean;
  };

  /** Org id for a workspace, memoised — the CHECK constraint requires it. */
  const orgIdCache = new Map<string, string | null>();
  async function orgIdFor(teamId: string): Promise<string | null> {
    if (!orgIdCache.has(teamId)) {
      const t = await prisma.team.findUniqueOrThrow({
        where: { id: teamId },
        select: { organizationId: true },
      });
      orgIdCache.set(teamId, t.organizationId);
    }
    return orgIdCache.get(teamId) ?? null;
  }

  async function seed(rows: Seed[]): Promise<void> {
    for (const r of rows) {
      const evidence = await prisma.evidence.create({
        data: {
          title: `probe-${randomUUID().slice(0, 8)}`,
          type: "DOCUMENT",
          status: r.status as never,
          teamId: r.teamId,
          // `evidence_team_implies_org_chk` — a row that names a workspace must
          // name that workspace's organization too. A legacy NULL-team row
          // names neither, which is exactly the shape being tested.
          organizationId: r.teamId ? ((await orgIdFor(r.teamId)) ?? undefined) : undefined,
          ownerUserId: r.ownerUserId,
          ...(r.deleted ? { deletedAt: new Date() } : {}),
        },
        select: { id: true, teamId: true },
      });
      if (r.withReport) {
        await prisma.report.create({
          data: {
            evidenceId: evidence.id,
            version: 1,
            storageBucket: "probe-bucket",
            storageKey: `probe/${evidence.id}.pdf`,
            generatedAtUtc: new Date(),
          },
        });
      }
      if (r.withPackage) {
        await prisma.verificationPackage.create({
          data: {
            evidenceId: evidence.id,
            version: 1,
            storageBucket: "probe-bucket",
            storageKey: `probe/${evidence.id}.zip`,
            generatedAtUtc: new Date(),
          },
        });
      }
    }
  }

  /**
   * Both entry points, on one population.
   *
   * `computeOrgHealthCounts` is what the API's Command Center reaches;
   * `refreshOrgHealthProjection` is what the Worker's job reaches. They are the
   * same function today — which is the point — so this asserts the property
   * that USED to fail and now cannot: the persisted row and the live counts
   * carry identical numbers.
   */
  async function bothPaths(teamId: string) {
    const live = await runtime.computeOrgHealthCounts({ teamId }, prisma);
    const persisted = await runtime.refreshOrgHealthProjection({ teamId }, prisma);
    const readBack = await runtime.readLatestOrgHealthProjection({ teamId }, prisma);
    expect(readBack, "the projection row was not written").not.toBeNull();
    return { live, persisted, readBack: readBack! };
  }

  function expectAllAgree(
    r: Awaited<ReturnType<typeof bothPaths>>,
    expected: {
      evidenceCount: number;
      caseCount: number;
      pendingReportCount: number;
      pendingPackageCount: number;
    },
  ) {
    for (const [label, actual] of [
      ["live", r.live],
      ["persisted", r.persisted],
      ["readBack", r.readBack],
    ] as const) {
      expect(
        {
          evidenceCount: actual.evidenceCount,
          caseCount: actual.caseCount,
          pendingReportCount: actual.pendingReportCount,
          pendingPackageCount: actual.pendingPackageCount,
        },
        `${label} path disagrees`,
      ).toEqual(expected);
    }
  }

  // -------------------------------------------------------------------------
  // The case that used to diverge.
  // -------------------------------------------------------------------------

  it("pre-pipeline records are NOT pending a report — the exact former divergence", async () => {
    await seed([
      { status: "CREATED", teamId: scratch.teamId, ownerUserId: scratch.ownerUserId },
      { status: "UPLOADING", teamId: scratch.teamId, ownerUserId: scratch.ownerUserId },
      { status: "UPLOADED", teamId: scratch.teamId, ownerUserId: scratch.ownerUserId },
      {
        status: "FAILED_HASH_MISMATCH",
        teamId: scratch.teamId,
        ownerUserId: scratch.ownerUserId,
      },
    ]);
    const r = await bothPaths(scratch.teamId);
    // FOUR records exist and NONE is pending a report: each is pending a prior
    // step or terminally failed. The deleted Worker copy returned 4 here.
    expectAllAgree(r, {
      evidenceCount: 4,
      caseCount: 0,
      pendingReportCount: 0,
      pendingPackageCount: 0,
    });
  });

  it("report-missing vs report-ready", async () => {
    await seed([
      { status: "SIGNED", teamId: scratch.teamId, ownerUserId: scratch.ownerUserId },
      { status: "SIGNED", teamId: scratch.teamId, ownerUserId: scratch.ownerUserId, withReport: true },
      { status: "REPORTED", teamId: scratch.teamId, ownerUserId: scratch.ownerUserId },
      { status: "REPORTED", teamId: scratch.teamId, ownerUserId: scratch.ownerUserId, withReport: true },
    ]);
    const r = await bothPaths(scratch.teamId);
    expectAllAgree(r, {
      evidenceCount: 4,
      caseCount: 0,
      // The two without a report row: one SIGNED, one REPORTED.
      pendingReportCount: 2,
      // Only REPORTED records can be missing a package; both of them are.
      pendingPackageCount: 2,
    });
  });

  it("a SIGNED record is not missing a package — it has not reached that stage", async () => {
    await seed([
      { status: "SIGNED", teamId: scratch.teamId, ownerUserId: scratch.ownerUserId, withReport: true },
    ]);
    const r = await bothPaths(scratch.teamId);
    expectAllAgree(r, {
      evidenceCount: 1,
      caseCount: 0,
      pendingReportCount: 0,
      pendingPackageCount: 0,
    });
  });

  it("package-ready REPORTED records are not pending", async () => {
    await seed([
      {
        status: "REPORTED",
        teamId: scratch.teamId,
        ownerUserId: scratch.ownerUserId,
        withReport: true,
        withPackage: true,
      },
    ]);
    const r = await bothPaths(scratch.teamId);
    expectAllAgree(r, {
      evidenceCount: 1,
      caseCount: 0,
      pendingReportCount: 0,
      pendingPackageCount: 0,
    });
  });

  it("soft-deleted (trashed/destroyed) records are excluded from every counter", async () => {
    await seed([
      {
        status: "REPORTED",
        teamId: scratch.teamId,
        ownerUserId: scratch.ownerUserId,
        deleted: true,
      },
      {
        status: "SIGNED",
        teamId: scratch.teamId,
        ownerUserId: scratch.ownerUserId,
        deleted: true,
      },
      { status: "SIGNED", teamId: scratch.teamId, ownerUserId: scratch.ownerUserId },
    ]);
    const r = await bothPaths(scratch.teamId);
    expectAllAgree(r, {
      evidenceCount: 1,
      caseCount: 0,
      pendingReportCount: 1,
      pendingPackageCount: 0,
    });
  });

  it("a mixed lifecycle population totals correctly", async () => {
    await seed([
      { status: "CREATED", teamId: scratch.teamId, ownerUserId: scratch.ownerUserId },
      { status: "UPLOADED", teamId: scratch.teamId, ownerUserId: scratch.ownerUserId },
      { status: "SIGNED", teamId: scratch.teamId, ownerUserId: scratch.ownerUserId },
      { status: "SIGNED", teamId: scratch.teamId, ownerUserId: scratch.ownerUserId, withReport: true },
      { status: "REPORTED", teamId: scratch.teamId, ownerUserId: scratch.ownerUserId, withReport: true },
      {
        status: "REPORTED",
        teamId: scratch.teamId,
        ownerUserId: scratch.ownerUserId,
        withReport: true,
        withPackage: true,
      },
      {
        status: "REPORTED",
        teamId: scratch.teamId,
        ownerUserId: scratch.ownerUserId,
        deleted: true,
      },
    ]);
    await prisma.case.create({
      data: { name: "probe case", teamId: scratch.teamId, ownerUserId: scratch.ownerUserId },
    });
    const r = await bothPaths(scratch.teamId);
    expectAllAgree(r, {
      evidenceCount: 6, // seven seeded, one soft-deleted
      caseCount: 1,
      // SIGNED-no-report (1) + REPORTED-no-report (0) = 1
      pendingReportCount: 1,
      // REPORTED without a package: the report-only one. The packaged one and
      // the deleted one do not count.
      pendingPackageCount: 1,
    });
  });

  it("an empty workspace counts zero everywhere, and says so from every path", async () => {
    const r = await bothPaths(scratch.teamId);
    expectAllAgree(r, {
      evidenceCount: 0,
      caseCount: 0,
      pendingReportCount: 0,
      pendingPackageCount: 0,
    });
  });

  // -------------------------------------------------------------------------
  // Workspace kinds.
  // -------------------------------------------------------------------------

  it("PERSONAL legacy evidence (teamId NULL, owner-bound) is counted", async () => {
    // The shape the whole convergence exists for: ownership carried by
    // `owner_user_id` alone. A strict `teamId` predicate misses these entirely.
    const before = await runtime.computeOrgHealthCounts(
      { teamId: personal.teamId },
      prisma,
    );
    await seed([
      { status: "SIGNED", teamId: null, ownerUserId: personal.userId },
      { status: "REPORTED", teamId: null, ownerUserId: personal.userId, withReport: true },
    ]);
    const r = await bothPaths(personal.teamId);
    expect(r.live.evidenceCount).toBe(before.evidenceCount + 2);
    expect(r.live.pendingReportCount).toBe(before.pendingReportCount + 1);
    expect(r.live.pendingPackageCount).toBe(before.pendingPackageCount + 1);
    // And the persisted row carries the same numbers as the live read.
    expect(r.persisted.evidenceCount).toBe(r.live.evidenceCount);
    expect(r.persisted.pendingReportCount).toBe(r.live.pendingReportCount);
    expect(r.persisted.pendingPackageCount).toBe(r.live.pendingPackageCount);
  });

  it("PERSONAL evidence with a physical workspace id is counted the same way", async () => {
    const before = await runtime.computeOrgHealthCounts(
      { teamId: personal.teamId },
      prisma,
    );
    await seed([
      { status: "SIGNED", teamId: personal.teamId, ownerUserId: personal.userId },
    ]);
    const after = await runtime.computeOrgHealthCounts(
      { teamId: personal.teamId },
      prisma,
    );
    expect(after.evidenceCount).toBe(before.evidenceCount + 1);
    expect(after.pendingReportCount).toBe(before.pendingReportCount + 1);
  });

  it("another owner's NULL-team evidence never enters this workspace's counts", async () => {
    const other = await prisma.user.create({
      data: {
        email: `other-${randomUUID().slice(0, 8)}@example.test`,
        displayName: "Other",
        provider: "EMAIL",
        providerUserId: `other-${randomUUID().slice(0, 8)}@example.test`,
      },
      select: { id: true },
    });
    const before = await runtime.computeOrgHealthCounts(
      { teamId: personal.teamId },
      prisma,
    );
    await seed([{ status: "SIGNED", teamId: null, ownerUserId: other.id }]);
    const after = await runtime.computeOrgHealthCounts(
      { teamId: personal.teamId },
      prisma,
    );
    expect(after.evidenceCount).toBe(before.evidenceCount);
    expect(after.pendingReportCount).toBe(before.pendingReportCount);
  });

  it("every plan on an ORGANIZATION workspace counts identically", async () => {
    // Two different axes, and the test has to keep them apart:
    //   workspace KIND  PERSONAL | OWNED | ORGANIZATION  — decides SEMANTICS
    //   billing PLAN    FREE | PAYG | PRO | TEAM | ENTERPRISE — decides nothing
    //
    // The population rule is a function of kind and ownership. A commercial
    // label must never move a row, so the same seeded shape under every plan
    // this schema has must produce the same three numbers. `ORGANIZATION` is
    // NOT a plan — it is the kind these workspaces already carry.
    const results: Array<Record<string, number>> = [];
    for (const plan of ["FREE", "PAYG", "PRO", "TEAM", "ENTERPRISE"]) {
      const owner = await prisma.user.create({
        data: {
          email: `plan-${randomUUID().slice(0, 8)}@example.test`,
          displayName: plan,
          provider: "EMAIL",
          providerUserId: `plan-${randomUUID().slice(0, 8)}@example.test`,
        },
        select: { id: true },
      });
      const team = await prisma.team.create({
        data: {
          name: `plan-${plan}-${randomUUID().slice(0, 8)}`,
          ownerUserId: owner.id,
          isPersonal: false,
          workspaceKind: "ORGANIZATION",
          billingPlan: plan as never,
          organizationId: teamA.organizationId,
        },
        select: { id: true },
      });
      const planOrgId = teamA.organizationId;
      await prisma.evidence.createMany({
        data: [
          { title: "a", type: "DOCUMENT" as never, status: "SIGNED" as never, teamId: team.id, organizationId: planOrgId, ownerUserId: owner.id },
          { title: "b", type: "DOCUMENT" as never, status: "CREATED" as never, teamId: team.id, organizationId: planOrgId, ownerUserId: owner.id },
        ],
      });
      const counts = await runtime.computeOrgHealthCounts({ teamId: team.id }, prisma);
      results.push({
        evidenceCount: counts.evidenceCount,
        pendingReportCount: counts.pendingReportCount,
        pendingPackageCount: counts.pendingPackageCount,
      });
    }
    expect(results[0]).toEqual({
      evidenceCount: 2,
      pendingReportCount: 1,
      pendingPackageCount: 0,
    });
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i], `plan index ${i} changed the population`).toEqual(
        results[0],
      );
    }
  });

  // -------------------------------------------------------------------------
  // Fail closed.
  // -------------------------------------------------------------------------

  it("an absent workspace id REFUSES rather than returning zeros", async () => {
    await expect(
      runtime.computeOrgHealthCounts({ teamId: "" }, prisma),
    ).rejects.toThrow(/teamId/);
    await expect(
      runtime.refreshOrgHealthProjection({ teamId: "" }, prisma),
    ).rejects.toThrow(/teamId/);
  });

  it("a whitespace-only workspace id REFUSES too", async () => {
    await expect(
      runtime.computeOrgHealthCounts({ teamId: "   " }, prisma),
    ).rejects.toThrow(/teamId/);
  });

  it("repeated refreshes inside one minute collapse to ONE row", async () => {
    // The bucket is what makes the upsert an upsert. Without it every refresh
    // appended, and the table grew without bound while the read took the newest.
    const now = new Date();
    await runtime.refreshOrgHealthProjection({ teamId: scratch.teamId, now }, prisma);
    await runtime.refreshOrgHealthProjection({ teamId: scratch.teamId, now }, prisma);
    await runtime.refreshOrgHealthProjection({ teamId: scratch.teamId, now }, prisma);
    const rows = await prisma.orgHealthProjection.count({
      where: { teamId: scratch.teamId },
    });
    expect(rows).toBe(1);
  });
});
