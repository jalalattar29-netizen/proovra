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

describe("A3b billing subjects: ownership transfer, Enterprise payer, lapsed personal payer", () => {
  let c: Ctx; const out: any[] = [];
  beforeAll(async () => { c = await boot(); }, 900_000);
  afterAll(async () => {
    recordProof({ proofId: "PR-A3b-billing-subjects", title: "Storage add-on condition attribution across payer shapes", proofType: "REAL_DB_PROVEN", findingIds: ["OPS-003", "OPS-023"], sources: [COND, SVC, PROBES, LIFE, AUTH],
      expected: "The condition follows the billing subject, stays visible to whoever now administers it, and is never closable by hand while live.", observed: out, outcome: "INFORMATIONAL" });
    await c?.h.cleanup().catch(() => {});
  });
  async function addon(ownerUserId: string, teamId: string | null, state: string) {
    return c.prisma.workspaceStorageAddon.create({ data: { ownerUserId, teamId, addonKey: teamId ? "TEAM_100_GB" : "PERSONAL_10_GB", extraStorageBytes: BigInt(10e9), billingCycle: "MONTHLY", status: "ACTIVE", paymentProvider: "STRIPE", externalSubscriptionId: `sub_opsaudit_b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, dependentCancellationState: state, dependentCancellationRequestedAtUtc: new Date() } as any });
  }
  const cond = (id: string) => c.prisma.operationalIncident.findFirst({ where: { fingerprint: `billing_dependent_cancellation:${id}` }, select: { id: true, teamId: true, status: true } });
  it("ownership transfer of a TEAM workspace", async () => {
    const o1 = await makeUser(c, "xfer-old"); const o2 = await makeUser(c, "xfer-new");
    const ws = await makeOrgWorkspace(c, o1.id, { name: "xfer", kind: "OWNED", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    await member(c, ws.teamId, o1.id, "OWNER"); await member(c, ws.teamId, o2.id, "ADMIN");
    const a = await addon(o1.id, ws.teamId, "MANUAL_INTERVENTION");
    await sweep(ws.teamId);
    await c.prisma.team.update({ where: { id: ws.teamId }, data: { ownerUserId: o2.id } });
    await c.prisma.teamMember.updateMany({ where: { teamId: ws.teamId, userId: o1.id }, data: { status: "REVOKED" } });
    await c.prisma.teamMember.updateMany({ where: { teamId: ws.teamId, userId: o2.id }, data: { role: "OWNER" } });
    const row = await cond(a.id);
    const newOwner = await c.inj("GET", `/v1/ops/incidents/${row!.id}?teamId=${ws.teamId}`, o2.token);
    const oldOwner = await c.inj("GET", `/v1/ops/incidents/${row!.id}?teamId=${ws.teamId}`, o1.token);
    const resolve = await c.inj("POST", `/v1/ops/incidents/${row!.id}/resolve`, o2.token, { teamId: ws.teamId, resolutionNote: "opsaudit" });
    out.push({ case: "OWNERSHIP_TRANSFER", conditionTeamIsWorkspace: row?.teamId === ws.teamId, newOwnerReads: newOwner.statusCode, revokedOldOwnerReads: oldOwner.statusCode, newOwnerManualResolveWhileLive: resolve.statusCode });
  });
  it("Enterprise payer and lapsed personal payer", async () => {
    const eo = await makeUser(c, "ent-payer");
    const ews = await makeOrgWorkspace(c, eo.id, { name: "ent-payer", billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
    await member(c, ews.teamId, eo.id, "OWNER");
    const ea = await addon(eo.id, ews.teamId, "RETRY_SCHEDULED");
    await sweep(ews.teamId);
    const er = await cond(ea.id);
    const eres = await c.inj("POST", `/v1/ops/incidents/${er!.id}/resolve`, eo.token, { teamId: ews.teamId, resolutionNote: "opsaudit" });
    out.push({ case: "ENTERPRISE_PAYER", conditionInEnterpriseWorkspace: er?.teamId === ews.teamId, manualResolveWhileLive: eres.statusCode });
    const lp = await makeUser(c, "lapsed-payer"); const lws = await personalSpace(c, lp.id);
    await c.prisma.entitlement.create({ data: { userId: lp.id, plan: "PRO", active: false } });
    const la = await addon(lp.id, null, "PENDING");
    await sweep(lws);
    const lr = await cond(la.id);
    const list = await c.inj("GET", `/v1/ops/incidents?teamId=${lws}`, lp.token);
    const caps = await (await import("./lib/boot")).envelopeCaps(c, lp.token, lws);
    const act = await addon(lp.id, null, "NONE");
    await sweep(lws);
    out.push({ case: "ACTIVE_ADDON_NO_OBLIGATION", conditionsForAddon: await c.prisma.operationalIncident.count({ where: { fingerprint: `billing_dependent_cancellation:${act.id}` } }) });
    out.push({ case: "LAPSED_PERSONAL_PAYER", conditionOpened: lr?.status ?? null, apiListStatus: list.statusCode, apiShowsIt: list.json().incidents?.some((i: any) => i.id === lr?.id) ?? false, webOperationsView: caps.OPERATIONS_VIEW, webPlan: caps.plan, homeSurfaceDeclared: "billing.dependent_cancellation_failed surfaces.home=true (registry)" });
  });
});
