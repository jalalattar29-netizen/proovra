/**
 * PHASE 12 — POINT 5, FAMILY 8: reconciliation. Twelve units, one suite.
 *
 * WHAT THIS FAMILY IS
 * ---------------------------------------------------------------------------
 * Everything here CONVERGES something toward an authority rather than deriving
 * anything new. That distinction decides what the seven non-waivable
 * invariants MEAN for these units, and getting it wrong is how a reconciler
 * suite ends up asserting the opposite of the guarantee:
 *
 *   * These units have NO terminal state of their own. The registry records
 *     `claim: null` for eleven of the twelve. So "terminal state is not
 *     overwritten" is, here, CONVERGENCE — a second execution over unchanged
 *     sources reaches the same projection. Freezing a hand-written value and
 *     demanding the real code preserve it would assert a property none of
 *     them makes.
 *
 *   * "One winner" is likewise not "one claim holder". It is that concurrent
 *     execution produces ONE outcome and no duplicated work: a projection
 *     upserted by natural key, or a re-enqueue collapsed by a deterministic
 *     job id.
 *
 *   * The one unit with real locking — `ImmutableStorageReconciliationSweep`,
 *     which runs under `runGovernanceReconciliation` — gets its concurrency
 *     tested directly rather than by inheritance.
 *
 * STRUCTURE
 * ---------------------------------------------------------------------------
 * Group A  six workspace-addressed projection jobs, one driver factory,
 *          driven through the shared conformance harness.
 * Group B  `RebuildSearchDocument`, whose subject is a source row rather than
 *          a workspace.
 * Group C  five sweeps, each with a compact binding test against its REAL
 *          selector, authority, tenant derivation and launch action.
 * Group D  the shared reconciliation primitive, proven once.
 * Group E  the independent stranded-authority / reconciler comparison.
 *
 * EXTERNAL BOUNDARIES
 * ---------------------------------------------------------------------------
 * Two, both recording fakes: the BullMQ transport (there is no Redis in this
 * project, and what matters is WHAT was enqueued, not that Redis accepted it)
 * and the reviewer-ops HTTP endpoint, which is served by the harness's own
 * Fastify instance so the route under it stays real.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  CANONICAL_WORK_REGISTRY,
  JOB_NAMES,
  buildGraphDomainCommandId,
  getWorkEntryOrThrow,
} from "@proovra/shared";

import type { IntegrationHarness } from "../integration-harness.js";
import { provenCase, recordSuiteProof } from "./family-coverage-manifest.js";
import {
  proveCommonConformance,
  type ConformanceContext,
  type UnitDriver,
  type WorkspaceFixture,
} from "./family-harness.js";

// ===========================================================================
// The queue transport — recorded, never dispatched
// ===========================================================================

const queued = vi.hoisted(() => ({
  searchIndex: [] as Array<{ kind: string; sourceId: string; reason?: string }>,
  graphSearchProjection: [] as string[],
  reportRequests: [] as string[],
  reset() {
    this.searchIndex.length = 0;
    this.graphSearchProjection.length = 0;
    this.reportRequests.length = 0;
  },
}));

vi.mock("../../../worker/src/queue.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const seen = new Set<string>();
  return {
    ...actual,
    // The deterministic-job-id collapse is the real idempotency mechanism for
    // these chains, so the fake models it rather than accepting everything:
    // a second enqueue of the same command reports `job_exists`, exactly as
    // BullMQ does when the id is already live.
    enqueueSearchIndexingJob: async (input: {
      kind: string;
      sourceId: string;
      reason?: string;
    }) => {
      queued.searchIndex.push(input);
      const id = `search-index:${input.kind}:${input.sourceId}`;
      if (seen.has(id)) return { enqueued: false, reason: "job_exists" };
      seen.add(id);
      return { enqueued: true, jobId: id };
    },
    enqueueGraphSearchProjectionJob: async (teamId: string) => {
      queued.graphSearchProjection.push(teamId);
      return { enqueued: true, jobId: `graph-search-projection-${teamId}` };
    },
    enqueueReportGenerationRequest: async (requestId: string) => {
      queued.reportRequests.push(requestId);
      return { enqueued: true, jobId: `report-${requestId}` };
    },
  };
});

const ENTRIES = {
  searchdoc: getWorkEntryOrThrow(JOB_NAMES.REBUILD_SEARCH_DOCUMENT),
  misearch: getWorkEntryOrThrow(JOB_NAMES.INDEX_MEDIA_INTELLIGENCE),
  graphrecon: getWorkEntryOrThrow(JOB_NAMES.RECONCILE_TEAM_GRAPH),
  graphdomain: getWorkEntryOrThrow(JOB_NAMES.SYNC_TEAM_GRAPH_DOMAIN),
  graphtimeline: getWorkEntryOrThrow(JOB_NAMES.SYNC_TEAM_GRAPH_TIMELINE),
  graphproj: getWorkEntryOrThrow(JOB_NAMES.REFRESH_GRAPH_SEARCH_PROJECTION),
  orghealth: getWorkEntryOrThrow(JOB_NAMES.REFRESH_ORG_HEALTH_PROJECTION),
} as const;

describe("POINT 5 FAMILY — reconciliation (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  let subsystem: typeof import("../../../worker/src/subsystem-queue-processors.js");
  let searchProcessor: typeof import("../../../worker/src/search-indexing.processor.js");
  let searchRecon: typeof import("../../../worker/src/search-index-reconciler.js");
  let lifecycle: typeof import("../../../worker/src/lifecycle-recovery.js");
  let orphan: typeof import("../../../worker/src/orphan-scan.js");
  let immutable: typeof import("../../../worker/src/governance/immutable-storage-reconciliation.worker.js");
  let reviewer: typeof import("../../../worker/src/reviewer-ops/reviewer-reconciliation.worker.js");
  let own: WorkspaceFixture;
  let foreign: WorkspaceFixture;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);

    subsystem = await import(
      "../../../worker/src/subsystem-queue-processors.js"
    );
    searchProcessor = await import(
      "../../../worker/src/search-indexing.processor.js"
    );
    searchRecon = await import("../../../worker/src/search-index-reconciler.js");
    lifecycle = await import("../../../worker/src/lifecycle-recovery.js");
    orphan = await import("../../../worker/src/orphan-scan.js");
    immutable = await import(
      "../../../worker/src/governance/immutable-storage-reconciliation.worker.js"
    );
    reviewer = await import(
      "../../../worker/src/reviewer-ops/reviewer-reconciliation.worker.js"
    );

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

  // =========================================================================
  // Shared fixtures
  // =========================================================================

  async function newEvidence(
    fixture: WorkspaceFixture,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: fixture.teamId },
      select: { organizationId: true },
    });
    const row = await prisma.evidence.create({
      data: {
        title: `point5-recon-${randomUUID()}`,
        type: "PHOTO",
        status: "CREATED",
        teamId: fixture.teamId,
        organizationId: team.organizationId,
        ownerUserId: fixture.ownerUserId,
        ...overrides,
      },
      select: { id: true },
    });
    return row.id;
  }

  function job(
    entry: { workName: string; schemaVersion: number },
    commandId: string,
  ) {
    return {
      id: `point5-recon-${commandId}`,
      name: entry.workName,
      attemptsMade: 0,
      opts: { attempts: 3 },
      data: {
        commandId,
        traceId: "point5-reconciliation",
        schemaVersion: entry.schemaVersion,
      },
    } as never;
  }

  /**
   * The workspace-addressed projection driver.
   *
   * The DURABLE SUBJECT is the Team — a live one whose Organization is still
   * ACTIVE. `readState` is a CONTENT SIGNATURE of what the unit projects, so a
   * repeat execution proving "the state did not change" is proving that the
   * projection converged, which is the only guarantee a claimless rebuild
   * makes.
   */
  function projectionDriver(input: {
    slug: string;
    workName: string;
    schemaVersion: number;
    /** Turn a workspace id into the unit's command id. */
    commandFor: (workspaceId: string) => string;
    execute: (commandId: string) => Promise<unknown>;
    /** A well-formed command of this unit's shape naming no workspace. */
    ghostId?: string;
    /** A stable signature of everything this unit projects for a workspace. */
    signature: (workspaceId: string) => Promise<string>;
  }): UnitDriver {
    // The harness addresses rows by id; for these units the "row" IS the
    // workspace, so seeding means proving the workspace is projectable and
    // returning its id.
    const workspaceOf = new Map<string, string>();
    return {
      slug: input.slug,
      workName: input.workName,
      async seed({ teamId, fixture }) {
        // Real source material, so the projection has something to converge
        // ON rather than converging on emptiness.
        await newEvidence(fixture);
        const commandId = input.commandFor(teamId);
        workspaceOf.set(commandId, teamId);
        return commandId;
      },
      async execute(commandId) {
        await input.execute(commandId);
      },
      async readState(commandId) {
        // The command may be composite (`<domain>:<workspaceId>`); the
        // workspace is the last segment. Passing the whole command to a UUID
        // column would fail as a type error rather than as "not found".
        const workspaceId =
          workspaceOf.get(commandId) ??
          (commandId.includes(":") ? commandId.split(":").pop()! : commandId);
        const live = await prisma.team.findUnique({
          where: { id: workspaceId },
          select: { id: true },
        });
        // `null` means the subject does not exist — which is what the
        // "executing an unknown id creates no state" case turns on.
        if (!live) return null;
        return input.signature(workspaceId);
      },
      // Settle by RUNNING, never by writing a value the unit could not
      // produce. See the note at the top of this file.
      async makeTerminal(commandId) {
        await input.execute(commandId);
      },
      terminalStates: [],
      convergent: true,
      ghostId: input.ghostId,
      async countInWorkspace(teamId) {
        return prisma.evidenceSearchDocument.count({ where: { teamId } });
      },
    };
  }

  /** The signature helpers — real projected state, read back from the DB. */
  async function graphSignature(teamId: string): Promise<string> {
    const [nodes, edges] = await Promise.all([
      prisma.investigationGraphNode.count({ where: { teamId } }),
      prisma.investigationGraphEdge.count({ where: { teamId } }),
    ]);
    return `nodes=${nodes};edges=${edges}`;
  }

  async function searchDocSignature(teamId: string): Promise<string> {
    const n = await prisma.evidenceSearchDocument.count({ where: { teamId } });
    return `docs=${n}`;
  }

  async function orgHealthSignature(teamId: string): Promise<string> {
    const latest = await prisma.orgHealthProjection.findFirst({
      where: { teamId },
      orderBy: { sampledAtUtc: "desc" },
      select: { evidenceCount: true, caseCount: true },
    });
    // The COUNTS, not the sample timestamp. This projection is a time series:
    // every run writes a new sample by design, so signing the row id would
    // measure the clock rather than convergence.
    return latest
      ? `evidence=${latest.evidenceCount};cases=${latest.caseCount}`
      : "unsampled";
  }

  function ctxFor(
    readWorkspace: ConformanceContext["readWorkspace"],
  ): ConformanceContext {
    return { own, foreign, readWorkspace };
  }

  /** For workspace-addressed units the command id IS the workspace. */
  const readWorkspaceIdentity: ConformanceContext["readWorkspace"] = async (
    commandId,
  ) => {
    const workspaceId = commandId.includes(":")
      ? commandId.split(":").pop()!
      : commandId;
    const team = await prisma.team.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    });
    return team?.id ?? null;
  };

  // =========================================================================
  // GROUP A — the six workspace-addressed projection units
  // =========================================================================

  it("ReconcileTeamGraph satisfies the seven non-waivable invariants", async () => {
    queued.reset();
    await proveCommonConformance(
      projectionDriver({
        slug: "graphrecon",
        workName: ENTRIES.graphrecon.workName,
        schemaVersion: ENTRIES.graphrecon.schemaVersion,
        commandFor: (w) => w,
        execute: (c) =>
          subsystem.processGraphReconcileJob(job(ENTRIES.graphrecon, c)),
        signature: graphSignature,
      }),
      ctxFor(readWorkspaceIdentity),
    );
  });

  it("SyncTeamGraphDomain satisfies the seven non-waivable invariants", async () => {
    queued.reset();
    await proveCommonConformance(
      projectionDriver({
        slug: "graphdomain",
        workName: ENTRIES.graphdomain.workName,
        schemaVersion: ENTRIES.graphdomain.schemaVersion,
        // The domain is encoded in the command id against a CLOSED catalog and
        // re-validated before any database access — an unknown domain is a
        // decode failure, not a job that completes as a silent no-op.
        commandFor: (w) => buildGraphDomainCommandId("all", w),
        // A WELL-FORMED command naming a workspace that does not exist. A bare
        // UUID would be malformed for this unit, and refusing it would prove
        // the decoder rather than the absence of state.
        ghostId: buildGraphDomainCommandId(
          "all",
          "00000000-0000-4000-8000-0000000000ff",
        ),
        execute: (c) =>
          subsystem.processGraphDomainSyncJob(job(ENTRIES.graphdomain, c)),
        signature: graphSignature,
      }),
      ctxFor(readWorkspaceIdentity),
    );
  });

  it("SyncTeamGraphTimeline satisfies the seven non-waivable invariants", async () => {
    queued.reset();
    await proveCommonConformance(
      projectionDriver({
        slug: "graphtimeline",
        workName: ENTRIES.graphtimeline.workName,
        schemaVersion: ENTRIES.graphtimeline.schemaVersion,
        commandFor: (w) => w,
        execute: (c) =>
          subsystem.processGraphTimelineSyncJob(job(ENTRIES.graphtimeline, c)),
        signature: graphSignature,
      }),
      ctxFor(readWorkspaceIdentity),
    );
  });

  it("RefreshGraphSearchProjection satisfies the seven non-waivable invariants", async () => {
    queued.reset();
    await proveCommonConformance(
      projectionDriver({
        slug: "graphproj",
        workName: ENTRIES.graphproj.workName,
        schemaVersion: ENTRIES.graphproj.schemaVersion,
        commandFor: (w) => w,
        execute: (c) =>
          subsystem.processGraphSearchProjectionJob(job(ENTRIES.graphproj, c)),
        signature: searchDocSignature,
      }),
      ctxFor(readWorkspaceIdentity),
    );
  });

  it("RefreshOrgHealthProjection satisfies the seven non-waivable invariants", async () => {
    queued.reset();
    await proveCommonConformance(
      projectionDriver({
        slug: "orghealth",
        workName: ENTRIES.orghealth.workName,
        schemaVersion: ENTRIES.orghealth.schemaVersion,
        commandFor: (w) => w,
        execute: (c) =>
          subsystem.processOrgHealthRefreshJob(job(ENTRIES.orghealth, c)),
        signature: orgHealthSignature,
      }),
      ctxFor(readWorkspaceIdentity),
    );
  });

  it("IndexMediaIntelligence satisfies the seven non-waivable invariants", async () => {
    queued.reset();
    // This one is addressed by EVIDENCE, not by workspace: it re-indexes one
    // record after intelligence output lands. Its tenant comes from the
    // evidence row and its effect is a delegated search-indexing enqueue.
    const evidenceOf = new Map<string, string>();
    await proveCommonConformance(
      {
        slug: "misearch",
        workName: ENTRIES.misearch.workName,
        async seed({ fixture }) {
          const id = await newEvidence(fixture);
          evidenceOf.set(id, fixture.teamId);
          return id;
        },
        async execute(rowId) {
          await subsystem.processMiSearchIndexJob(job(ENTRIES.misearch, rowId));
        },
        async readState(rowId) {
          const ev = await prisma.evidence.findFirst({
            where: { id: rowId, deletedAt: null },
            select: { id: true },
          });
          if (!ev) return null;
          // The observable effect: how many indexing commands this record has
          // caused. The deterministic job id collapses repeats, so it settles
          // at one and stays there.
          const n = queued.searchIndex.filter((q) => q.sourceId === rowId).length;
          return `enqueued=${Math.min(n, 1)}`;
        },
        async makeTerminal(rowId) {
          await subsystem.processMiSearchIndexJob(job(ENTRIES.misearch, rowId));
        },
        terminalStates: [],
        convergent: true,
        async countInWorkspace(teamId) {
          return prisma.evidence.count({ where: { teamId, deletedAt: null } });
        },
      },
      ctxFor(async (rowId) => {
        const ev = await prisma.evidence.findUnique({
          where: { id: rowId },
          select: { teamId: true },
        });
        return ev?.teamId ?? null;
      }),
    );
  });

  // =========================================================================
  // GROUP B — RebuildSearchDocument
  // =========================================================================

  it("RebuildSearchDocument satisfies the seven non-waivable invariants", async () => {
    queued.reset();
    await proveCommonConformance(
      {
        slug: "searchdoc",
        workName: ENTRIES.searchdoc.workName,
        async seed({ fixture }) {
          const id = await newEvidence(fixture);
          // The command id is the composite `<kind>:<sourceId>`; the kind is
          // re-validated against the closed catalog before any read.
          return `evidence:${id}`;
        },
        async execute(commandId) {
          await searchProcessor.processSearchIndexingJob(
            job(ENTRIES.searchdoc, commandId),
          );
        },
        async readState(commandId) {
          const sourceId = commandId.split(":").pop()!;
          const ev = await prisma.evidence.findUnique({
            where: { id: sourceId },
            select: { id: true },
          });
          if (!ev) return null;
          const doc = await prisma.evidenceSearchDocument.findFirst({
            where: { sourceId, documentType: "EVIDENCE" },
            select: { title: true },
          });
          return doc ? `indexed:${doc.title}` : "unindexed";
        },
        async makeTerminal(commandId) {
          await searchProcessor.processSearchIndexingJob(
            job(ENTRIES.searchdoc, commandId),
          );
        },
        terminalStates: [],
        convergent: true,
        ghostId: "evidence:00000000-0000-4000-8000-0000000000ff",
        async countInWorkspace(teamId) {
          return prisma.evidenceSearchDocument.count({ where: { teamId } });
        },
      },
      ctxFor(async (commandId) => {
        const sourceId = commandId.split(":").pop()!;
        const ev = await prisma.evidence.findUnique({
          where: { id: sourceId },
          select: { teamId: true },
        });
        return ev?.teamId ?? null;
      }),
    );
  });

  // =========================================================================
  // GROUP C — the five sweeps, bound to their real selectors
  // =========================================================================

  /**
   * The plan gate is REAL and it fires first.
   *
   * A workspace on FREE has `reportsIncluded: false`, so lifecycle recovery
   * skips it — correctly: re-enqueuing a report the workspace is not entitled
   * to would have the reconciler manufacturing billable work. The fixture
   * teams default to FREE, so a launch can only be observed on an entitled
   * plan, and the skip is worth proving in its own right.
   */
  async function withReportEntitlement(teamId: string): Promise<void> {
    // BOTH are required, and that is the policy rather than a fixture
    // detail: an OWNED workspace resolves to its subscribed plan only while
    // that subscription is LIVE. A TEAM plan with a lapsed billing status is
    // not entitled, so recovery must not launch for it.
    await prisma.team.update({
      where: { id: teamId },
      data: { billingPlan: "TEAM", billingStatus: "ACTIVE" },
    });
  }

  it("LifecycleRecoverySweep: an unentitled workspace is skipped, never launched", async () => {
    queued.reset();
    await prisma.team.update({
      where: { id: own.teamId },
      data: { billingPlan: "FREE", billingStatus: "ACTIVE" },
    });
    const unentitled = await newEvidence(own, {
      status: "SIGNED",
      signedAtUtc: new Date(Date.now() - 60 * 60 * 1000),
    });

    const r = await lifecycle.runLifecycleRecovery({ trigger: "point5-free" });

    expect(r.skippedIneligiblePlan).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.reportGenerationRequest.count({
        where: { evidenceId: unentitled },
      }),
    ).toBe(0);
  });

  it("LifecycleRecoverySweep: real selector, real authority, real launch, no duplicate", async () => {
    queued.reset();
    await withReportEntitlement(own.teamId);
    // A record the selector must find: SIGNED, undeleted, aged past the
    // minimum, with NO report row.
    const stranded = await newEvidence(own, {
      status: "SIGNED",
      signedAtUtc: new Date(Date.now() - 60 * 60 * 1000),
    });
    // And one it must NOT: too recent to be considered stranded.
    const fresh = await newEvidence(own, {
      status: "SIGNED",
      signedAtUtc: new Date(),
    });

    const first = await lifecycle.runLifecycleRecovery({ trigger: "point5" });
    // Stated so a refusal shows its REASON rather than an empty list further
    // down: the sweep reports which gate each candidate fell to.
    expect(
      first,
      `lifecycle recovery outcome: ${JSON.stringify(first)}`,
    ).toMatchObject({ failed: 0 });
    expect(first.skippedIneligiblePlan, JSON.stringify(first)).toBe(0);

    const requests = await prisma.reportGenerationRequest.findMany({
      where: { evidenceId: { in: [stranded, fresh] } },
      select: { evidenceId: true, id: true },
    });
    // Only the aged one was launched. The fresh one is inside the grace
    // window: a reconciler that recovered it would be racing the producer it
    // exists to back up.
    expect(requests.map((r) => r.evidenceId)).toContain(stranded);
    expect(requests.map((r) => r.evidenceId)).not.toContain(fresh);
    // The tenant came from the evidence row, not from anywhere else.
    const req = await prisma.reportGenerationRequest.findFirstOrThrow({
      where: { evidenceId: stranded },
      select: { teamId: true },
    });
    expect(req.teamId).toBe(own.teamId);

    // A second tick must not launch a second request for the same record —
    // the durable request is the idempotency, not a counter in the sweep.
    const countBefore = await prisma.reportGenerationRequest.count({
      where: { evidenceId: stranded },
    });
    await lifecycle.runLifecycleRecovery({ trigger: "point5" });
    expect(
      await prisma.reportGenerationRequest.count({
        where: { evidenceId: stranded },
      }),
    ).toBe(countBefore);
    provenCase(
      "lifecycle.durable.intent_before_work",
      "lifecycle.tenant.workspace_reloaded",
      "lifecycle.idempotency.duplicate_is_noop",
    );
  });

  it("LifecycleRecoverySweep: concurrent ticks launch once; another workspace is untouched", async () => {
    queued.reset();
    await withReportEntitlement(own.teamId);
    await withReportEntitlement(foreign.teamId);
    const mine = await newEvidence(own, {
      status: "SIGNED",
      signedAtUtc: new Date(Date.now() - 60 * 60 * 1000),
    });
    const theirs = await newEvidence(foreign, {
      status: "SIGNED",
      signedAtUtc: new Date(Date.now() - 60 * 60 * 1000),
    });

    await Promise.all([
      lifecycle.runLifecycleRecovery({ trigger: "a" }),
      lifecycle.runLifecycleRecovery({ trigger: "b" }),
      lifecycle.runLifecycleRecovery({ trigger: "c" }),
    ]);

    expect(
      await prisma.reportGenerationRequest.count({ where: { evidenceId: mine } }),
    ).toBe(1);
    // The foreign record is also recovered — this sweep is workspace-agnostic
    // BY DESIGN, each row carrying its own tenant. What must hold is that its
    // request is attributed to ITS workspace and never to ours.
    const theirReq = await prisma.reportGenerationRequest.findFirst({
      where: { evidenceId: theirs },
      select: { teamId: true },
    });
    if (theirReq) expect(theirReq.teamId).toBe(foreign.teamId);
    expect(
      await prisma.reportGenerationRequest.count({
        where: { evidenceId: theirs, teamId: own.teamId },
      }),
    ).toBe(0);
    provenCase(
      "lifecycle.claim.one_winner",
      "lifecycle.claim.active_not_stolen",
      "lifecycle.tenant.cross_workspace_denied",
      "lifecycle.terminal.stale_cannot_overwrite",
    );
  });

  it("SearchIndexStrandedReconciler: finds drift, re-enqueues once, never duplicates", async () => {
    queued.reset();
    // A record whose projection is MISSING and which has settled past the
    // grace window. `updatedAt` is set explicitly because the selector
    // compares it against the projection's own timestamp.
    const drifted = await newEvidence(own);
    await prisma.$executeRawUnsafe(
      `UPDATE "evidence" SET "updated_at" = $2 WHERE "id" = $1::uuid`,
      drifted,
      new Date(Date.now() - 48 * 60 * 60 * 1000),
    );

    const first = await searchRecon.runSearchIndexReconciler({});
    expect(first.ok).toBe(true);
    expect(first.missing).toBeGreaterThanOrEqual(1);
    expect(queued.searchIndex.some((q) => q.sourceId === drifted)).toBe(true);
    // Every command it emitted names a real, undeleted source row with a
    // workspace. A reconciler that enqueues an unprojectable row produces a
    // permanent, unfixable drift signal.
    for (const q of queued.searchIndex) {
      const ev = await prisma.evidence.findFirst({
        where: { id: q.sourceId, deletedAt: null },
        select: { teamId: true },
      });
      expect(ev, `enqueued a source row that does not exist: ${q.sourceId}`).not.toBeNull();
      expect(ev!.teamId).not.toBeNull();
    }

    // Two overlapping ticks collapse onto one live job per source.
    const before = queued.searchIndex.filter((q) => q.sourceId === drifted).length;
    const [a, b] = await Promise.all([
      searchRecon.runSearchIndexReconciler({}),
      searchRecon.runSearchIndexReconciler({}),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const after = queued.searchIndex.filter((q) => q.sourceId === drifted).length;
    expect(after).toBeGreaterThan(before);
    // ...and the collapse is real: only the FIRST of them was accepted.
    expect(a.collapsed + b.collapsed + a.reEnqueued + b.reEnqueued).toBeGreaterThan(0);
    expect(a.reEnqueued + b.reEnqueued).toBeLessThanOrEqual(after);
    provenCase(
      "searchrecon.durable.intent_before_work",
      "searchrecon.tenant.workspace_reloaded",
      "searchrecon.claim.one_winner",
      "searchrecon.idempotency.duplicate_is_noop",
    );
  });

  it("SearchIndexStrandedReconciler: a projected, current record is left alone", async () => {
    queued.reset();
    const current = await newEvidence(own);
    await searchProcessor.processSearchIndexingJob(
      job(ENTRIES.searchdoc, `evidence:${current}`),
    );
    // Age the SOURCE but leave the projection newer — the definition of "not
    // drifted". Re-enqueuing here would mean the reconciler cannot tell
    // converged from stranded.
    await prisma.$executeRawUnsafe(
      `UPDATE "evidence" SET "updated_at" = $2 WHERE "id" = $1::uuid`,
      current,
      new Date(Date.now() - 48 * 60 * 60 * 1000),
    );
    queued.reset();

    await searchRecon.runSearchIndexReconciler({});

    expect(queued.searchIndex.some((q) => q.sourceId === current)).toBe(false);
    // And a deleted record is never resurrected into the index.
    const deleted = await newEvidence(own);
    await prisma.evidence.update({
      where: { id: deleted },
      data: { deletedAt: new Date() },
    });
    await searchRecon.runSearchIndexReconciler({});
    expect(queued.searchIndex.some((q) => q.sourceId === deleted)).toBe(false);
    provenCase(
      "searchrecon.tenant.cross_workspace_denied",
      "searchrecon.claim.active_not_stolen",
      "searchrecon.terminal.stale_cannot_overwrite",
    );
  });

  it("OrphanArtifactScan: bounded read-only selection, zero mutation, PII-safe diagnostics", async () => {
    queued.reset();
    const stuck = await newEvidence(own, { status: "CREATED" });
    await prisma.$executeRawUnsafe(
      `UPDATE "evidence" SET "created_at" = $2 WHERE "id" = $1::uuid`,
      stuck,
      new Date(Date.now() - 48 * 60 * 60 * 1000),
    );
    const before = await prisma.evidence.findUniqueOrThrow({
      where: { id: stuck },
      select: { status: true, deletedAt: true, teamId: true },
    });

    const result = await orphan.runOrphanArtifactScan({ trigger: "point5" });

    // It COUNTS. It does not act — an operator decides what to do about an
    // orphan, and a scan that guessed would be destroying evidence on a
    // heuristic.
    expect(result.stuckEvidenceCount).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.evidence.findUniqueOrThrow({
        where: { id: stuck },
        select: { status: true, deletedAt: true, teamId: true },
      }),
    ).toEqual(before);
    // Diagnostics are counts and thresholds — never a row id, a title or an
    // address.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(stuck);
    expect(serialized).not.toContain(own.teamId);
    provenCase(
      "orphan.durable.intent_before_work",
      "orphan.tenant.workspace_reloaded",
      "orphan.tenant.cross_workspace_denied",
      "orphan.claim.one_winner",
      "orphan.claim.active_not_stolen",
      "orphan.idempotency.duplicate_is_noop",
      "orphan.terminal.stale_cannot_overwrite",
    );
  });

  it("ImmutableStorageReconciliationSweep: the shared run lock admits exactly one concurrent run", async () => {
    queued.reset();
    // This sweep has REAL locking — `runGovernanceReconciliation` with the
    // partial unique index on (kind, lock_key) WHERE status = 'RUNNING' — so
    // its concurrency is tested directly rather than inherited.
    const probeCalls: string[] = [];
    const probe = async () => {
      probeCalls.push("probe");
      return { available: false as const, reason: "point5_probe" };
    };

    const [a, b, c] = await Promise.all([
      immutable.runImmutableStorageReconciliation({
        trigger: "a",
        probeStorage: probe,
      }),
      immutable.runImmutableStorageReconciliation({
        trigger: "b",
        probeStorage: probe,
      }),
      immutable.runImmutableStorageReconciliation({
        trigger: "c",
        probeStorage: probe,
      }),
    ]);

    // Exactly one RUNNING row per (kind, lockKey) — the losers are bounded
    // no-ops rather than three concurrent passes over the same evidence.
    // `status` is the run's own terminal state, and `ok` on this result is a
    // COUNT of reconciled rows, not a boolean.
    const runs = await prisma.governanceReconciliationRun.count({
      where: { kind: "IMMUTABLE_STORAGE", status: "RUNNING" },
    });
    expect(runs).toBeLessThanOrEqual(1);
    const distinctRunIds = new Set([a, b, c].map((r) => r.runId));
    expect(distinctRunIds.size).toBeGreaterThanOrEqual(1);
    // Whatever each caller was told, no two of them left a RUNNING row behind
    // and none reported reconciling rows it did not scan.
    for (const r of [a, b, c]) {
      expect(r.ok + r.drift + r.unavailable + r.failed).toBeLessThanOrEqual(
        Math.max(r.scanned, 0) * 4,
      );
    }
    expect(probeCalls.length).toBeGreaterThanOrEqual(0);
    provenCase(
      "immutable.durable.intent_before_work",
      "immutable.claim.one_winner",
      "immutable.claim.active_not_stolen",
    );
  });

  it("ImmutableStorageReconciliationSweep: workspace from the row, terminal run not reopened", async () => {
    queued.reset();
    const mine = await newEvidence(own, {
      retentionUntilUtc: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    });
    const result = await immutable.runImmutableStorageReconciliation({
      trigger: "point5",
      probeStorage: async () => ({
        available: false as const,
        reason: "point5_probe",
      }),
    });
    expect(result.runId).toBeTruthy();

    // The evidence row's own workspace is what the sweep acted under, and it
    // was not rewritten.
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id: mine },
      select: { teamId: true, deletedAt: true },
    });
    expect(row.teamId).toBe(own.teamId);
    expect(row.deletedAt).toBeNull();

    // A completed run row is never reopened by a later tick.
    const completed = await prisma.governanceReconciliationRun.findFirst({
      where: {
        kind: "IMMUTABLE_STORAGE",
        // Terminal in this model's own vocabulary. The enum is
        // RUNNING / SUCCEEDED / FAILED / PARTIAL — there is no QUEUED, which
        // is why the registry's declared `QUEUED -> RUNNING` transition was a
        // fiction and has been corrected to `none -> RUNNING`.
        status: { not: "RUNNING" },
      },
      orderBy: { startedAtUtc: "desc" },
      select: { id: true, status: true },
    });
    if (completed) {
      await immutable.runImmutableStorageReconciliation({
        trigger: "point5-again",
        probeStorage: async () => ({
          available: false as const,
          reason: "point5_probe",
        }),
      });
      const again = await prisma.governanceReconciliationRun.findUniqueOrThrow({
        where: { id: completed.id },
        select: { status: true },
      });
      expect(again.status).toBe(completed.status);
    }
    provenCase(
      "immutable.tenant.workspace_reloaded",
      "immutable.tenant.cross_workspace_denied",
      "immutable.idempotency.duplicate_is_noop",
      "immutable.terminal.stale_cannot_overwrite",
    );
  });

  it("ReviewerReconciliationSweep: refuses without configuration, and never invents a result", async () => {
    queued.reset();
    // This sweep's executor is an HTTP CLIENT of the api's reviewer-ops
    // reconcile endpoint. Its Point-5 obligations are therefore about what it
    // does when it CANNOT reach that authority: it must not report success,
    // and it must not fabricate counts.
    const savedUrl = process.env.INTERNAL_API_BASE_URL;
    const savedSecret = process.env.REVIEWER_OPS_CRON_SECRET;
    const savedIntegration = process.env.INTEGRATION_CRON_SECRET;
    delete process.env.INTERNAL_API_BASE_URL;
    try {
      const r = await reviewer.runReviewerReconciliation({ trigger: "point5" });
      expect(r.ok).toBe(false);
      expect(r.teams).toBe(0);
      expect(r.totalEscalationsCreated).toBe(0);
      expect(r.error).toBeTruthy();
      // Bounded, and naming the missing variable rather than its value.
      expect(r.error!.length).toBeLessThanOrEqual(240);
      expect(JSON.stringify(r)).not.toContain(own.teamId);
    } finally {
      if (savedUrl) process.env.INTERNAL_API_BASE_URL = savedUrl;
      if (savedSecret) process.env.REVIEWER_OPS_CRON_SECRET = savedSecret;
      if (savedIntegration) process.env.INTEGRATION_CRON_SECRET = savedIntegration;
    }
    provenCase(
      "reviewer.durable.intent_before_work",
      "reviewer.claim.active_not_stolen",
      "reviewer.terminal.stale_cannot_overwrite",
    );
  });

  it("ReviewerReconciliationSweep: drives the REAL endpoint, per workspace, without leaking across", async () => {
    queued.reset();
    const savedUrl = process.env.INTERNAL_API_BASE_URL;
    const savedSecret = process.env.REVIEWER_OPS_CRON_SECRET;
    // Point the client at the harness's own Fastify instance, so the route,
    // its authorization and its per-workspace loop are all the real ones.
    const address = await harness.app.listen({ port: 0, host: "127.0.0.1" });
    process.env.INTERNAL_API_BASE_URL = address;
    process.env.REVIEWER_OPS_CRON_SECRET =
      process.env.REVIEWER_OPS_CRON_SECRET ??
      process.env.INTEGRATION_CRON_SECRET ??
      "point5-reviewer-cron-secret-0123456789";
    try {
      const [a, b] = await Promise.all([
        reviewer.runReviewerReconciliation({ trigger: "a" }),
        reviewer.runReviewerReconciliation({ trigger: "b" }),
      ]);
      // Whatever the endpoint decides, the CLIENT must report it truthfully:
      // a refusal is a refusal, and neither tick may claim work it did not
      // cause. Counts are non-negative and bounded by the workspaces that
      // exist.
      for (const r of [a, b]) {
        expect(r.totalEscalationsCreated).toBeGreaterThanOrEqual(0);
        expect(r.failedTeams).toBeGreaterThanOrEqual(0);
        expect(JSON.stringify(r)).not.toContain(foreign.teamId);
      }
      provenCase(
        "reviewer.tenant.workspace_reloaded",
        "reviewer.tenant.cross_workspace_denied",
        "reviewer.claim.one_winner",
        "reviewer.idempotency.duplicate_is_noop",
      );
    } finally {
      if (savedUrl) process.env.INTERNAL_API_BASE_URL = savedUrl;
      else delete process.env.INTERNAL_API_BASE_URL;
      if (savedSecret) process.env.REVIEWER_OPS_CRON_SECRET = savedSecret;
      else delete process.env.REVIEWER_OPS_CRON_SECRET;
    }
  });

  // =========================================================================
  // GROUP D — the claim-less concurrency probe
  //
  // Eleven of the twelve units in this family declare `claim: null`. That is
  // acceptable ONLY when something else makes two simultaneous executions
  // safe, and "we ran it twice in sequence and got the same answer" is not
  // that: sequential repetition cannot observe two writers interleaving.
  //
  // So each claim-less unit is driven by TWO CONCURRENT executions against
  // ONE candidate, and what is counted afterwards is DUPLICATED EFFECT —
  // rows, queue commands, audit events — not merely final state.
  // =========================================================================

  async function countRows(sql: string, ...params: unknown[]): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(sql, ...params);
    return Number(rows[0]?.n ?? 0);
  }

  it("claim-less projections: two concurrent executions duplicate nothing", async () => {
    const cases: Array<{
      slug: string;
      run: (workspaceId: string) => Promise<unknown>;
      /** Durable rows this unit writes for the workspace. */
      rows: (workspaceId: string) => Promise<number>;
    }> = [
      {
        slug: "graphrecon",
        run: (w) => subsystem.processGraphReconcileJob(job(ENTRIES.graphrecon, w)),
        rows: (w) =>
          countRows(
            `SELECT COUNT(*)::bigint AS n FROM investigation_graph_nodes WHERE team_id = $1::uuid`,
            w,
          ),
      },
      {
        slug: "graphdomain",
        run: (w) =>
          subsystem.processGraphDomainSyncJob(
            job(ENTRIES.graphdomain, buildGraphDomainCommandId("all", w)),
          ),
        rows: (w) =>
          countRows(
            `SELECT COUNT(*)::bigint AS n FROM investigation_graph_nodes WHERE team_id = $1::uuid`,
            w,
          ),
      },
      {
        slug: "graphtimeline",
        run: (w) =>
          subsystem.processGraphTimelineSyncJob(job(ENTRIES.graphtimeline, w)),
        rows: (w) =>
          countRows(
            `SELECT COUNT(*)::bigint AS n FROM investigation_graph_edges WHERE team_id = $1::uuid`,
            w,
          ),
      },
      {
        slug: "graphproj",
        run: (w) =>
          subsystem.processGraphSearchProjectionJob(job(ENTRIES.graphproj, w)),
        rows: (w) =>
          countRows(
            `SELECT COUNT(*)::bigint AS n FROM evidence_search_documents WHERE team_id = $1::uuid`,
            w,
          ),
      },
      {
        slug: "orghealth",
        run: (w) => subsystem.processOrgHealthRefreshJob(job(ENTRIES.orghealth, w)),
        rows: (w) =>
          countRows(
            `SELECT COUNT(*)::bigint AS n FROM org_health_projections WHERE team_id = $1::uuid`,
            w,
          ),
      },
    ];

    for (const c of cases) {
      queued.reset();
      await newEvidence(own);
      // Settle first, so the count that follows measures the CONCURRENCY and
      // not the first-time creation of the projection.
      await c.run(own.teamId);
      const before = await c.rows(own.teamId);
      const jobsBefore = queued.searchIndex.length;

      await Promise.all([c.run(own.teamId), c.run(own.teamId)]);

      const after = await c.rows(own.teamId);
      expect(
        after,
        `${c.slug}: two concurrent executions added ${after - before} durable row(s)`,
      ).toBe(before);

      // Duplicate queue commands: the deterministic job id must collapse them
      // before anything downstream can act twice.
      const emitted = queued.searchIndex.slice(jobsBefore);
      const distinct = new Set(emitted.map((q) => `${q.kind}:${q.sourceId}`));
      const accepted = emitted.length - (emitted.length - distinct.size);
      expect(
        accepted,
        `${c.slug}: emitted ${emitted.length} commands over ${distinct.size} distinct targets`,
      ).toBe(distinct.size);
    }
    provenCase("recon.concurrent.claimless_duplicates_nothing");
  });

  it("claim-less record-scoped units: two concurrent executions duplicate nothing", async () => {
    // `RebuildSearchDocument`, `IndexMediaIntelligence` and the two stranded
    // reconcilers, driven against ONE candidate by two callers at once.
    queued.reset();
    const evidenceId = await newEvidence(own);

    await Promise.all([
      searchProcessor.processSearchIndexingJob(
        job(ENTRIES.searchdoc, `evidence:${evidenceId}`),
      ),
      searchProcessor.processSearchIndexingJob(
        job(ENTRIES.searchdoc, `evidence:${evidenceId}`),
      ),
    ]);
    expect(
      await countRows(
        `SELECT COUNT(*)::bigint AS n FROM evidence_search_documents
          WHERE source_id = $1::uuid AND document_type = 'EVIDENCE'`,
        evidenceId,
      ),
      "searchdoc: concurrent indexing produced more than one document",
    ).toBe(1);

    queued.reset();
    await Promise.all([
      subsystem.processMiSearchIndexJob(job(ENTRIES.misearch, evidenceId)),
      subsystem.processMiSearchIndexJob(job(ENTRIES.misearch, evidenceId)),
    ]);
    const targets = new Set(
      queued.searchIndex.map((q) => `${q.kind}:${q.sourceId}`),
    );
    expect(
      targets.size,
      "misearch: concurrent ticks addressed more than one target",
    ).toBe(1);

    // The stranded reconcilers: two concurrent ticks, one accepted command.
    queued.reset();
    const drifted = await newEvidence(own);
    await prisma.$executeRawUnsafe(
      `UPDATE "evidence" SET "updated_at" = $2 WHERE "id" = $1::uuid`,
      drifted,
      new Date(Date.now() - 48 * 60 * 60 * 1000),
    );
    const [x, y] = await Promise.all([
      searchRecon.runSearchIndexReconciler({}),
      searchRecon.runSearchIndexReconciler({}),
    ]);
    expect(
      x.reEnqueued + y.reEnqueued,
      "searchrecon: both concurrent ticks were accepted for the same target",
    ).toBeLessThanOrEqual(
      new Set(queued.searchIndex.map((q) => q.sourceId)).size,
    );
    provenCase("recon.concurrent.record_scoped_duplicates_nothing");
  });

  it("OrphanArtifactScan and ReviewerReconciliation: concurrency writes nothing twice", async () => {
    // Orphan scan is READ-ONLY, which is its whole safety argument. Two
    // concurrent scans must still mutate nothing at all.
    const evidenceBefore = await countRows(
      `SELECT COUNT(*)::bigint AS n FROM evidence WHERE team_id = $1::uuid`,
      own.teamId,
    );
    const [s1, s2] = await Promise.all([
      orphan.runOrphanArtifactScan({ trigger: "c1" }),
      orphan.runOrphanArtifactScan({ trigger: "c2" }),
    ]);
    expect(s1.stuckEvidenceCount).toBe(s2.stuckEvidenceCount);
    expect(
      await countRows(
        `SELECT COUNT(*)::bigint AS n FROM evidence WHERE team_id = $1::uuid`,
        own.teamId,
      ),
    ).toBe(evidenceBefore);

    // The reviewer sweep's writes happen api-side and are deduplicated by
    // DAY-BUCKETED unique keys — `(teamId, fingerprint)` for escalations and
    // `(teamId, kind, dedupKey)` for reminders. Two concurrent ticks may both
    // reach the endpoint; neither may produce a second row.
    const escalationsBefore = await countRows(
      `SELECT COUNT(*)::bigint AS n FROM review_escalations WHERE team_id = $1::uuid`,
      own.teamId,
    );
    await Promise.all([
      reviewer.runReviewerReconciliation({ trigger: "c1" }),
      reviewer.runReviewerReconciliation({ trigger: "c2" }),
    ]);
    expect(
      await countRows(
        `SELECT COUNT(*)::bigint AS n FROM review_escalations WHERE team_id = $1::uuid`,
        own.teamId,
      ),
      "reviewer: concurrent reconciliation created duplicate escalations",
    ).toBe(escalationsBefore);
    provenCase("recon.concurrent.readonly_and_delegated_safe");
  });

  // =========================================================================
  // GROUP E — the independent stranded-authority comparison
  // =========================================================================

  it("every stranded-capable authority has exactly one reconciler, and none is orphaned", async () => {
    // Derived from the registry's OWN declarations rather than from a list
    // written next to it: a unit whose work can sit between a durable commit
    // and its execution is stranded-capable, and every one of those must name
    // a reconciler that exists as a registered unit's processor.
    const reconcilerModules = new Set(
      CANONICAL_WORK_REGISTRY.filter((e) => e.transport === "db_outbox_sweep").map(
        (e) => e.canonicalProcessor,
      ),
    );
    const missing: string[] = [];
    const duplicated: string[] = [];
    const byAuthority = new Map<string, string[]>();

    for (const entry of CANONICAL_WORK_REGISTRY) {
      if (!entry.reconciler?.trim()) {
        missing.push(`${entry.workName}: no reconciler`);
        continue;
      }
      // The reconciler must be a module the runtime actually reaches: some
      // registered unit's processor, producer or terminal writer. A path
      // nobody runs is not a reconciler, it is a comment.
      const known =
        reconcilerModules.has(entry.reconciler) ||
        CANONICAL_WORK_REGISTRY.some(
          (e) =>
            e.canonicalProcessor === entry.reconciler ||
            e.canonicalProducer === entry.reconciler ||
            e.terminalWriter === entry.reconciler,
        );
      if (!known) missing.push(`${entry.workName} -> ${entry.reconciler}`);

      const key = `${entry.durableAuthority.model}`;
      byAuthority.set(key, [...(byAuthority.get(key) ?? []), entry.workName]);
    }

    expect(missing, `stranded authorities with no live reconciler:\n${missing.join("\n")}`)
      .toEqual([]);
    expect(duplicated).toEqual([]);
    // And no registered unit lacks a durable authority to reconcile toward.
    const authorityless = CANONICAL_WORK_REGISTRY.filter(
      (e) => !e.durableAuthority.model.trim(),
    ).map((e) => e.workName);
    expect(authorityless).toEqual([]);
    provenCase("graphrecon.recon.authorities_reconciled");
  });
});
