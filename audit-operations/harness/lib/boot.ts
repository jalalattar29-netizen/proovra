// AUDIT-ONLY boot + fixture helpers. Nothing here changes Product behaviour:
// it boots the real Fastify app through the repo's own integration harness and
// writes fixture rows through the real Prisma models.
import { apiUrl, repoUrl } from "./proof";

export type Ctx = {
  h: any;
  prisma: any;
  inj: (method: string, url: string, token?: string, body?: unknown, headers?: Record<string, string>) => Promise<any>;
  mint: (userId: string, email: string) => string;
};

export async function boot(): Promise<Ctx> {
  const { bootIntegrationHarness } = await import(apiUrl("test/integration-harness.ts"));
  const h = await bootIntegrationHarness();
  const { prisma } = await import(apiUrl("src/db.ts"));
  // The audit files import Product modules by absolute URL, which gives
  // packages/shared-runtime a second module instance in this process. Register
  // the SAME Prisma client on it, exactly as server.ts does on its own.
  (await import(repoUrl("packages/shared-runtime/dist/prisma-registry.js"))).registerPrisma(prisma);
  const { signJwt } = await import(apiUrl("src/services/jwt.ts"));
  const mint = (userId: string, email: string) =>
    signJwt({ sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) }, process.env.AUTH_JWT_SECRET!, 3600);
  const inj = (method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { payload: body } : {}) });
  return { h, prisma, inj, mint };
}

let seq = 0;
export async function makeUser(c: Ctx, tag: string, opts: { platformRole?: string } = {}) {
  const email = `${tag}-${Date.now()}-${seq++}@opsaudit.test`;
  const { REQUIRED_LEGAL_VERSIONS } = await import(apiUrl("src/legal/legal-versioning.ts"));
  const u = await c.prisma.user.create({ data: { email, provider: "EMAIL", providerUserId: email, firstName: tag, lastName: "Audit", emailVerifiedAt: new Date(), ...(opts.platformRole ? { platformRole: opts.platformRole } : {}) } });
  await c.prisma.userLegalAcceptance.createMany({ data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({ userId: u.id, policyKey, policyVersion: policyVersion as string, source: "opsaudit" })) });
  const token = c.mint(u.id, email);
  // Register the session exactly as the login route does
  // (auth.routes.ts recordSessionFromSignedToken -> recordAuthenticatedSession),
  // so Organization session-inventory checks see a real signed-in session.
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  const { recordAuthenticatedSession } = await import(apiUrl("src/services/access-control/session-inventory.service.ts"));
  await recordAuthenticatedSession({ userId: u.id, teamId: null, sid: payload.sid, iat: payload.iat, exp: payload.exp, ipPreview: "127.0.0.1", uaPreview: "opsaudit" });
  return { id: u.id as string, email, token };
}

export async function personalSpace(c: Ctx, userId: string): Promise<string> {
  const { ensurePersonalWorkspace } = await import(apiUrl("src/services/platform-context/workspace-bootstrap.service.ts"));
  return (await ensurePersonalWorkspace({ userId })).teamId;
}

export async function makeOrgWorkspace(c: Ctx, ownerId: string, opts: { name: string; orgId?: string; kind?: "ORGANIZATION" | "OWNED"; billingPlan?: string; billingStatus?: string; orgStatus?: string }) {
  let orgId = opts.orgId;
  if (!orgId) {
    // OWNED workspaces live in an internal SYSTEM container; ORGANIZATION workspaces in a CUSTOMER org.
    const orgKind = (opts.kind ?? "ORGANIZATION") === "OWNED" ? "SYSTEM" : "CUSTOMER";
    const org = await c.prisma.organization.create({ data: { name: `${opts.name}-org`, billingOwnerUserId: ownerId, status: opts.orgStatus ?? "ACTIVE", kind: orgKind } });
    await c.prisma.organizationMembership.create({ data: { organizationId: org.id, userId: ownerId, role: "ORG_OWNER" } });
    // Production-shaped: a CUSTOMER org carries a baseline security policy
    // (enterprise-provisioning.service.ts); without it the workspace switch
    // correctly refuses with POLICY_NOT_PROVISIONED.
    await c.prisma.organizationSecurityPolicy.create({ data: { organizationId: org.id, policyVersion: 1 } });
    orgId = org.id;
  }
  const t = await c.prisma.team.create({ data: { name: opts.name, ownerUserId: ownerId, isPersonal: false, organizationId: orgId, workspaceKind: opts.kind ?? "ORGANIZATION", ...(opts.billingPlan ? { billingPlan: opts.billingPlan } : {}), ...(opts.billingStatus ? { billingStatus: opts.billingStatus } : {}) } });
  return { teamId: t.id as string, orgId: orgId as string };
}

export async function member(c: Ctx, teamId: string, userId: string, role: string, status = "ACTIVE") {
  await c.prisma.teamMember.create({ data: { teamId, userId, role, status } });
}

let fp = 0;
export async function incident(c: Ctx, teamId: string | null, o: Partial<Record<string, any>> = {}) {
  return c.prisma.operationalIncident.create({
    data: {
      teamId, scope: o.scope ?? (teamId ? "WORKSPACE" : "LEGACY_UNSCOPED"), sourceId: o.sourceId ?? "governance.policy_condition",
      category: o.category ?? "GOVERNANCE", severity: o.severity ?? "HIGH", status: o.status ?? "OPEN",
      fingerprint: o.fingerprint ?? `opsaudit:${Date.now()}:${fp++}`, title: o.title ?? "audit condition", safeSummary: o.safeSummary ?? "audit",
      relatedEvidenceId: o.relatedEvidenceId ?? null, relatedJobId: o.relatedJobId ?? null, relatedProvider: o.relatedProvider ?? null, updatedAt: new Date(),
      ...(o.occurrenceCount ? { occurrenceCount: o.occurrenceCount } : {}),
    },
  });
}

export async function evidence(c: Ctx, teamId: string | null, ownerUserId: string, extra: Record<string, any> = {}) {
  const team = teamId ? await c.prisma.team.findUnique({ where: { id: teamId }, select: { organizationId: true } }) : null;
  return c.prisma.evidence.create({ data: { title: "audit evidence", type: "PHOTO", status: "SIGNED", teamId, organizationId: team?.organizationId ?? null, ownerUserId, ...extra } });
}

export async function sweep(workspaceId: string) {
  const recon = await import(apiUrl("src/services/operations/operations-reconciliation.service.ts"));
  return recon.reconcileWorkspaceOperations({ workspaceId, trigger: "cli" });
}

export async function envelopeCaps(c: Ctx, token: string, teamId: string) {
  // The envelope resolves the PERSISTED current workspace (the query string is
  // ignored), so select it through the product's own switch endpoint first.
  const sw = await c.inj("POST", "/v1/platform/context/switch-workspace", token, { workspaceId: teamId });
  const r = await c.inj("GET", "/v1/platform/context", token);
  const s: string = r.body;
  const cap = (k: string) => (s.match(new RegExp(`"${k}":(true|false)`)) ?? [])[1] ?? null;
  return { switchBody: sw.statusCode === 200 ? null : String(sw.body).slice(0, 300), switchStatus: sw.statusCode, activeTeamMatches: s.includes(teamId), status: r.statusCode, OPERATIONS_VIEW: cap("OPERATIONS_VIEW"), OPERATIONS_ACKNOWLEDGE: cap("OPERATIONS_ACKNOWLEDGE"), OPERATIONS_RESOLVE: cap("OPERATIONS_RESOLVE"), OPERATIONS_SUPPRESS: cap("OPERATIONS_SUPPRESS"), OPERATIONS_ASSIGN: cap("OPERATIONS_ASSIGN"), plan: (s.match(/"plan":"([A-Z_]+)"/) ?? [])[1] ?? null };
}
