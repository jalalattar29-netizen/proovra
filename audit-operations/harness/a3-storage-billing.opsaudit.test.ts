// OPS-003 / OPS-023 — storage add-on obligations against live PostgreSQL, with
// an injected provider canceller (no network: the provider is a local stub).
import { apiUrl, recordProof, scrub } from "./lib/proof";
import { boot, makeOrgWorkspace, makeUser, member, personalSpace, sweep, type Ctx } from "./lib/boot";

const COND = "services/api/src/services/billing/dependent-cancellation-conditions.service.ts";
const SVC = "services/api/src/services/billing/dependent-cancellation.service.ts";
const JOB = "services/api/src/jobs/dependent-cancellation-retry.job.ts";
const PROBES = "services/api/src/services/operations/operations-source-probes.ts";
const GEN = "services/api/src/services/dashboard/incident-generator.service.ts";
const REG = "services/api/src/services/operations/remediation-registry.ts";
const LIFE = "packages/shared-runtime/src/ops/source-lifecycle.ts";
const AUTH = "packages/shared-runtime/src/incident-transition-authority.ts";
const BILL = "services/api/src/routes/billing.routes.ts";

describe("A3 storage add-on / billing incident truth", () => {
  let c: Ctx;
  const out: any[] = [];
  beforeAll(async () => { c = await boot(); }, 900_000);
  afterAll(async () => {
    recordProof({
      proofId: "PR-A3-storage-addon", title: "Storage add-on obligation incidents: wording, scope, auto-resolution and manual resolution", proofType: "REAL_DB_PROVEN",
      findingIds: ["OPS-003", "OPS-023"], sources: [COND, SVC, JOB, PROBES, GEN, REG, LIFE, AUTH, BILL],
      expected: "Title matches the add-on state; the condition closes when the provider confirms; manual resolve is refused while the obligation is live; the drawer links to Billing.",
      observed: out, outcome: "DEFECT_OBSERVED",
    });
    await c?.h.cleanup().catch(() => {});
  });

  async function addon(ownerUserId: string, teamId: string | null, state: string, extra: Record<string, unknown> = {}) {
    return c.prisma.workspaceStorageAddon.create({ data: { ownerUserId, teamId, addonKey: teamId ? "TEAM_100_GB" : "PERSONAL_10_GB", extraStorageBytes: BigInt(10e9), billingCycle: "MONTHLY", status: "ACTIVE", paymentProvider: "STRIPE", externalSubscriptionId: `sub_opsaudit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, currentPeriodEnd: new Date(Date.now() + 20 * 86400_000), dependentCancellationState: state, dependentCancellationRequestedAtUtc: new Date(), ...extra } as any });
  }
  const cond = (addonId: string) => c.prisma.operationalIncident.findFirst({ where: { fingerprint: `billing_dependent_cancellation:${addonId}` }, select: { id: true, teamId: true, status: true, title: true, severity: true, category: true, occurrenceCount: true, relatedProvider: true, firstSeenAtUtc: true, lastSeenAtUtc: true } });

  it("personal payer (team_id NULL): every unresolved state", async () => {
    const u = await makeUser(c, "addon-personal"); const ws = await personalSpace(c, u.id);
    await c.prisma.entitlement.create({ data: { userId: u.id, plan: "PRO", active: true } });
    for (const state of ["PENDING", "RETRY_SCHEDULED", "ACTION_REQUIRED", "MANUAL_INTERVENTION"]) {
      const a = await addon(u.id, null, state);
      await sweep(ws);
      const row = await cond(a.id);
      const det = row ? await c.inj("GET", `/v1/ops/incidents/${row.id}?teamId=${ws}`, u.token) : null;
      const dj = det?.json();
      const resolve = row ? await c.inj("POST", `/v1/ops/incidents/${row.id}/resolve`, u.token, { teamId: ws, resolutionNote: "audit: attempt manual close while live" }) : null;
      out.push({ case: `PERSONAL_${state}`, addonStatus: "ACTIVE (paid through +20d)", incidentInPersonalSpace: row?.teamId === ws, storedTitle: row?.title, projectedTitle: dj?.incident?.title, category: row?.category, relatedProvider: row?.relatedProvider, remediation: scrub(dj?.remediation), manualResolveWhileLive: { status: resolve?.statusCode, body: resolve?.body?.slice(0, 160) } });
    }
  });

  it("personal payer: provider confirms -> sweep -> still open (stuck); obligation withdrawn to NONE -> still open", async () => {
    const u = await makeUser(c, "addon-confirm"); const ws = await personalSpace(c, u.id);
    await c.prisma.entitlement.create({ data: { userId: u.id, plan: "PRO", active: true } });
    const a = await addon(u.id, null, "PENDING");
    await sweep(ws);
    const before = await cond(a.id);
    await c.prisma.workspaceStorageAddon.update({ where: { id: a.id }, data: { dependentCancellationState: "CONFIRMED", dependentCancellationConfirmedAtUtc: new Date() } });
    for (let i = 0; i < 3; i++) await sweep(ws);
    const after = await cond(a.id);
    const b = await addon(u.id, null, "PENDING", { dependentCancellationNextRetryAtUtc: new Date(Date.now() - 60_000) });
    await sweep(ws);
    // Retry sweep with a provider stub that would succeed: the integrity guard withdraws the
    // unsupported obligation (no cancelled base plan in this fixture) to NONE first.
    const job = await import(apiUrl("src/jobs/dependent-cancellation-retry.job.ts"));
    const calls: string[] = [];
    const res = await job.runDependentCancellationRetrySweep({ cancelAtProvider: async (x: any) => { calls.push(String(x?.addon?.id ?? x?.addonId ?? "?")); return { ok: true, mode: "IMMEDIATE", terminal: true }; } } as any).catch((e: any) => ({ error: String(e.message).slice(0, 200) }));
    const bRow = await c.prisma.workspaceStorageAddon.findUnique({ where: { id: b.id }, select: { dependentCancellationState: true, dependentCancellationReasonCode: true } });
    for (let i = 0; i < 2; i++) await sweep(ws);
    const bCond = await cond(b.id);
    out.push({ case: "PERSONAL_CONFIRMED_AFTER_OPEN", before: before?.status, afterConfirmedAnd3Sweeps: after?.status, occurrencesFrozenAt: after?.occurrenceCount, lastSeenEqualsFirstSeenDay: after?.lastSeenAtUtc.toISOString().slice(0, 10) === after?.firstSeenAtUtc.toISOString().slice(0, 10) });
    out.push({ case: "PERSONAL_OBLIGATION_WITHDRAWN", retrySweep: scrub(res), providerStubCalls: calls.length, addonStateAfterRetrySweep: bRow, conditionAfter2Sweeps: bCond?.status });
  });

  it("TEAM payer: provider error vs confirmed; manual resolve while live; customer retry route", async () => {
    const o = await makeUser(c, "addon-team-owner");
    const ws = await makeOrgWorkspace(c, o.id, { name: "addon-team", kind: "OWNED", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    await member(c, ws.teamId, o.id, "OWNER");
    const a = await addon(o.id, ws.teamId, "RETRY_SCHEDULED", { dependentCancellationReasonCode: "PROVIDER_UNAVAILABLE", dependentCancellationAttemptCount: 3 });
    await sweep(ws.teamId);
    const row = await cond(a.id);
    const det = await c.inj("GET", `/v1/ops/incidents/${row!.id}?teamId=${ws.teamId}`, o.token);
    const live = await c.inj("POST", `/v1/ops/incidents/${row!.id}/resolve`, o.token, { teamId: ws.teamId, resolutionNote: "audit: attempt manual close while live" });
    const retryOrg = await c.inj("POST", `/v1/billing/accounts/ORGANIZATION/${ws.orgId}/retry-storage-cancellation`, o.token, {});
    await c.prisma.workspaceStorageAddon.update({ where: { id: a.id }, data: { dependentCancellationState: "CONFIRMED", dependentCancellationConfirmedAtUtc: new Date() } });
    await sweep(ws.teamId);
    const afterConfirm = await cond(a.id);
    const manualAfterConfirm = await c.inj("POST", `/v1/ops/incidents/${row!.id}/resolve`, o.token, { teamId: ws.teamId, resolutionNote: "audit: provider confirmed" });
    out.push({ case: "TEAM_PAYER", incidentInTeam: row?.teamId === ws.teamId, storedTitle: row?.title, projectedTitle: det.json()?.incident?.title, providerOutageDistinguishedInTitle: /unavailable|outage/i.test(det.json()?.incident?.title ?? ""), summary: det.json()?.incident?.safeSummary, remediation: scrub(det.json()?.remediation), manualResolveWhileLive: { status: live.statusCode, code: live.json()?.error?.code ?? live.json()?.code ?? null }, customerRetryForOrgAccount: { status: retryOrg.statusCode, body: retryOrg.body.slice(0, 160) }, afterProviderConfirmedAndSweep: afterConfirm?.status, manualResolveAfterConfirm: manualAfterConfirm.statusCode });
  });
});
