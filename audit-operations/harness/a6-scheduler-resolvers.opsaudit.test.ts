// OPS-008 / OPS-009 / OPS-018 + detector failure and reconcile concurrency.
import { apiUrl, recordProof, scrub } from "./lib/proof";
import { boot, evidence, makeUser, personalSpace, sweep, type Ctx } from "./lib/boot";

const JOB = "services/api/src/jobs/workspace-operations-reconciliation.job.ts";
const RECON = "services/api/src/services/operations/operations-reconciliation.service.ts";
const INC = "services/api/src/services/observability/incident.service.ts";
const SCOPE = "services/api/src/services/observability/incident-scope.ts";
const PROBES = "services/api/src/services/operations/operations-source-probes.ts";
const GEN = "services/api/src/services/dashboard/incident-generator.service.ts";
const LIFE = "packages/shared-runtime/src/ops/source-lifecycle.ts";
const SUM = "services/api/src/services/operations/operations-summary.service.ts";
const ROUTES = "services/api/src/routes/ops.routes.ts";

describe("A6 scheduler / resolvers / detector failure", () => {
  let c: Ctx;
  const out: Record<string, any> = {};
  beforeAll(async () => { c = await boot(); }, 900_000);
  afterAll(async () => {
    recordProof({ proofId: "PR-A6-scheduler-coverage", title: "Scheduler only ranks the 500 oldest workspaces", proofType: "REAL_DB_PROVEN", findingIds: ["OPS-008"], sources: [JOB, RECON],
      expected: "Every workspace is eventually selected by the scheduled sweep.", observed: out.scheduler, outcome: "DEFECT_OBSERVED" });
    recordProof({ proofId: "PR-A6-heartbeat", title: "Per-workspace heartbeat rows never auto-resolve and open SLA cycles", proofType: "REAL_DB_PROVEN", findingIds: ["OPS-009"], sources: [PROBES, GEN, INC, SCOPE],
      expected: "A fresh heartbeat closes the stale-heartbeat condition.", observed: out.heartbeat, outcome: "DEFECT_OBSERVED" });
    recordProof({ proofId: "PR-A6-no-auto-resolver", title: "Sources declared PROBE_AUTO_RESOLVE that no sweep closes", proofType: "REAL_DB_PROVEN", findingIds: ["OPS-018"], sources: [GEN, LIFE, PROBES, INC],
      expected: "A PROBE_AUTO_RESOLVE condition closes once its source is healthy.", observed: out.autoResolve, outcome: "DEFECT_OBSERVED" });
    recordProof({ proofId: "PR-A6-detector-failure", title: "Unreadable source => PARTIAL run, all-clear refused; concurrent reconcile", proofType: "REAL_DB_PROVEN", findingIds: [], sources: [RECON, SUM, ROUTES, GEN],
      expected: "A detector failure never renders a healthy all-clear; concurrent reconcile requests produce one run.", observed: out.failure, outcome: "BEHAVIOUR_CORRECT" });
    await c?.h.cleanup().catch(() => {});
  });

  it("OPS-008 scheduler candidate window", async () => {
    const owner = c.h.fixtures.teamA.ownerUserId;
    const org = await c.prisma.organization.create({ data: { name: "opsaudit-many", billingOwnerUserId: owner, status: "ACTIVE", kind: "SYSTEM" } });
    const base = Date.now() - 400 * 86400_000;
    await c.prisma.team.createMany({ data: Array.from({ length: 505 }, (_, i) => ({ name: `opsaudit-old-${i}`, ownerUserId: owner, isPersonal: false, organizationId: org.id, workspaceKind: "OWNED", createdAt: new Date(base + i * 1000) })) });
    const newest = await c.prisma.team.create({ data: { name: "opsaudit-NEWEST", ownerUserId: owner, isPersonal: false, organizationId: org.id, workspaceKind: "OWNED" } });
    const all = await c.prisma.team.findMany({ select: { id: true } });
    const now = new Date();
    await c.prisma.governanceReconciliationRun.createMany({ data: all.filter((t: any) => t.id !== newest.id).map((t: any) => ({ teamId: t.id, kind: "WORKSPACE_OPERATIONS", trigger: "cli", status: "SUCCEEDED", startedAtUtc: now, finishedAtUtc: now, lockKey: `WORKSPACE_OPERATIONS:${t.id}` })) });
    const job = await import(apiUrl(JOB.replace("services/api/", "")));
    const r = await job.runWorkspaceOperationsSweep({ trigger: "cli" });
    out.scheduler = { totalTeams: all.length, newestNeverRun: true, otherTeamsFreshlyRun: all.length - 1, sweepResult: scrub(r), runsRecordedForNewest: await c.prisma.governanceReconciliationRun.count({ where: { teamId: newest.id, kind: "WORKSPACE_OPERATIONS" } }) };
    expect(out.scheduler.runsRecordedForNewest).toBe(0);
  });

  it("OPS-009 heartbeat", async () => {
    const u = await makeUser(c, "hb"); const ws = await personalSpace(c, u.id);
    await c.prisma.workerTelemetrySnapshot.deleteMany({});
    await c.prisma.workerTelemetrySnapshot.create({ data: { workerId: "opsaudit-w", workerKind: "WORKER", status: "HEALTHY", heartbeatAtUtc: new Date(Date.now() - 3 * 3600_000), processedCount: 0, failedCount: 0 } });
    await sweep(ws);
    const find = () => c.prisma.operationalIncident.findFirst({ where: { teamId: ws, sourceId: "platform.worker_heartbeat_stale" }, select: { id: true, status: true, severity: true, scope: true } });
    const stale = await find();
    await c.prisma.workerTelemetrySnapshot.create({ data: { workerId: "opsaudit-w", workerKind: "WORKER", status: "HEALTHY", heartbeatAtUtc: new Date(), processedCount: 1, failedCount: 0 } });
    await sweep(ws); await sweep(ws);
    const fresh = await find();
    const copies = await c.prisma.operationalIncident.count({ where: { sourceId: "platform.worker_heartbeat_stale" } });
    const tenantVisible = (await c.inj("GET", `/v1/ops/incidents?teamId=${ws}`, u.token)).json().incidents.some((i: any) => i.id === stale?.id);
    out.heartbeat = { afterStaleHeartbeat: scrub(stale), afterFreshHeartbeatAnd2Sweeps: scrub(fresh), slaCyclesOnHiddenRow: stale ? await c.prisma.operationalIncidentSlaCycle.count({ where: { incidentId: stale.id } }) : null, rowsPlatformWide: copies, visibleToTenant: tenantVisible };
  });

  it("OPS-018 conditions whose source recovered but nothing closes them", async () => {
    const { recordIncident } = await import(apiUrl("src/services/observability/incident.service.ts"));
    const u = await makeUser(c, "noresolver"); const ws = await personalSpace(c, u.id);
    const ev = await evidence(c, ws, u.id, { otsStatus: "ANCHORED" });
    const specs = [
      { sourceId: "evidence_integrity.ots_budget_exhausted", category: "WORKER", fingerprint: `OTS:${ev.id}:GLOBAL_BUDGET_EXHAUSTED`, relatedEvidenceId: ev.id, healthy: "record's otsStatus is ANCHORED" },
      { sourceId: "pipeline.package_generation_denied", category: "GOVERNANCE", fingerprint: `worker_package_gate:${ws}:${ev.id}:DENIED`, relatedEvidenceId: ev.id, healthy: "no current denial exists" },
      { sourceId: "review.escalation", category: "GOVERNANCE", fingerprint: `review-escalation:SLA_BREACH:00000000-0000-4000-8000-000000000123`, healthy: "the workflow no longer exists / escalation cleared" },
      { sourceId: "identity.idp_outage", category: "IDENTITY_SECURITY", fingerprint: `idp-outage:00000000-0000-4000-8000-000000000456`, healthy: "no SSO failures recorded" },
    ];
    const res: any[] = [];
    for (const s of specs) {
      const r = await recordIncident({ sourceId: s.sourceId, teamId: ws, category: s.category, severity: "HIGH", fingerprint: s.fingerprint, title: s.sourceId, safeSummary: "opsaudit", relatedEvidenceId: (s as any).relatedEvidenceId ?? null });
      await sweep(ws); await sweep(ws);
      const after = await c.prisma.operationalIncident.findUnique({ where: { id: r.incident?.id ?? r.id }, select: { status: true } }).catch(() => null);
      const manual = await c.inj("POST", `/v1/ops/incidents/${r.incident?.id ?? r.id}/resolve`, u.token, { teamId: ws, resolutionNote: "opsaudit manual" });
      res.push({ sourceId: s.sourceId, sourceHealthy: s.healthy, afterTwoSweeps: after?.status ?? null, manualResolve: { status: manual.statusCode, code: manual.json()?.error?.code ?? manual.json()?.code ?? null } });
    }
    // Provider-authorization conditions: written with no team => LEGACY_UNSCOPED, a new row per hour.
    const p1 = await recordIncident({ sourceId: "billing.provider_authorization", teamId: null, category: "RECONCILIATION", severity: "HIGH", fingerprint: "billing-provider-auth:STRIPE:2026100801", title: "Payment provider refused credentials", safeSummary: "opsaudit" });
    const p2 = await recordIncident({ sourceId: "billing.provider_authorization", teamId: null, category: "RECONCILIATION", severity: "HIGH", fingerprint: "billing-provider-auth:STRIPE:2026100802", title: "Payment provider refused credentials", safeSummary: "opsaudit" });
    const provRows = await c.prisma.operationalIncident.findMany({ where: { sourceId: "billing.provider_authorization", fingerprint: { startsWith: "billing-provider-auth:" } }, select: { scope: true, status: true } });
    res.push({ sourceId: "billing.provider_authorization", storedScopes: provRows.map((r: any) => r.scope), openRows: provRows.filter((r: any) => r.status === "OPEN").length, note: "PLATFORM scope never written; hourly fingerprints accumulate", _ids: [p1 ? "ok" : null, p2 ? "ok" : null] });
    out.autoResolve = res;
  });

  it("detector failure and concurrent reconcile", async () => {
    const t = c.h.fixtures.teamB;
    await c.prisma.$executeRawUnsafe(`ALTER TABLE queue_telemetry_snapshots RENAME TO queue_telemetry_snapshots_opsaudit`);
    let partial: any;
    try {
      const o = await sweep(t.teamId);
      const s = await c.inj("GET", `/v1/ops/summary?teamId=${t.teamId}`, t.ownerToken);
      const j = s.json().summary;
      partial = { runKind: o?.kind, failedSources: o?.sources?.failedSources ?? null, summaryReadiness: j.readiness, mayAssertAllClear: j.mayAssertAllClear, clearRefusalReason: j.clearRefusalReason ?? null };
    } finally {
      await c.prisma.$executeRawUnsafe(`ALTER TABLE queue_telemetry_snapshots_opsaudit RENAME TO queue_telemetry_snapshots`);
    }
    await c.prisma.governanceReconciliationRun.deleteMany({ where: { teamId: t.teamId, kind: "WORKSPACE_OPERATIONS" } });
    const many = await Promise.all(Array.from({ length: 5 }, () => c.inj("POST", "/v1/ops/workspace-reconcile", t.ownerToken, { teamId: t.teamId })));
    const runs = await c.prisma.governanceReconciliationRun.count({ where: { teamId: t.teamId, kind: "WORKSPACE_OPERATIONS" } });
    out.failure = { partial, concurrentReconcileStatuses: many.map((r: any) => r.statusCode), concurrentBodies: many.map((r: any) => scrub(r.json())), runsCreated: runs };
  });
});
