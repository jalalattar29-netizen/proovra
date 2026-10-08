// OPS-004 / OPS-013 / OPS-015 / OPS-016 — report & package condition truth.
import { apiUrl, recordProof, repoUrl, scrub } from "./lib/proof";
import { boot, evidence, incident, makeUser, personalSpace, sweep, type Ctx } from "./lib/boot";

const PROBES = "services/api/src/services/operations/operations-source-probes.ts";
const STR = "services/api/src/services/operations/source-truth-recovery.service.ts";
const REG = "services/api/src/services/operations/remediation-registry.ts";
const ROUTES = "services/api/src/routes/ops.routes.ts";
const EMIT = "services/worker/src/governance/incident-emitter.ts";
const PROC = "services/worker/src/processor.ts";
const SCOPE = "services/api/src/services/observability/incident-scope.ts";
const JOB = "services/api/src/jobs/workspace-operations-reconciliation.job.ts";

describe("A4b canonical recovery on an entitled (TEAM) workspace", () => {
  let c: Ctx;
  let obs: any = {};
  beforeAll(async () => { c = await boot(); }, 900_000);
  afterAll(async () => {
    recordProof({ proofId: "PR-A4b-recovery-entitled", title: "Operations remediation routes into requestOutputRecovery; supersede gate on an entitled workspace", proofType: "REAL_DB_PROVEN",
      findingIds: ["OPS-013"], sources: [REG, ROUTES, "services/api/src/services/operations/remediation-executor.ts", "services/api/src/services/reports/output-recovery.service.ts"],
      expected: "On an entitled workspace an exhausted TECHNICAL failure offers 'Retry after exhausted failure' to an operator holding operations.resolve, and executing it supersedes through the canonical recovery authority.",
      observed: obs, outcome: "INFORMATIONAL" });
    await c?.h.cleanup().catch(() => {});
  });
  it("exhausted technical failure on TEAM workspace", async () => {
    const { makeOrgWorkspace, member } = await import("./lib/boot");
    const o = await makeUser(c, "team-recovery");
    const ws = await makeOrgWorkspace(c, o.id, { name: "team-recovery", kind: "OWNED", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    await member(c, ws.teamId, o.id, "OWNER");
    const e = await evidence(c, ws.teamId, o.id);
    const req = await c.prisma.reportGenerationRequest.create({ data: { teamId: ws.teamId, evidenceId: e.id, idempotencyKey: `opsaudit-exh-${e.id}`, state: "FAILED_TERMINAL", terminalReasonCode: "retry_budget_exhausted", attemptCount: 5, createdAtUtc: new Date() } as any });
    const inc = await incident(c, ws.teamId, { sourceId: "pipeline.report_generation_failed", category: "REPORT", fingerprint: `REPORT:${e.id}:RETRY_BUDGET_EXHAUSTED`, relatedEvidenceId: e.id, title: "Report generation failure" });
    const det = await c.inj("GET", `/v1/ops/incidents/${inc.id}?teamId=${ws.teamId}`, o.token);
    const offered = (det.json()?.remediation?.actions ?? []).map((a: any) => a.actionId);
    const regen = await c.inj("POST", `/v1/ops/incidents/${inc.id}/remediate`, o.token, { teamId: ws.teamId, actionId: "report.regenerate_artifacts" });
    const sup = await c.inj("POST", `/v1/ops/incidents/${inc.id}/remediate`, o.token, { teamId: ws.teamId, actionId: "report.supersede_failed_generation", reason: "opsaudit: supersede exhausted technical failure" });
    const sup2 = await c.inj("POST", `/v1/ops/incidents/${inc.id}/remediate`, o.token, { teamId: ws.teamId, actionId: "report.supersede_failed_generation", reason: "opsaudit: double click" });
    const reqs = await c.prisma.reportGenerationRequest.findMany({ where: { evidenceId: e.id }, orderBy: { createdAtUtc: "asc" }, select: { state: true, idempotencyKey: true, forceRegenerate: true, regenerateReason: true } });
    const condition = await c.prisma.operationalIncident.findUnique({ where: { id: inc.id }, select: { status: true } });
    obs = { offeredActionIds: offered, regenerate: { status: regen.statusCode, body: scrub(regen.json()) }, supersede: { status: sup.statusCode, body: scrub(sup.json()) }, supersedeDoubleClick: { status: sup2.statusCode, body: scrub(sup2.json()) }, requests: scrub(reqs), conditionStatusAfter: condition?.status, originalRequestId: "<uuid>", _seed: req ? "ok" : "none" };
  });
});
