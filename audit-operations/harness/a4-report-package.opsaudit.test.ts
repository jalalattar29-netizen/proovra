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

describe("A4 report / package conditions", () => {
  let c: Ctx;
  const out: any[] = [];
  beforeAll(async () => { c = await boot(); }, 900_000);
  afterAll(async () => {
    recordProof({ proofId: "PR-A4-report-package", title: "Report/package failure conditions: version truth, recovery, supersede offer, raw text, personal scope", proofType: "REAL_DB_PROVEN",
      findingIds: ["OPS-004", "OPS-013", "OPS-015", "OPS-016"], sources: [PROBES, STR, REG, ROUTES, EMIT, PROC, SCOPE, JOB],
      expected: "A failed newer version keeps its condition open until that version exists; supersede is offered to an authorized operator for a terminal technical failure; customer text is sanitized; personal-record failures are visible to their owner.",
      observed: out, outcome: "DEFECT_OBSERVED" });
    await c?.h.cleanup().catch(() => {});
  });
  const A = () => c.h.fixtures.teamA;
  const status = (id: string) => c.prisma.operationalIncident.findUnique({ where: { id }, select: { status: true, resolutionNote: true } });
  async function report(evId: string, version: number, at: Date) {
    return c.prisma.report.create({ data: { evidenceId: evId, version, storageBucket: "opsaudit-local", storageKey: `reports/${evId}/v${version}.pdf`, generatedAtUtc: at } as any });
  }
  async function request(evId: string, state: string, at: Date, extra: Record<string, unknown> = {}) {
    return c.prisma.reportGenerationRequest.create({ data: { teamId: A().teamId, evidenceId: evId, idempotencyKey: `opsaudit-${evId}-${Math.random().toString(36).slice(2)}`, state, createdAtUtc: at, ...extra } as any });
  }

  it("report cases", async () => {
    // 1. v1 failure, no report exists
    const e1 = await evidence(c, A().teamId, A().ownerUserId);
    const i1 = await incident(c, A().teamId, { sourceId: "pipeline.report_generation_failed", category: "REPORT", fingerprint: `REPORT:${e1.id}:RENDER_FAILED`, relatedEvidenceId: e1.id, title: "Report generation failure" });
    await request(e1.id, "FAILED_TERMINAL", new Date(), { terminalReasonCode: "RENDER_FAILED" });
    // 2. v2 failure while v1 exists (failed attempt has stage NULL, as every failed attempt does)
    const e2 = await evidence(c, A().teamId, A().ownerUserId, { latestReportVersion: 1 });
    await report(e2.id, 1, new Date(Date.now() - 3600_000));
    await request(e2.id, "FAILED_TERMINAL", new Date(), { forceRegenerate: true, intent: "NEW_VERSION", terminalReasonCode: "retry_budget_exhausted" });
    const i2 = await incident(c, A().teamId, { sourceId: "pipeline.report_generation_failed", category: "REPORT", fingerprint: `REPORT:${e2.id}:RETRY_BUDGET_EXHAUSTED`, relatedEvidenceId: e2.id, title: "Report generation failure" });
    // 3. v2 still PROCESSING while v1 exists
    const e3 = await evidence(c, A().teamId, A().ownerUserId, { latestReportVersion: 1 });
    await report(e3.id, 1, new Date(Date.now() - 3600_000));
    await request(e3.id, "PROCESSING", new Date(), { forceRegenerate: true, intent: "NEW_VERSION" });
    const i3 = await incident(c, A().teamId, { sourceId: "pipeline.report_generation_failed", category: "REPORT", fingerprint: `REPORT:${e3.id}:WORKER_CRASH`, relatedEvidenceId: e3.id, title: "Report generation failure" });
    // 4. recovery succeeds: v1 created after the failure
    const e4 = await evidence(c, A().teamId, A().ownerUserId);
    await request(e4.id, "FAILED_TERMINAL", new Date(Date.now() - 7200_000), { terminalReasonCode: "RENDER_FAILED" });
    const i4 = await incident(c, A().teamId, { sourceId: "pipeline.report_generation_failed", category: "REPORT", fingerprint: `REPORT:${e4.id}:RENDER_FAILED`, relatedEvidenceId: e4.id, title: "Report generation failure" });
    await report(e4.id, 1, new Date()); await c.prisma.evidence.update({ where: { id: e4.id }, data: { latestReportVersion: 1 } as any });
    await sweep(A().teamId);
    out.push({ case: "REPORT_V1_FAILED_NO_REPORT", expect: "OPEN", got: await status(i1.id) });
    out.push({ case: "REPORT_V2_FAILED_WHILE_V1_EXISTS", expect: "OPEN", got: await status(i2.id), failedRequestStage: null });
    out.push({ case: "REPORT_V2_PROCESSING_WHILE_V1_EXISTS", expect: "OPEN", got: await status(i3.id) });
    out.push({ case: "REPORT_RECOVERED_V1_CREATED", expect: "RESOLVED", got: await status(i4.id) });
    // 5. Output row exists but the object is missing: the probe reads the DB row only.
    const e5 = await evidence(c, A().teamId, A().ownerUserId);
    await request(e5.id, "FAILED_TERMINAL", new Date(Date.now() - 7200_000));
    const i5 = await incident(c, A().teamId, { sourceId: "pipeline.report_generation_failed", category: "REPORT", fingerprint: `REPORT:${e5.id}:STORAGE_PUT_FAILED`, relatedEvidenceId: e5.id });
    await c.prisma.report.create({ data: { evidenceId: e5.id, version: 1, storageBucket: "opsaudit-missing-bucket", storageKey: "does/not/exist.pdf", generatedAtUtc: new Date() } as any });
    await c.prisma.evidence.update({ where: { id: e5.id }, data: { latestReportVersion: 1 } as any });
    await sweep(A().teamId);
    out.push({ case: "REPORT_ROW_PRESENT_OBJECT_MISSING", note: "no object store is consulted by the probe", got: await status(i5.id) });
  });

  it("detail: supersede offered? remediate invokes the canonical recovery authority", async () => {
    const e = await evidence(c, A().teamId, A().ownerUserId);
    await request(e.id, "FAILED_TERMINAL", new Date(), { terminalReasonCode: "retry_budget_exhausted" });
    const inc = await incident(c, A().teamId, { sourceId: "pipeline.report_generation_failed", category: "REPORT", fingerprint: `REPORT:${e.id}:RETRY_BUDGET_EXHAUSTED`, relatedEvidenceId: e.id, title: "Report generation failure" });
    const ownerOps = await c.inj("GET", `/v1/ops/incidents/${inc.id}?teamId=${A().teamId}`, A().ownerToken);
    const actions = (ownerOps.json()?.remediation?.actions ?? []).map((a: any) => a.actionId);
    const direct = await c.inj("POST", `/v1/ops/incidents/${inc.id}/remediate`, A().ownerToken, { teamId: A().teamId, actionId: "report.supersede_failed_generation", reason: "opsaudit: supersede exhausted technical failure" });
    const before = await c.prisma.reportGenerationRequest.count({ where: { evidenceId: e.id } });
    const regen = await c.inj("POST", `/v1/ops/incidents/${inc.id}/remediate`, A().ownerToken, { teamId: A().teamId, actionId: "report.regenerate_artifacts" });
    const regen2 = await c.inj("POST", `/v1/ops/incidents/${inc.id}/remediate`, A().ownerToken, { teamId: A().teamId, actionId: "report.regenerate_artifacts" });
    const after = await c.prisma.reportGenerationRequest.findMany({ where: { evidenceId: e.id }, select: { state: true, idempotencyKey: true, forceRegenerate: true, intent: true } });
    const viewer = await c.inj("POST", `/v1/ops/incidents/${inc.id}/remediate`, A().viewerToken, { teamId: A().teamId, actionId: "report.regenerate_artifacts" });
    out.push({ case: "DETAIL_ACTIONS_FOR_OWNER", offeredActionIds: actions, supersedeViaDirectPost: { status: direct.statusCode, body: scrub(direct.json()) }, regenerate: { status: regen.statusCode, body: scrub(regen.json()) }, regenerateAgain: { status: regen2.statusCode, body: scrub(regen2.json()) }, requestsBefore: before, requestsAfter: scrub(after), viewerRemediate: viewer.statusCode, conditionAfter: await status(inc.id) });
  });

  it("worker writer: raw text projected verbatim; personal record failure is LEGACY_UNSCOPED and invisible", async () => {
    const emit = await import(repoUrl("services/worker/src/governance/incident-emitter.ts"));
    const e = await evidence(c, A().teamId, A().ownerUserId);
    const raw = "PutObject failed: AccessDenied for s3://proovra-evidence-prod-eu/evidence/abc/original.bin (KMS key arn:aws:kms:eu-central-1:123456789012:key/opsaudit)";
    await emit.recordWorkerIncident({ teamId: A().teamId, sourceId: "pipeline.report_generation_failed", category: "REPORT", severity: "CRITICAL", fingerprint: `REPORT:${e.id}:PUTOBJECT`, title: "Report generation failure", safeSummary: raw, relatedEvidenceId: e.id });
    const list = await c.inj("GET", `/v1/ops/incidents?teamId=${A().teamId}`, A().viewerToken);
    const row = list.json().incidents.find((i: any) => i.relatedEvidenceId === e.id);
    out.push({ case: "RAW_TEXT_TO_VIEWER", projectedSummary: row?.safeSummary ?? null, leaksBucket: /proovra-evidence-prod-eu/.test(row?.safeSummary ?? ""), leaksKmsArn: /arn:aws:kms/.test(row?.safeSummary ?? "") });
    // Personal record stored with team_id NULL.
    const u = await makeUser(c, "legacy-personal"); const ws = await personalSpace(c, u.id);
    await c.prisma.entitlement.create({ data: { userId: u.id, plan: "PRO", active: true } });
    const pe = await evidence(c, null, u.id);
    const w = await emit.recordWorkerIncident({ teamId: null, sourceId: "pipeline.report_generation_failed", category: "REPORT", severity: "CRITICAL", fingerprint: `REPORT:${pe.id}:RENDER_FAILED`, title: "Report generation failure", safeSummary: "render failed", relatedEvidenceId: pe.id });
    const mine = await c.inj("GET", `/v1/ops/incidents?teamId=${ws}`, u.token);
    const vis = mine.json().incidents.some((i: any) => i.relatedEvidenceId === pe.id);
    const summ = await c.inj("GET", `/v1/ops/summary?teamId=${ws}`, u.token);
    out.push({ case: "PERSONAL_NULL_TEAM_RECORD_FAILURE", storedScope: w?.scope ?? null, visibleToOwnerInPersonalSpace: vis, ownerSummaryOpenCount: summ.json()?.summary?.open ?? null });
  });
});
