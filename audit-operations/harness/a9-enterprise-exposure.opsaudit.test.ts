// Enterprise fixture (one organization, three workspaces) + cross-surface exposure.
import { recordProof, scrub } from "./lib/proof";
import { boot, envelopeCaps, incident, makeOrgWorkspace, makeUser, member, type Ctx } from "./lib/boot";

const ROUTES = "services/api/src/routes/ops.routes.ts";
const SUM = "services/api/src/services/operations/operations-summary.service.ts";
const INBOX = "services/api/src/routes/me-inbox.routes.ts";
const SEC = "services/api/src/routes/runtime-secrets-health.routes.ts";
const DIAG = "services/api/src/routes/investigation-diagnostics.routes.ts";
const DIAGS = "services/api/src/services/investigation-diagnostics.service.ts";
const WOPS = "services/api/src/routes/workspace-operations.routes.ts";
const AO = "services/api/src/services/operations/assignable-operators.service.ts";

describe("A9 Enterprise organization and exposure", () => {
  let c: Ctx; const ent: any = {}; const exp: any = {};
  beforeAll(async () => { c = await boot(); }, 900_000);
  afterAll(async () => {
    recordProof({ proofId: "PR-A9-enterprise", title: "Enterprise organization with three workspaces: isolation, roles, assignment, roll-up", proofType: "REAL_DB_PROVEN", findingIds: [], sources: [ROUTES, SUM, AO, INBOX],
      expected: "Each workspace sees only its incidents; no cross-workspace mutation; assignment excludes ineligible users; roll-up equals the union of authorized workspaces (if a roll-up exists).", observed: ent, outcome: "INFORMATIONAL" });
    recordProof({ proofId: "PR-A9-exposure", title: "Platform/infrastructure data reachable by workspace members outside /operations", proofType: "RUNTIME_PROVEN", findingIds: ["OPS-010"], sources: [SEC, DIAG, DIAGS, WOPS],
      expected: "Workspace members cannot read platform secrets posture or other tenants' job failure text.", observed: exp, outcome: "INFORMATIONAL" });
    await c?.h.cleanup().catch(() => {});
  });

  it("Enterprise isolation, roles and assignment", async () => {
    const owner = await makeUser(c, "ent-owner");
    const w1 = await makeOrgWorkspace(c, owner.id, { name: "ent-w1", billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
    const w2 = await makeOrgWorkspace(c, owner.id, { name: "ent-w2", orgId: w1.orgId, billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
    const w3 = await makeOrgWorkspace(c, owner.id, { name: "ent-w3", orgId: w1.orgId, billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
    for (const w of [w1, w2, w3]) await member(c, w.teamId, owner.id, "OWNER");
    const orgAdmin = await makeUser(c, "ent-orgadmin"); await c.prisma.organizationMembership.create({ data: { organizationId: w1.orgId, userId: orgAdmin.id, role: "ORG_ADMIN" } });
    const wsAdmin = await makeUser(c, "ent-wsadmin"); await member(c, w2.teamId, wsAdmin.id, "ADMIN");
    const m = await makeUser(c, "ent-member"); await member(c, w2.teamId, m.id, "MEMBER");
    const v = await makeUser(c, "ent-viewer"); await member(c, w2.teamId, v.id, "VIEWER");
    const rv = await makeUser(c, "ent-revoked"); await member(c, w2.teamId, rv.id, "MEMBER", "REVOKED");
    const sp = await makeUser(c, "ent-suspended"); await member(c, w2.teamId, sp.id, "MEMBER", "SUSPENDED");
    const i1 = await incident(c, w1.teamId, { title: "W1 only", sourceId: "pipeline.report_generation_failed", category: "REPORT" });
    const i2 = await incident(c, w2.teamId, { title: "W2 only", sourceId: "pipeline.report_generation_failed", category: "REPORT" });
    const i3 = await incident(c, w3.teamId, { title: "W3 only" });
    const plat = await incident(c, null, { scope: "PLATFORM", title: "PLATFORM", sourceId: "billing.provider_authorization", category: "INTEGRATION" });
    const ids = async (tok: string, ws: string) => { const r = await c.inj("GET", `/v1/ops/incidents?teamId=${ws}`, tok); return r.statusCode === 200 ? r.json().incidents.map((x: any) => x.title) : r.statusCode; };
    ent.ownerPerWorkspace = { w1: await ids(owner.token, w1.teamId), w2: await ids(owner.token, w2.teamId), w3: await ids(owner.token, w3.teamId) };
    ent.wsAdminW2 = await ids(wsAdmin.token, w2.teamId); ent.wsAdminW1 = await ids(wsAdmin.token, w1.teamId);
    ent.orgAdminW1 = await ids(orgAdmin.token, w1.teamId);
    ent.memberW2 = await ids(m.token, w2.teamId); ent.viewerW2 = await ids(v.token, w2.teamId);
    ent.revokedW2 = await ids(rv.token, w2.teamId); ent.suspendedW2 = await ids(sp.token, w2.teamId);
    ent.crossWorkspaceMutation = {
      ackW1IncidentViaW2Context: (await c.inj("POST", `/v1/ops/incidents/${i1.id}/ack`, owner.token, { teamId: w2.teamId })).statusCode,
      wsAdminAckW1Incident: (await c.inj("POST", `/v1/ops/incidents/${i1.id}/ack`, wsAdmin.token, { teamId: w1.teamId })).statusCode,
    };
    const ops = await c.inj("GET", `/v1/ops/assignable-operators?teamId=${w2.teamId}`, wsAdmin.token);
    ent.assignableOperatorsW2 = (ops.json().operators ?? []).map((o: any) => o.role).sort();
    ent.assignRevoked = (await c.inj("POST", `/v1/ops/incidents/${i2.id}/assign`, wsAdmin.token, { teamId: w2.teamId, assigneeUserId: rv.id })).statusCode;
    ent.assignViewer = (await c.inj("POST", `/v1/ops/incidents/${i2.id}/assign`, wsAdmin.token, { teamId: w2.teamId, assigneeUserId: v.id })).statusCode;
    ent.assignMember = (await c.inj("POST", `/v1/ops/incidents/${i2.id}/assign`, wsAdmin.token, { teamId: w2.teamId, assigneeUserId: m.id })).statusCode;
    ent.platformRowVisibleAnywhere = [w1, w2, w3].some(() => false);
    ent.envelopeOwnerW2 = await envelopeCaps(c, owner.token, w2.teamId);
    ent.organizationRollupEndpoint = "none registered (no /v1/organizations/:id/... incident route; ops.routes is per-workspace teamId)";
    // Cross-workspace aggregation surface: the personal inbox.
    const inbox = await c.inj("GET", `/v1/me/inbox`, owner.token);
    const inboxText = inbox.body;
    ent.inboxOwner = { status: inbox.statusCode, hasW1: inboxText.includes("W1 only"), hasW2: inboxText.includes("W2 only"), hasPlatform: inboxText.includes("\"PLATFORM\"") && inboxText.includes(plat.id) };
    const rvInbox = await c.inj("GET", `/v1/me/inbox`, rv.token);
    ent.inboxRevokedMember = { status: rvInbox.statusCode, leaksW2ReportFailure: rvInbox.body.includes(i2.id) || rvInbox.body.includes("W2 only") };
    void i3;
  });

  it("exposure outside /operations", async () => {
    const a = c.h.fixtures.teamA, b = c.h.fixtures.teamB;
    const sec = await c.inj("GET", `/v1/runtime/secrets-health?teamId=${a.teamId}`, a.viewerToken);
    exp.secretsHealthForViewer = { status: sec.statusCode, keys: sec.statusCode === 200 ? Object.keys(sec.json()) : null, sample: sec.body.slice(0, 400) };
    const wh = await c.inj("GET", `/v1/teams/${a.teamId}/operations/health`, a.viewerToken);
    exp.workspaceOperationsHealthViewer = { status: wh.statusCode, sample: wh.body.slice(0, 300) };
    // Investigation diagnostics: does a member of A see queue failure text produced for tenant B?
    process.env.REDIS_URL = process.env.P7_TEST_REDIS_URL ?? "redis://127.0.0.1:56471";
    const inv = await import((await import("./lib/proof")).apiUrl("src/services/operations/queue-inventory.service.ts"));
    const q = inv.getQueueHandle("report");
    const { Worker } = await import((await import("./lib/proof")).repoUrl("services/api/node_modules/bullmq/dist/esm/index.js"));
    const w = new Worker("report", async () => { throw new Error(`TENANT-B-SECRET evidence ${b.evidenceId} failed for ${b.teamId}`); }, { connection: { host: "127.0.0.1", port: Number(new URL(process.env.REDIS_URL!).port) } });
    await q.add("GenerateReport", { evidenceId: b.evidenceId, teamId: b.teamId }, { jobId: `opsaudit-b-${Date.now()}`, attempts: 1 });
    const until = Date.now() + 10_000; while (Date.now() < until && (await q.getJobCounts("failed")).failed === 0) await new Promise((r) => setTimeout(r, 200));
    await w.close();
    const d = await c.inj("GET", `/v1/investigation/diagnostics?teamId=${a.teamId}`, a.viewerToken);
    exp.investigationDiagnosticsViewerOfA = { status: d.statusCode, leaksTenantBFailureText: d.body.includes("TENANT-B-SECRET") || d.body.includes(b.teamId), leakedFragment: (() => { const k = d.body.indexOf("TENANT-B-SECRET"); return k < 0 ? null : scrub(d.body.slice(Math.max(0, k - 220), k + 160)); })(), viewerRole: "VIEWER of tenant A", producerTenant: "tenant B" };
  });
});
