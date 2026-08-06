/**
 * PHASE 12 — POINT 5, FAMILY 4b: the exchange package builder.
 *
 * The second of the two `reports_packages` runtime units. The first,
 * `GenerateReportJob`, is proven by the 29-case report-authority suite; this
 * one had never been driven by anything, which is exactly why the old
 * suite-existence credit rule was wrong.
 *
 *   durable authority  EvidenceExchangePackageBuild (UNIQUE on package_id)
 *   selector           pollExchangePackageBuilds
 *   claim              claimPackageBuild — conditional ON CONFLICT ... WHERE
 *   executor           buildExchangePackage
 *   terminal writer    the same module (UPLOADED / FAILED)
 *
 * Object storage is the one genuine external boundary and is a RECORDING
 * fake, so every case can assert how many objects were actually written —
 * the count that separates a real claim from a row that merely looks settled.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";
import { provenCase, recordSuiteProof } from "./family-coverage-manifest.js";
import type { WorkspaceFixture } from "./family-harness.js";

const storage = vi.hoisted(() => ({
  put: [] as Array<{ key: string; bytes: number }>,
  fail: false,
  reset() {
    this.put.length = 0;
    this.fail = false;
  },
}));

vi.mock("../../../worker/src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    putObjectBuffer: async (p: { key: string; body?: Buffer }) => {
      if (storage.fail) throw new Error("storage unavailable");
      storage.put.push({ key: p.key, bytes: p.body?.length ?? 0 });
      return { etag: "test" };
    },
  };
});

describe("POINT 5 FAMILY — exchange package builder (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../../src/db.js")["prisma"];
  let builder: typeof import("../../../worker/src/exchange-package-builder.js");
  let own: WorkspaceFixture;
  let foreign: WorkspaceFixture;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    builder = await import("../../../worker/src/exchange-package-builder.js");

    own = {
      teamId: harness.fixtures.teamA.teamId,
      ownerUserId: harness.fixtures.teamA.ownerUserId,
      evidenceId: harness.fixtures.teamA.evidenceId,
      caseId: harness.fixtures.teamA.caseId,
    };
    foreign = {
      teamId: harness.fixtures.teamB.teamId,
      ownerUserId: harness.fixtures.teamB.ownerUserId,
      evidenceId: harness.fixtures.teamB.evidenceId,
      caseId: harness.fixtures.teamB.caseId,
    };
  });

  afterAll(async () => {
    await recordSuiteProof(import.meta.url);
    await harness?.cleanup();
  });

  async function seedPackage(
    fixture: WorkspaceFixture,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = await prisma.evidenceExchangePackage.create({
      data: {
        teamId: fixture.teamId,
        kind: "DISCLOSURE",
        evidenceIds: [fixture.evidenceId],
        state: "BUILDING",
        createdByUserId: fixture.ownerUserId,
        ...overrides,
      },
      select: { id: true },
    });
    return row.id;
  }

  async function buildRow(packageId: string) {
    return prisma.evidenceExchangePackageBuild.findUnique({
      where: { packageId },
      select: {
        id: true,
        teamId: true,
        state: true,
        storageKey: true,
        payloadSha256: true,
        startedAtUtc: true,
        completedAtUtc: true,
        failureReason: true,
      },
    });
  }

  // =========================================================================

  it("the build row is the durable authority, created before any artifact exists", async () => {
    const packageId = await seedPackage(own);
    expect(await buildRow(packageId)).toBeNull();
    storage.reset();

    await builder.buildExchangePackage(packageId, prisma as never);

    const row = await buildRow(packageId);
    expect(row).not.toBeNull();
    expect(row!.state).toBe("UPLOADED");
    expect(row!.startedAtUtc).not.toBeNull();
    expect(row!.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(storage.put).toHaveLength(1);
    provenCase("exchange.durable.intent_before_work");
  });

  it("a package id that names nothing produces no build row and no object", async () => {
    storage.reset();
    await builder.buildExchangePackage(
      "00000000-0000-4000-8000-0000000000ff",
      prisma as never,
    );
    expect(
      await prisma.evidenceExchangePackageBuild.count({
        where: { packageId: "00000000-0000-4000-8000-0000000000ff" },
      }),
    ).toBe(0);
    expect(storage.put).toHaveLength(0);
  });

  it("the workspace is read from the package row, never supplied", async () => {
    const packageId = await seedPackage(own);
    await builder.buildExchangePackage(packageId, prisma as never);
    const row = await buildRow(packageId);
    // Derived from EvidenceExchangePackage.teamId by the executor; the caller
    // passes only an id.
    expect(row!.teamId).toBe(own.teamId);
    provenCase("exchange.tenant.workspace_reloaded");
  });

  it("a foreign package's artifact is attributed to ITS workspace, not ours", async () => {
    const theirs = await seedPackage(foreign);
    const ownBuildsBefore = await prisma.evidenceExchangePackageBuild.count({
      where: { teamId: own.teamId },
    });

    await builder.buildExchangePackage(theirs, prisma as never);

    const row = await buildRow(theirs);
    expect(row!.teamId).toBe(foreign.teamId);
    expect(
      await prisma.evidenceExchangePackageBuild.count({
        where: { teamId: own.teamId },
      }),
    ).toBe(ownBuildsBefore);
    provenCase("exchange.tenant.cross_workspace_denied");
  });

  it("three simultaneous builders upload the artifact exactly once", async () => {
    // The regression proof. `_inFlight` is a per-PROCESS Set, so two worker
    // instances each held their own empty one, both assembled the ZIP, both
    // uploaded it and both wrote a terminal state.
    const packageId = await seedPackage(own);
    storage.reset();

    await Promise.all([
      builder.buildExchangePackage(packageId, prisma as never),
      builder.buildExchangePackage(packageId, prisma as never),
      builder.buildExchangePackage(packageId, prisma as never),
    ]);

    expect(storage.put).toHaveLength(1);
    const row = await buildRow(packageId);
    expect(row!.state).toBe("UPLOADED");
    provenCase("exchange.claim.one_winner");
  });

  it("a LIVE claim is not stolen, and the loser writes nothing", async () => {
    const packageId = await seedPackage(own);
    const held = await prisma.evidenceExchangePackageBuild.create({
      data: {
        teamId: own.teamId,
        packageId,
        state: "BUILDING",
        // Fresh: well inside the lease.
        startedAtUtc: new Date(),
      },
      select: { id: true, startedAtUtc: true },
    });
    storage.reset();

    await builder.buildExchangePackage(packageId, prisma as never);

    const row = await buildRow(packageId);
    expect(row!.id).toBe(held.id);
    expect(row!.state).toBe("BUILDING");
    expect(row!.startedAtUtc?.toISOString()).toBe(
      held.startedAtUtc?.toISOString(),
    );
    // Decisive: the loser never reached storage, so the holder's artifact is
    // the only one that can exist.
    expect(storage.put).toHaveLength(0);
    provenCase("exchange.claim.active_not_stolen");
  });

  it("an EXPIRED lease is recovered by exactly one builder", async () => {
    const packageId = await seedPackage(own);
    await prisma.evidenceExchangePackageBuild.create({
      data: {
        teamId: own.teamId,
        packageId,
        state: "BUILDING",
        // Older than EXCHANGE_BUILD_LEASE_MS: the holder died mid-build.
        startedAtUtc: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });
    storage.reset();

    await Promise.all([
      builder.buildExchangePackage(packageId, prisma as never),
      builder.buildExchangePackage(packageId, prisma as never),
    ]);

    expect(storage.put).toHaveLength(1);
    expect((await buildRow(packageId))!.state).toBe("UPLOADED");
  });

  it("a replay after completion creates no second artifact", async () => {
    const packageId = await seedPackage(own);
    await builder.buildExchangePackage(packageId, prisma as never);
    const first = await buildRow(packageId);
    expect(first!.state).toBe("UPLOADED");
    storage.reset();

    await builder.buildExchangePackage(packageId, prisma as never);

    const second = await buildRow(packageId);
    expect(second).toEqual(first);
    expect(storage.put).toHaveLength(0);
    provenCase("exchange.idempotency.duplicate_is_noop");
  });

  it("a storage failure cannot report UPLOADED", async () => {
    const packageId = await seedPackage(own);
    storage.reset();
    storage.fail = true;
    try {
      await builder.buildExchangePackage(packageId, prisma as never);
    } finally {
      storage.fail = false;
    }

    const row = await buildRow(packageId);
    // The build must say what happened. A row that claims UPLOADED with no
    // object behind it is the failure this case exists to forbid.
    expect(row!.state).not.toBe("UPLOADED");
    expect(row!.state).toBe("FAILED");
    expect(row!.storageKey).toBeNull();
    expect(row!.failureReason).toBeTruthy();
    expect(storage.put).toHaveLength(0);
  });

  it("a terminal package is never rebuilt by a stale selector tick", async () => {
    const packageId = await seedPackage(own);
    await builder.buildExchangePackage(packageId, prisma as never);
    const terminal = await buildRow(packageId);
    // The PACKAGE leaves BUILDING when it completes, and the selector reads
    // only BUILDING packages — so a late tick cannot reach it at all.
    await prisma.evidenceExchangePackage.update({
      where: { id: packageId },
      data: { state: "READY" },
    });
    storage.reset();

    await builder.pollExchangePackageBuilds(prisma as never);
    await new Promise((r) => setTimeout(r, 100));

    expect(await buildRow(packageId)).toEqual(terminal);
    expect(storage.put).toHaveLength(0);
    provenCase("exchange.terminal.stale_cannot_overwrite");
  });

  it("the selector is bounded, ordered, and picks up a stranded build", async () => {
    // A package left BUILDING with no build row at all — the stranded shape
    // an operator sees after a worker dies between the state flip and the
    // first claim. The poller must find it.
    //
    // The selector is bounded and ordered by `createdAt`, so earlier cases in
    // this file that deliberately leave a package BUILDING would otherwise sit
    // ahead of this one and consume the tick's slots. They are settled first,
    // which makes the assertion about the SELECTOR rather than about how many
    // fixtures happen to precede it.
    await prisma.evidenceExchangePackage.updateMany({
      where: { state: "BUILDING" },
      data: { state: "FAILED" },
    });
    const stranded = await seedPackage(own);
    expect(await buildRow(stranded)).toBeNull();
    storage.reset();

    // The poller starts builds without awaiting them — correct for a
    // scheduler tick, and the reason this waits on the durable row rather
    // than on the call. Bounded: a poller that never selects the row fails
    // here rather than hanging.
    let row: Awaited<ReturnType<typeof buildRow>> = null;
    for (let i = 0; i < 40 && row === null; i += 1) {
      await builder.pollExchangePackageBuilds(prisma as never);
      await new Promise((r) => setTimeout(r, 250));
      row = await buildRow(stranded);
    }

    expect(row, "the poller never selected the stranded package").not.toBeNull();
    expect(["BUILDING", "UPLOADED", "FAILED"]).toContain(row!.state);
  });
});
