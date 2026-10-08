// Persona x plan x workspace matrix, OPS-005 / OPS-010 / OPS-021 and tenancy.
// Every cell is exercised against the real API; the web decision is read from
// the same capability envelope the web page gate consumes.
import { boot, envelopeCaps, incident, makeOrgWorkspace, makeUser, member, personalSpace, type Ctx } from "./lib/boot";
import { recordProof, scrub } from "./lib/proof";

const ROUTES = "services/api/src/routes/ops.routes.ts";
const CAPS = "services/api/src/services/platform-context/capability-registry.ts";
const CTX = "services/api/src/services/platform-context/platform-context.service.ts";
const POL = "services/api/src/services/identity/access-policy.service.ts";
const SCOPE = "services/api/src/services/observability/incident-scope.ts";
const PERM = "packages/shared/src/permissions.ts";
const PLAN = "packages/shared-billing/src/plan-catalog.ts";

type Cell = { cell: string; persona: string; plan: string; workspaceType: string; token?: string; teamId: string; userId?: string };

describe("A2 persona / plan / workspace matrix", () => {
  let c: Ctx;
  const cells: any[] = [];
  beforeAll(async () => { c = await boot(); }, 900_000);
  afterAll(async () => {
    recordProof({
      proofId: "PR-A2-matrix", title: "Persona x plan x workspace access matrix (API executed; web decision from capability envelope)", proofType: "RUNTIME_PROVEN",
      findingIds: ["OPS-005", "OPS-010", "OPS-021"], sources: [ROUTES, CAPS, CTX, POL, SCOPE, PERM, PLAN],
      expected: "API authorization agrees with the web capability decision for every cell; tenant reads never include platform, legacy-unscoped or other-workspace rows.",
      observed: cells, outcome: "INFORMATIONAL",
    });
    await c?.h.cleanup().catch(() => {});
  });

  async function probe(x: Cell, extra: Record<string, unknown> = {}) {
    const own = await incident(c, x.teamId, { title: `cell ${x.cell}` });
    const other = await incident(c, c.h.fixtures.teamB.teamId, { title: "OTHER TENANT" });
    const plat = await incident(c, null, { scope: "PLATFORM", title: "PLATFORM ROW", sourceId: "billing.provider_authorization", category: "INTEGRATION" });
    const legacy = await incident(c, null, { scope: "LEGACY_UNSCOPED", title: "LEGACY ROW" });
    const env = x.token ? await envelopeCaps(c, x.token, x.teamId) : { status: 0 };
    const list = await c.inj("GET", `/v1/ops/incidents?teamId=${x.teamId}&limit=500`, x.token);
    const ids: string[] = list.statusCode === 200 ? list.json().incidents.map((i: any) => i.id) : [];
    const summary = await c.inj("GET", `/v1/ops/summary?teamId=${x.teamId}`, x.token);
    const detail = await c.inj("GET", `/v1/ops/incidents/${own.id}?teamId=${x.teamId}`, x.token);
    const otherDetail = await c.inj("GET", `/v1/ops/incidents/${other.id}?teamId=${x.teamId}`, x.token);
    const missingDetail = await c.inj("GET", `/v1/ops/incidents/00000000-0000-4000-8000-00000000abcd?teamId=${x.teamId}`, x.token);
    const ack = await c.inj("POST", `/v1/ops/incidents/${own.id}/ack`, x.token, { teamId: x.teamId });
    const sup = await c.inj("POST", `/v1/ops/incidents/${own.id}/suppress`, x.token, { teamId: x.teamId });
    const ops = await c.inj("GET", `/v1/ops/assignable-operators?teamId=${x.teamId}`, x.token);
    const health = await c.inj("GET", `/v1/ops/health?teamId=${x.teamId}`, x.token);
    const reconcile = await c.inj("POST", `/v1/ops/workspace-reconcile`, x.token, { teamId: x.teamId });
    const row = {
      cell: x.cell, persona: x.persona, plan: x.plan, workspaceType: x.workspaceType,
      web: { switchBody: (env as any).switchBody ?? null, switchStatus: (env as any).switchStatus ?? null, activeTeamMatches: (env as any).activeTeamMatches ?? null, envelopeStatus: env.status, OPERATIONS_VIEW: (env as any).OPERATIONS_VIEW ?? null, ACK: (env as any).OPERATIONS_ACKNOWLEDGE ?? null, RESOLVE: (env as any).OPERATIONS_RESOLVE ?? null, SUPPRESS: (env as any).OPERATIONS_SUPPRESS ?? null, ASSIGN: (env as any).OPERATIONS_ASSIGN ?? null, resolvedPlan: (env as any).plan ?? null },
      api: { list: list.statusCode, listCode: list.statusCode !== 200 ? (list.json()?.error?.code ?? null) : null, summary: summary.statusCode, detail: detail.statusCode, ack: ack.statusCode, suppress: sup.statusCode, assignableOperators: ops.statusCode, health: health.statusCode, workspaceReconcile: reconcile.statusCode },
      tenancy: { ownVisible: ids.includes(own.id), otherTenantVisible: ids.includes(other.id), platformVisible: ids.includes(plat.id), legacyVisible: ids.includes(legacy.id), otherTenantDetailById: otherDetail.statusCode, nonexistentDetail: missingDetail.statusCode, enumerationIndistinguishable: otherDetail.statusCode === missingDetail.statusCode && otherDetail.body === missingDetail.body },
      apiAgreesWithWeb: (env as any).OPERATIONS_VIEW == null ? null : ((env as any).OPERATIONS_VIEW === "true") === (list.statusCode === 200),
      ...extra,
    };
    cells.push(row);
    return row;
  }

  it("personal workspaces across plans and grants", async () => {
    const free = await makeUser(c, "free"); const freeWs = await personalSpace(c, free.id);
    await c.prisma.entitlement.create({ data: { userId: free.id, plan: "FREE", active: true } });
    await probe({ cell: "PERSONAL_FREE_OWNER", persona: "personal owner", plan: "FREE", workspaceType: "personal", token: free.token, teamId: freeWs });
    for (const plan of ["PAYG", "PRO", "TEAM"]) {
      const u = await makeUser(c, plan.toLowerCase()); const ws = await personalSpace(c, u.id);
      await c.prisma.entitlement.create({ data: { userId: u.id, plan, active: true } });
      await probe({ cell: `PERSONAL_${plan}_OWNER`, persona: "personal owner", plan, workspaceType: "personal", token: u.token, teamId: ws });
    }
    const g = await makeUser(c, "grant"); const gws = await personalSpace(c, g.id);
    const grant = await c.prisma.planGrant.create({ data: { userId: g.id, plan: "TEAM", source: "INTERNAL_TEST", reason: "audit", grantedByUserId: g.id, idempotencyKey: `opsaudit-${g.id}`, grantedAtUtc: new Date(Date.now() - 7200_000) } });
    await probe({ cell: "PERSONAL_INTERNAL_TEAM_GRANT", persona: "personal owner", plan: "FREE + internal TEAM grant", workspaceType: "personal", token: g.token, teamId: gws });
    await c.prisma.planGrant.update({ where: { id: grant.id }, data: { expiresAtUtc: new Date(Date.now() - 1000) } });
    await probe({ cell: "PERSONAL_EXPIRED_GRANT", persona: "personal owner", plan: "expired internal TEAM grant", workspaceType: "personal", token: g.token, teamId: gws });
    await c.prisma.planGrant.update({ where: { id: grant.id }, data: { expiresAtUtc: null, revokedAtUtc: new Date(), revocationReason: "audit" } });
    await probe({ cell: "PERSONAL_REVOKED_GRANT", persona: "personal owner", plan: "revoked internal TEAM grant", workspaceType: "personal", token: g.token, teamId: gws });
    const ex = await makeUser(c, "expiredent"); const exws = await personalSpace(c, ex.id);
    await c.prisma.entitlement.create({ data: { userId: ex.id, plan: "PRO", active: true, validUntil: new Date(Date.now() - 86400_000) } });
    await probe({ cell: "PERSONAL_PRO_LAPSED_ENTITLEMENT", persona: "personal owner", plan: "PRO entitlement validUntil past", workspaceType: "personal", token: ex.token, teamId: exws });
  });

  it("owned TEAM workspace billing states and roles", async () => {
    for (const status of ["ACTIVE", "PAST_DUE", "CANCELED", "INACTIVE"]) {
      const o = await makeUser(c, `owned-${status}`);
      const ws = await makeOrgWorkspace(c, o.id, { name: `owned-${status}`, kind: "OWNED", billingPlan: "TEAM", billingStatus: status });
      await member(c, ws.teamId, o.id, "OWNER");
      await probe({ cell: `OWNED_TEAM_${status}_OWNER`, persona: "TEAM owner (sole member)", plan: `TEAM billingStatus=${status}`, workspaceType: "owned team", token: o.token, teamId: ws.teamId });
    }
    const o = await makeUser(c, "owned-roles");
    const ws = await makeOrgWorkspace(c, o.id, { name: "owned-roles", kind: "OWNED", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    await member(c, ws.teamId, o.id, "OWNER");
    for (const role of ["ADMIN", "MEMBER", "VIEWER"]) {
      const u = await makeUser(c, `owned-${role}`); await member(c, ws.teamId, u.id, role);
      await probe({ cell: `OWNED_TEAM_ACTIVE_${role}`, persona: `TEAM ${role.toLowerCase()}`, plan: "TEAM ACTIVE", workspaceType: "owned team", token: u.token, teamId: ws.teamId });
    }
    for (const status of ["REVOKED", "SUSPENDED"]) {
      const u = await makeUser(c, `owned-${status}`); await member(c, ws.teamId, u.id, "MEMBER", status);
      await probe({ cell: `OWNED_TEAM_${status}_MEMBER`, persona: `${status.toLowerCase()} member`, plan: "TEAM ACTIVE", workspaceType: "owned team", token: u.token, teamId: ws.teamId });
    }
    const expd = await makeUser(c, "owned-expiredaccess"); await member(c, ws.teamId, expd.id, "MEMBER");
    await c.prisma.teamMember.updateMany({ where: { teamId: ws.teamId, userId: expd.id }, data: { accessExpiresAtUtc: new Date(Date.now() - 1000) } }).catch(() => {});
    await probe({ cell: "OWNED_TEAM_ACCESS_EXPIRED_MEMBER", persona: "member whose access expired", plan: "TEAM ACTIVE", workspaceType: "owned team", token: expd.token, teamId: ws.teamId });
    const inv = await makeUser(c, "invited");
    await c.prisma.teamInvite.create({ data: { teamId: ws.teamId, email: inv.email, role: "MEMBER", invitedByUserId: o.id, tokenHash: `opsaudit-${inv.id}`, expiresAt: new Date(Date.now() + 86400_000) } as any }).catch((e: any) => cells.push({ cell: "INVITE_FIXTURE_NOTE", error: String(e.message).slice(0, 200) }));
    await probe({ cell: "OWNED_TEAM_INVITED_NOT_ACCEPTED", persona: "invited, not accepted", plan: "TEAM ACTIVE", workspaceType: "owned team", token: inv.token, teamId: ws.teamId });
    // A FREE owned workspace with one ACTIVE member and one REVOKED ex-member (OPS-021).
    const f = await makeUser(c, "free-owned"); const fws = await makeOrgWorkspace(c, f.id, { name: "free-owned", kind: "OWNED", billingPlan: "FREE", billingStatus: "INACTIVE" });
    await member(c, fws.teamId, f.id, "OWNER");
    const gone = await makeUser(c, "free-owned-revoked"); await member(c, fws.teamId, gone.id, "MEMBER", "REVOKED");
    await probe({ cell: "OWNED_FREE_OWNER_WITH_REVOKED_EXMEMBER", persona: "sole active owner + 1 revoked row", plan: "FREE", workspaceType: "owned", token: f.token, teamId: fws.teamId });
    // Assignment candidate set must exclude the revoked user.
    const own = await incident(c, fws.teamId);
    const opsList = await c.inj("GET", `/v1/ops/assignable-operators?teamId=${fws.teamId}`, f.token);
    const assignRevoked = await c.inj("POST", `/v1/ops/incidents/${own.id}/assign`, f.token, { teamId: fws.teamId, assigneeUserId: gone.id });
    cells.push({ cell: "ASSIGN_TO_REVOKED", operators: scrub(opsList.json()), assignRevokedStatus: assignRevoked.statusCode, assignRevokedBody: assignRevoked.body.slice(0, 200) });
  });

  it("Enterprise organization: roles, suspended org, org owner without workspace membership", async () => {
    const o = await makeUser(c, "ent-owner");
    const w1 = await makeOrgWorkspace(c, o.id, { name: "ent-ws1", billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
    await member(c, w1.teamId, o.id, "OWNER");
    const orgAdmin = await makeUser(c, "ent-orgadmin");
    await c.prisma.organizationMembership.create({ data: { organizationId: w1.orgId, userId: orgAdmin.id, role: "ORG_ADMIN" } });
    await probe({ cell: "ENT_ORG_ADMIN_NOT_WORKSPACE_MEMBER", persona: "Enterprise org admin (no workspace membership row)", plan: "ENTERPRISE", workspaceType: "organization", token: orgAdmin.token, teamId: w1.teamId });
    await probe({ cell: "ENT_WS_OWNER", persona: "Enterprise workspace owner/org owner", plan: "ENTERPRISE", workspaceType: "organization", token: o.token, teamId: w1.teamId });
    for (const role of ["ADMIN", "MEMBER", "VIEWER"]) {
      const u = await makeUser(c, `ent-${role}`); await member(c, w1.teamId, u.id, role);
      await probe({ cell: `ENT_WS_${role}`, persona: `Enterprise workspace ${role.toLowerCase()}`, plan: "ENTERPRISE", workspaceType: "organization", token: u.token, teamId: w1.teamId });
    }
    await c.prisma.organization.update({ where: { id: w1.orgId }, data: { status: "SUSPENDED", suspendedAtUtc: new Date() } }).catch(async () => c.prisma.organization.update({ where: { id: w1.orgId }, data: { status: "SUSPENDED" } }));
    await probe({ cell: "ENT_SUSPENDED_ORG_OWNER", persona: "owner of suspended org", plan: "ENTERPRISE", workspaceType: "organization (suspended)", token: o.token, teamId: w1.teamId });
  });

  it("platform admin, unauthenticated, multi-workspace switching", async () => {
    const pa = await makeUser(c, "platform-admin", { platformRole: "admin" });
    const a = c.h.fixtures.teamA;
    await probe({ cell: "PLATFORM_ADMIN_NOT_MEMBER", persona: "Platform Admin (no membership)", plan: "n/a", workspaceType: "organization", token: pa.token, teamId: a.teamId });
    const adminList = await c.inj("GET", `/v1/admin/incidents`, pa.token);
    const adminScopes = adminList.statusCode === 200 ? [...new Set((adminList.json().items ?? []).map((i: any) => i.scope))] : [];
    const nonAdminAdminList = await c.inj("GET", `/v1/admin/incidents`, a.ownerToken);
    cells.push({ cell: "PLATFORM_ADMIN_CONSOLE", adminIncidents: adminList.statusCode, scopesVisible: adminScopes, adminRowCount: (adminList.json().items ?? []).length, adminItemKeys: Object.keys((adminList.json().items ?? [])[0] ?? {}), customerOwnerOnAdminRoute: nonAdminAdminList.statusCode });
    await probe({ cell: "UNAUTHENTICATED", persona: "unauthenticated", plan: "n/a", workspaceType: "organization", teamId: a.teamId });
    // One user in two workspaces: reading A then B returns disjoint sets; reading C (not a member) is 404.
    const u = await makeUser(c, "multi");
    const x = await makeOrgWorkspace(c, u.id, { name: "multi-x", kind: "OWNED", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    const y = await makeOrgWorkspace(c, u.id, { name: "multi-y", kind: "OWNED", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    await member(c, x.teamId, u.id, "OWNER"); await member(c, y.teamId, u.id, "OWNER");
    const ix = await incident(c, x.teamId, { title: "X only" }); const iy = await incident(c, y.teamId, { title: "Y only" });
    const lx = (await c.inj("GET", `/v1/ops/incidents?teamId=${x.teamId}`, u.token)).json().incidents.map((i: any) => i.id);
    const ly = (await c.inj("GET", `/v1/ops/incidents?teamId=${y.teamId}`, u.token)).json().incidents.map((i: any) => i.id);
    const crossAck = await c.inj("POST", `/v1/ops/incidents/${iy.id}/ack`, u.token, { teamId: x.teamId });
    const crossResolve = await c.inj("POST", `/v1/ops/incidents/${iy.id}/resolve`, u.token, { teamId: x.teamId });
    cells.push({ cell: "MULTI_WORKSPACE_USER", xHasOnlyX: lx.includes(ix.id) && !lx.includes(iy.id), yHasOnlyY: ly.includes(iy.id) && !ly.includes(ix.id), modifyYIncidentFromXContext: { ack: crossAck.statusCode, resolve: crossResolve.statusCode } });
  });
});
