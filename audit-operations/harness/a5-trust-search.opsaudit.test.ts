// OPS-019 / OPS-017 — TSA / OTS / search condition resolution truth.
import { recordProof, repoUrl, scrub } from "./lib/proof";
import { boot, evidence, incident, makeOrgWorkspace, makeUser, member, sweep, type Ctx } from "./lib/boot";

const INT = "services/api/src/services/operations/evidence-integrity-conditions.service.ts";
const REGY = "services/api/src/services/operations/operations-source-registry.ts";
const LIFE = "packages/shared-runtime/src/ops/source-lifecycle.ts";
const SRCH = "services/api/src/services/operations/search-index-conditions.service.ts";
const SH = "services/api/src/services/search/search-health.service.ts";
const SR = "packages/shared/src/search-readiness.ts";

describe("A5 trust and search conditions", () => {
  let c: Ctx;
  const trust: any[] = []; const search: any[] = [];
  beforeAll(async () => { c = await boot(); }, 900_000);
  afterAll(async () => {
    recordProof({ proofId: "PR-A5-trust", title: "TSA/OTS conditions resolve on any non-FAILED status", proofType: "REAL_DB_PROVEN", findingIds: ["OPS-019"], sources: [INT, REGY, LIFE],
      expected: "A TSA condition closes only on a validated stamp; an OTS condition closes only on ANCHORED/UPGRADED (registry text); PENDING is never 'recovered'.", observed: trust, outcome: "DEFECT_OBSERVED" });
    recordProof({ proofId: "PR-A5-search", title: "Search readiness states and the condition they open/close", proofType: "RUNTIME_PROVEN", findingIds: ["OPS-017"], sources: [SRCH, SH, SR],
      expected: "'Not measured yet' is distinct from 'failing'; healthy closes; indeterminate neither opens nor closes.", observed: search, outcome: "INFORMATIONAL" });
    await c?.h.cleanup().catch(() => {});
  });
  const T = () => c.h.fixtures.teamA;

  it("TSA and OTS: each target status after a FAILED condition", async () => {
    const cases: Array<{ kind: "tsa" | "ots"; to: Record<string, unknown>; label: string }> = [
      { kind: "tsa", label: "TSA -> NULL (no stamp at all)", to: { tsaStatus: null } },
      { kind: "tsa", label: "TSA -> PENDING", to: { tsaStatus: "PENDING" } },
      { kind: "tsa", label: "TSA -> STAMPED without validation", to: { tsaStatus: "STAMPED", tsaValidatedAtUtc: null } },
      { kind: "tsa", label: "TSA -> STAMPED and validated", to: { tsaStatus: "STAMPED", tsaValidatedAtUtc: new Date() } },
      { kind: "ots", label: "OTS -> PENDING (proof submitted, not anchored)", to: { otsStatus: "PENDING" } },
      { kind: "ots", label: "OTS -> NULL", to: { otsStatus: null } },
      { kind: "ots", label: "OTS -> ANCHORED", to: { otsStatus: "ANCHORED", otsAnchoredAtUtc: new Date() } },
    ];
    for (const k of cases) {
      const ev = await evidence(c, T().teamId, T().ownerUserId, k.kind === "tsa" ? { tsaStatus: "FAILED", tsaFailureReason: "opsaudit" } : { otsStatus: "FAILED", otsFailureReason: "opsaudit" });
      await sweep(T().teamId);
      const fp = `${k.kind === "tsa" ? "tsa_failure" : "ots_failure"}:${ev.id}`;
      const opened = await c.prisma.operationalIncident.findFirst({ where: { teamId: T().teamId, fingerprint: fp }, select: { id: true, status: true } });
      await c.prisma.evidence.update({ where: { id: ev.id }, data: k.to as any });
      await sweep(T().teamId);
      const after = opened ? await c.prisma.operationalIncident.findUnique({ where: { id: opened.id }, select: { status: true, resolutionNote: true } }) : null;
      const histOpened = opened ? await c.prisma.operationalIncidentEvent.count({ where: { incidentId: opened.id, eventType: "opened" } }) : null;
      trust.push({ case: k.label, openedOnFailed: opened?.status ?? null, afterTransition: after?.status ?? null, note: after?.resolutionNote ?? null, originalFailurePreservedInHistory: histOpened === 1 });
    }
  });

  it("search: canonical classifier state table + DB open/close", async () => {
    const sr = await import(repoUrl("packages/shared/dist/search-readiness.js")).catch(async () => import(repoUrl("packages/shared/dist/index.js")));
    const now = new Date();
    const base = { unresolvedRemovals: 0, lastIndexedAtUtc: null, scheduledWork: false, authorized: true, serviceReachable: true, now };
    const states = [
      ["no evidence, never run", { eligibleCount: 0, indexedCount: 0, run: null }],
      ["evidence outstanding, never run, nothing scheduled", { eligibleCount: 3, indexedCount: 0, run: null }],
      ["evidence outstanding, never run, work scheduled", { eligibleCount: 3, indexedCount: 0, run: null, scheduledWork: true }],
      ["run RUNNING with live lease (delayed)", { eligibleCount: 3, indexedCount: 1, run: { status: "RUNNING", leaseValid: true, failureCategory: null } }],
      ["run RUNNING with expired lease", { eligibleCount: 3, indexedCount: 1, run: { status: "RUNNING", leaseValid: false, failureCategory: null } }],
      ["run FAILED", { eligibleCount: 3, indexedCount: 1, run: { status: "FAILED", leaseValid: false, failureCategory: "SCAN" } }],
      ["run PARTIAL", { eligibleCount: 3, indexedCount: 2, run: { status: "PARTIAL", leaseValid: false, failureCategory: null } }],
      ["run SUCCEEDED, converged", { eligibleCount: 3, indexedCount: 3, run: { status: "SUCCEEDED", leaseValid: false, failureCategory: null } }],
      ["converged but search service unreachable", { eligibleCount: 3, indexedCount: 3, run: { status: "SUCCEEDED", leaseValid: false, failureCategory: null }, serviceReachable: false }],
    ] as const;
    const SH_mod = await import(repoUrl("services/api/src/services/search/search-health.service.ts"));
    for (const [label, s] of states) {
      const r = sr.deriveSearchReadiness({ ...base, ...(s as any) });
      search.push({ case: label, state: r.state, verdict: SH_mod.classifySearchReadiness(r.state), conditionTitleIfFailing: "Search index reconciliation failing" });
    }
    // DB: FAILED run opens; empty workspace (EMPTY_WORKSPACE) closes; RUNNING lease leaves it alone.
    const ws = c.h.fixtures.teamB.teamId;
    await c.prisma.governanceReconciliationRun.create({ data: { teamId: ws, kind: "SEARCH_INDEX", trigger: "scheduler", status: "FAILED", startedAtUtc: new Date(Date.now() - 60_000), finishedAtUtc: new Date(), lockKey: `SEARCH_INDEX:${ws}`, errorSummary: "opsaudit" } });
    await sweep(ws);
    const opened = await c.prisma.operationalIncident.findFirst({ where: { teamId: ws, sourceId: "search.indexing_failure" }, select: { id: true, status: true } });
    await c.prisma.evidence.updateMany({ where: { teamId: ws }, data: { deletedAt: new Date() } as any });
    await c.prisma.governanceReconciliationRun.create({ data: { teamId: ws, kind: "SEARCH_INDEX", trigger: "scheduler", status: "SUCCEEDED", startedAtUtc: new Date(), finishedAtUtc: new Date(), lockKey: `SEARCH_INDEX:${ws}` } });
    await sweep(ws);
    const after = opened ? await c.prisma.operationalIncident.findUnique({ where: { id: opened.id }, select: { status: true, resolutionNote: true } }) : null;
    search.push({ case: "DB: FAILED run -> condition", got: opened?.status ?? null });
    const facts = await SH_mod.resolveWorkspaceSearchReadiness({ teamId: ws });
    const eo = await makeUser(c, "search-empty");
    const empty = await makeOrgWorkspace(c, eo.id, { name: "search-empty", kind: "OWNED", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    await member(c, empty.teamId, eo.id, "OWNER");
    const stale = await incident(c, empty.teamId, { sourceId: "search.indexing_failure", category: "RECONCILIATION", severity: "WARNING", fingerprint: `search:index_reconciliation:${empty.teamId}`, title: "Search index reconciliation failing" });
    await sweep(empty.teamId);
    search.push({ case: "DB: condition on a workspace whose index is provably complete (EMPTY_WORKSPACE) -> sweep", got: scrub(await c.prisma.operationalIncident.findUnique({ where: { id: stale.id }, select: { status: true, resolutionNote: true } })) });
    search.push({ case: "DB: soft-deleted record + SUCCEEDED run (record still counted eligible) -> condition", got: scrub(after), readinessAfter: scrub({ state: facts.state, eligibleCount: facts.eligibleCount, indexedCount: facts.indexedCount, outstandingCount: facts.outstandingCount, runStatus: facts.runStatus }) });
  });
});
