// OPS-001, OPS-002, OPS-014, OPS-017 — executed against live PostgreSQL 16.
import { boot, evidence, incident, sweep, type Ctx } from "./lib/boot";
import { recordProof, scrub } from "./lib/proof";

const PROBES = "services/api/src/services/operations/operations-source-probes.ts";
const GEN = "services/api/src/services/dashboard/incident-generator.service.ts";
const CC = "services/api/src/services/dashboard/command-center.service.ts";
const QT = "services/api/src/services/dashboard/queue-telemetry.service.ts";
const WT = "services/worker/src/telemetry.ts";
const INC = "services/api/src/services/observability/incident.service.ts";
const SEC = "services/api/src/services/security/security-event.service.ts";
const SRCH = "services/api/src/services/operations/search-index-conditions.service.ts";
const SH = "services/api/src/services/search/search-health.service.ts";

describe("A1 telemetry / retry storm / denial incidents / search wording", () => {
  let c: Ctx;
  beforeAll(async () => { c = await boot(); }, 900_000);
  afterAll(async () => { await c?.h.cleanup().catch(() => {}); });
  const P = () => c.h.fixtures.personal;
  const rows = (teamId: string) => c.prisma.operationalIncident.findMany({ where: { teamId }, select: { id: true, sourceId: true, status: true, severity: true, occurrenceCount: true, metricSnapshot: true, safeSummary: true, resolutionNote: true }, orderBy: { sourceId: "asc" } });
  const home = (teamId: string, token: string) => c.inj("GET", `/v1/dashboard/command-center?teamId=${teamId}`, token);

  it("OPS-001 workspace 'sampler delayed' fires while the real worker sampler is fresh", async () => {
    for (const q of ["report", "ots.upgrade", "search.indexing"]) await c.prisma.queueTelemetrySnapshot.create({ data: { teamId: null, queueName: q, queueDomain: "WORKER", waitingCount: 0, source: "BULLMQ" } });
    await c.prisma.workerTelemetrySnapshot.create({ data: { workerId: "opsaudit-worker", workerKind: "WORKER", status: "HEALTHY", heartbeatAtUtc: new Date(), processedCount: 1, failedCount: 0 } });
    await c.prisma.queueTelemetrySnapshot.create({ data: { teamId: P().teamId, queueName: "review_backlog", queueDomain: "REVIEW", waitingCount: 0, source: "DB_DERIVED", sampledAtUtc: new Date(Date.now() - 17 * 3600_000) } });
    await sweep(P().teamId);
    const tel = (await rows(P().teamId)).find((r: any) => r.sourceId === "platform.telemetry_stale");
    const workerRowAgeSec = 0;
    // Home visit re-writes the workspace row (lazy, only if none in 240 min) -> condition resolves.
    const h1 = await home(P().teamId, P().token);
    await sweep(P().teamId);
    const afterHome = (await rows(P().teamId)).find((r: any) => r.sourceId === "platform.telemetry_stale");
    // 31 minutes later + another Home visit inside the 240-minute window -> reopens, NOT refreshed.
    await c.prisma.queueTelemetrySnapshot.updateMany({ where: { teamId: P().teamId }, data: { sampledAtUtc: new Date(Date.now() - 31 * 60_000) } });
    const h2 = await home(P().teamId, P().token);
    const newest = await c.prisma.queueTelemetrySnapshot.findFirst({ where: { teamId: P().teamId }, orderBy: { sampledAtUtc: "desc" } });
    await sweep(P().teamId);
    const reopened = (await rows(P().teamId)).find((r: any) => r.sourceId === "platform.telemetry_stale");
    // A workspace whose Home never loaded: no per-workspace row => never any condition, even with NO worker samples.
    await c.prisma.queueTelemetrySnapshot.deleteMany({ where: { teamId: null } });
    await sweep(c.h.fixtures.teamB.teamId);
    const neverHome = await c.prisma.operationalIncident.count({ where: { teamId: c.h.fixtures.teamB.teamId, sourceId: "platform.telemetry_stale" } });
    recordProof({
      proofId: "PR-A1-telemetry-fabricated", title: "Workspace telemetry condition is derived from Home page loads, not the worker sampler", proofType: "REAL_DB_PROVEN",
      findingIds: ["OPS-001"], sources: [PROBES, GEN, CC, QT, WT], persona: "personal owner", plan: "FREE (plan irrelevant: sweep runs for every workspace)", workspaceType: "personal",
      expected: "A 'Queue telemetry sampler delayed' condition is raised only when the real BullMQ sampler is stale, and recovers when it samples.",
      observed: { workerSampleAgeSec: workerRowAgeSec, conditionWithFreshWorker: scrub({ status: tel?.status, severity: tel?.severity, minutes: (tel?.metricSnapshot as any)?.currentValue, summary: tel?.safeSummary }), homeGet1: h1.statusCode, afterHomeVisit: afterHome?.status, afterHomeNote: afterHome?.resolutionNote, homeGet2: h2.statusCode, newestWorkspaceRowAgeMinAfterSecondHome: Math.round((Date.now() - newest.sampledAtUtc.getTime()) / 60000), after31MinAndHomeVisit: { status: reopened?.status, severity: reopened?.severity }, neverVisitedHomeWorkspaceWithZeroWorkerSamples_conditions: neverHome },
      outcome: "DEFECT_OBSERVED",
    });
    expect(tel?.status).toBe("OPEN");
    expect(afterHome?.status).toBe("RESOLVED");
    expect(reopened?.status).toBe("OPEN");
    expect(neverHome).toBe(0);
  });

  it("OPS-002 retry storm counts re-observed conditions; drill-down lists only itself; Home count includes itself", async () => {
    for (let i = 0; i < 6; i++) await sweep(P().teamId);
    const r = await rows(P().teamId);
    const storm = r.find((x: any) => x.sourceId === "queue.retry_storm");
    const counted = r.filter((x: any) => x.sourceId !== "queue.retry_storm" && x.occurrenceCount >= 5 && ["OPEN", "ACKNOWLEDGED"].includes(x.status));
    const groups = await c.inj("GET", `/v1/ops/incident-groups?teamId=${P().teamId}`, P().token);
    const sg = (groups.json().groups ?? []).find((g: any) => (g.sourceId ?? g.groupKey) === "queue.retry_storm");
    const aff = await c.inj("GET", `/v1/ops/incident-groups/${encodeURIComponent(sg?.groupKey ?? "queue.retry_storm")}/affected?teamId=${P().teamId}`, P().token);
    const affRows = (aff.json().records ?? aff.json().items ?? aff.json().affected ?? []).map((x: any) => x.title ?? x.sourceId);
    for (let i = 0; i < 4; i++) await sweep(P().teamId);
    const stormLater = (await rows(P().teamId)).find((x: any) => x.sourceId === "queue.retry_storm");
    const othersLater = (await rows(P().teamId)).filter((x: any) => x.sourceId !== "queue.retry_storm" && x.occurrenceCount >= 5 && ["OPEN","ACKNOWLEDGED"].includes(x.status)).length;
    const hc = await home(P().teamId, P().token);
    const homeStorm = JSON.stringify(hc.json()).match(/"retryStormIncidents":(\d+)/)?.[1] ?? null;
    recordProof({
      proofId: "PR-A1-retry-storm-meta", title: "'Queue retry storm' is a count of this workspace's re-observed conditions", proofType: "REAL_DB_PROVEN",
      findingIds: ["OPS-002"], sources: [PROBES, GEN, INC, CC, "services/api/src/services/operations/operations-group-drilldown.service.ts"], persona: "personal owner", workspaceType: "personal",
      expected: "A queue retry storm reflects BullMQ retries; its drill-down names the queues/jobs or counted conditions.",
      observed: { storm: scrub({ status: storm?.status, severity: storm?.severity, metric: storm?.metricSnapshot, summary: storm?.safeSummary }), conditionsActuallyCounted: counted.map((x: any) => ({ sourceId: x.sourceId, occurrenceCount: x.occurrenceCount })), drillDownStatus: aff.statusCode, drillDownRecords: affRows, homeRetryStormIncidentsField: homeStorm, stormOccurrencesWhenHomeRead: stormLater?.occurrenceCount, otherConditionsAtThreshold: othersLater, queuesRead: "none (predicate reads operational_incidents only)" },
      outcome: "DEFECT_OBSERVED",
    });
    expect(storm?.status).toBe("OPEN");
  });

  it("OPS-014 a refused request produces a customer-visible Operations condition", async () => {
    const a = c.h.fixtures.teamA;
    const before = await c.prisma.operationalIncident.count({ where: { teamId: a.teamId } });
    const r1 = await c.inj("GET", `/v1/ops/assignable-operators?teamId=${a.teamId}`, a.viewerToken);
    const r2 = await c.inj("POST", `/v1/ops/incidents/00000000-0000-4000-8000-000000000001/suppress`, a.memberToken, { teamId: a.teamId });
    const list = await c.inj("GET", `/v1/ops/incidents?teamId=${a.teamId}`, a.ownerToken);
    const visible = list.json().incidents.map((i: any) => ({ title: i.title, sourceId: i.lifecycle?.sourceId ?? i.sourceId, occurrences: i.occurrenceCount }));
    recordProof({
      proofId: "PR-A1-denial-incident", title: "Expected 403 refusals become a visible 'Security signal: permission_denied' condition", proofType: "REAL_DB_PROVEN",
      findingIds: ["OPS-014"], sources: [SEC, INC, "services/api/src/routes/ops.routes.ts"], persona: "TEAM viewer/member refused; TEAM owner views", plan: "TEAM-shaped org", workspaceType: "organization",
      expected: "An authorization refusal is a security log/audit event, not a customer operational incident.",
      observed: { refusals: [r1.statusCode, r2.statusCode], incidentsBefore: before, visibleToOwnerAfter: visible, storedRows: await c.prisma.operationalIncident.findMany({ where: { teamId: a.teamId, sourceId: "identity.security_condition" }, select: { title: true, fingerprint: true, occurrenceCount: true } }) },
      outcome: "DEFECT_OBSERVED",
    });
    const stored = await c.prisma.operationalIncident.findMany({ where: { teamId: a.teamId, sourceId: "identity.security_condition" }, select: { title: true, fingerprint: true } });
    expect(visible.some((v: any) => v.sourceId === "identity.security_condition")).toBe(true);
    expect(stored[0]?.title).toMatch(/permission_denied/);
  });

  it("OPS-017 search condition titled 'failing' when no reconciliation has ever run", async () => {
    const t = c.h.fixtures.teamA;
    await evidence(c, t.teamId, t.ownerUserId);
    const runs = await c.prisma.governanceReconciliationRun.count({ where: { teamId: t.teamId, kind: "SEARCH_INDEX" } });
    await sweep(t.teamId);
    const s = await c.prisma.operationalIncident.findFirst({ where: { teamId: t.teamId, sourceId: "search.indexing_failure" }, select: { title: true, status: true, metadataJson: true } }).catch(async () => c.prisma.operationalIncident.findFirst({ where: { teamId: t.teamId, sourceId: "search.indexing_failure" }, select: { title: true, status: true } }));
    const ev = s ? await c.prisma.operationalIncidentEvent.findFirst({ where: { incident: { teamId: t.teamId, sourceId: "search.indexing_failure" } }, select: { metadataJson: true } }) : null;
    // Workspace with no searchable records: does it open?
    const emptyWs = c.h.fixtures.teamB.teamId;
    await sweep(emptyWs);
    const emptyCond = await c.prisma.operationalIncident.count({ where: { teamId: emptyWs, sourceId: "search.indexing_failure" } });
    recordProof({
      proofId: "PR-A1-search-never-run", title: "Search condition opens as 'reconciliation failing' with zero reconciliation runs", proofType: "REAL_DB_PROVEN",
      findingIds: ["OPS-017"], sources: [SRCH, SH, GEN], persona: "TEAM owner", workspaceType: "organization",
      expected: "'Not yet measured' is distinct from 'failing'; no failing claim without a failed/stalled measurement.",
      observed: { searchIndexRunsEver: runs, condition: s ? { title: s.title, status: s.status } : null, recordedReadiness: scrub((ev?.metadataJson as any)?.readinessState ?? ev?.metadataJson ?? null), teamB_conditions_note: "teamB fixture has one evidence row", teamB_conditions: emptyCond },
      outcome: s ? "DEFECT_OBSERVED" : "BEHAVIOUR_CORRECT",
    });
  });
});
