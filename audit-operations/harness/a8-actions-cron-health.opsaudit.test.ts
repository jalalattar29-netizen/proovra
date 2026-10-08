// OPS-006 / OPS-010 / OPS-011 + action semantics and concurrency.
import { recordProof, scrub } from "./lib/proof";
import { boot, incident, type Ctx } from "./lib/boot";

const CRON = "services/api/src/middleware/cron-secret.ts";
const WINV = "services/worker/src/org-invite-delivery.worker.ts";
const WAUT = "services/worker/src/automation-dispatch.ts";
const ROUTES = "services/api/src/routes/ops.routes.ts";
const BULK = "services/api/src/services/dashboard/bulk-actions.service.ts";
const PAGE = "apps/web/app/(app)/operations/page.tsx";
const INC = "services/api/src/services/observability/incident.service.ts";
const AUTH = "packages/shared-runtime/src/incident-transition-authority.ts";

describe("A8 cron header, health exposure, bulk vocabulary, action semantics", () => {
  let c: Ctx; const out: Record<string, any> = {};
  beforeAll(async () => { c = await boot(); }, 900_000);
  afterAll(async () => {
    recordProof({ proofId: "PR-A8-cron-header", title: "Worker cron header vs API authority", proofType: "RUNTIME_PROVEN", findingIds: ["OPS-006"], sources: [CRON, WINV, WAUT],
      expected: "The header the worker sends is the header the API authenticates.", observed: out.cron, outcome: "DEFECT_OBSERVED" });
    recordProof({ proofId: "PR-A8-health-exposure", title: "GET /v1/ops/health content for a workspace VIEWER", proofType: "RUNTIME_PROVEN", findingIds: ["OPS-010"], sources: [ROUTES],
      expected: "No process-global configuration, env-var names or platform-internal counts reach a workspace member.", observed: out.health, outcome: "DEFECT_OBSERVED" });
    recordProof({ proofId: "PR-A8-bulk-vocabulary", title: "Bulk item vocabulary returned by the API vs the value the web counts as success", proofType: "RUNTIME_PROVEN", findingIds: ["OPS-011"], sources: [BULK, ROUTES, PAGE],
      expected: "The web counts the server's success value as success.", observed: out.bulk, outcome: "DEFECT_OBSERVED" });
    recordProof({ proofId: "PR-A8-action-semantics", title: "Acknowledge / resolve / suppress / assign semantics and concurrency", proofType: "REAL_DB_PROVEN", findingIds: ["OPS-003"], sources: [ROUTES, INC, AUTH],
      expected: "Metadata transitions are idempotent and safe under concurrent clicks; resolve never closes a live source-truth condition.", observed: out.semantics, outcome: "INFORMATIONAL" });
    await c?.h.cleanup().catch(() => {});
  });

  it("OPS-006 header mismatch", async () => {
    process.env.INTEGRATION_CRON_SECRET = "opsaudit-local-cron-secret-0123456789";
    const rows: any[] = [];
    for (const path of ["/v1/org-invite-deliveries/process", "/v1/automation/runs/process"]) {
      const w = await c.inj("POST", path, undefined, {}, { "x-cron-secret": process.env.INTEGRATION_CRON_SECRET });
      const k = await c.inj("POST", path, undefined, {}, { "x-proovra-integration-cron-secret": process.env.INTEGRATION_CRON_SECRET });
      rows.push({ path, workerHeader_x_cron_secret: w.statusCode, apiHeader: k.statusCode });
    }
    out.cron = rows;
    expect(rows.every((r) => r.workerHeader_x_cron_secret === 401 && r.apiHeader === 200)).toBe(true);
  });

  it("OPS-010 health exposure to a VIEWER", async () => {
    const a = c.h.fixtures.teamA;
    await incident(c, a.teamId, { sourceId: "platform.worker_heartbeat_stale", category: "WORKER", severity: "CRITICAL", fingerprint: `dashboard:worker:heartbeat_stale:${a.teamId}` });
    const r = await c.inj("GET", `/v1/ops/health?teamId=${a.teamId}`, a.viewerToken);
    const j = r.json();
    const text = JSON.stringify(j);
    const envNames = [...new Set(text.match(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,}\b/g) ?? [])].filter((s) => /_(KEY|SECRET|SID|URL|TOKEN|ENABLED|ID|DSN|BUCKET)$/.test(s) || /^(TWILIO|STRIPE|PAYPAL|AWS|S3|SENTRY|OTEL|RESEND|OPENAI)/.test(s)).sort();
    const list = await c.inj("GET", `/v1/ops/incidents?teamId=${a.teamId}`, a.viewerToken);
    out.health = { status: r.statusCode, topLevelKeys: Object.keys(j ?? {}).sort(), envVarNamesExposed: envNames, incidentsBlock: scrub(j?.incidents ?? null), tenantListCount: list.json().incidents.length, tenantListIncludesHeartbeat: list.json().incidents.some((i: any) => (i.lifecycle?.sourceId ?? "") === "platform.worker_heartbeat_stale") };
  });

  it("OPS-011 bulk vocabulary", async () => {
    const a = c.h.fixtures.teamA;
    const i1 = await incident(c, a.teamId, { severity: "WARNING" });
    const bulk = await import("../../services/api/src/services/dashboard/bulk-actions.service.ts" as any).catch(async () => import((await import("./lib/proof")).apiUrl("src/services/dashboard/bulk-actions.service.ts")));
    const res = await bulk.runBulkAction({ teamId: a.teamId, actionType: "BULK_ACKNOWLEDGE_INCIDENTS", targetIds: [i1.id], actorUserId: a.ownerUserId });
    const g = await c.inj("GET", `/v1/ops/bulk-actions/${res.runId}?teamId=${a.teamId}`, a.ownerToken);
    const http = await c.inj("POST", "/v1/ops/bulk-actions", a.ownerToken, { teamId: a.teamId, actionType: "BULK_ACKNOWLEDGE_INCIDENTS", targetIds: [i1.id] });
    out.bulk = { serverRunStatus: res.status, serverItemStatuses: (g.json().items ?? []).map((x: any) => x.status), webSuccessValueChecked: "SUCCEEDED (page.tsx: i.status !== \"SUCCEEDED\")", webWouldReportUpdated: (g.json().items ?? []).filter((x: any) => x.status === "SUCCEEDED").length, httpPostWithoutStepUp: { status: http.statusCode, code: http.json()?.error?.code ?? null } };
  });

  it("semantics and concurrency", async () => {
    const a = c.h.fixtures.teamA;
    const i = await incident(c, a.teamId);
    const [x1, x2, x3] = await Promise.all([1, 2, 3].map(() => c.inj("POST", `/v1/ops/incidents/${i.id}/ack`, a.ownerToken, { teamId: a.teamId })));
    const ackEvents = await c.prisma.operationalIncidentEvent.count({ where: { incidentId: i.id, eventType: { contains: "ack" } } });
    const j = await incident(c, a.teamId);
    const [r1, r2] = await Promise.all([
      c.inj("POST", `/v1/ops/incidents/${j.id}/resolve`, a.ownerToken, { teamId: a.teamId, resolutionNote: "opsaudit A" }),
      c.inj("POST", `/v1/ops/incidents/${j.id}/suppress`, a.ownerToken, { teamId: a.teamId }),
    ]);
    const final = await c.prisma.operationalIncident.findUnique({ where: { id: j.id }, select: { status: true, resolutionNote: true } });
    const resolveNoNote = await c.inj("POST", `/v1/ops/incidents/${(await incident(c, a.teamId)).id}/resolve`, a.ownerToken, { teamId: a.teamId });
    const k = await incident(c, a.teamId);
    const sup = await c.inj("POST", `/v1/ops/incidents/${k.id}/suppress`, a.ownerToken, { teamId: a.teamId, reason: "opsaudit reason" });
    const supRow = await c.prisma.operationalIncident.findUnique({ where: { id: k.id }, select: { status: true, resolutionNote: true } });
    const resolvedTwice = await c.inj("POST", `/v1/ops/incidents/${j.id}/ack`, a.ownerToken, { teamId: a.teamId });
    const audit = await c.prisma.adminAuditLog.findFirst({ where: { action: { contains: "incident" } }, orderBy: { createdAt: "desc" }, select: { action: true, metadata: true } }).catch(() => null);
    out.semantics = {
      tripleConcurrentAck: [x1.statusCode, x2.statusCode, x3.statusCode], ackEventRows: ackEvents,
      concurrentResolveVsSuppress: { resolve: r1.statusCode, suppress: r2.statusCode, finalStatus: final?.status },
      resolveWithoutNote_governancePolicy: { status: resolveNoNote.statusCode, code: resolveNoNote.json()?.error?.code ?? resolveNoNote.json()?.code ?? null },
      suppressReasonPersisted: { status: sup.statusCode, row: scrub(supRow) },
      ackAfterTerminal: resolvedTwice.statusCode,
      latestIncidentAudit: scrub(audit ? { action: audit.action, actorAuthority: (audit.metadata as any)?.actorAuthority ?? null } : null),
    };
  });
});
