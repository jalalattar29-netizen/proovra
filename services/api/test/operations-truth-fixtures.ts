/**
 * Shared fixtures for the Operations truth-closure integration suites.
 *
 * Every row is written through the real Prisma models in a production shape:
 * users accept the current legal policies and carry a registered session (as
 * the login route records one), CUSTOMER organizations carry their baseline
 * security policy, OWNED workspaces live in an internal SYSTEM container. A
 * fixture that skipped any of those would be exercising a state the product
 * cannot reach.
 */
import type {
  IncidentCategory,
  IncidentScope,
  IncidentSeverity,
  IncidentStatus,
  PlanType,
  PrismaClient,
  TeamBillingStatus,
  TeamMemberStatus,
  TeamRole,
} from "@prisma/client";
import type { LightMyRequestResponse } from "fastify";

import type { IntegrationHarness } from "./integration-harness.js";

export type Ctx = {
  h: IntegrationHarness;
  prisma: PrismaClient;
  inj: (
    method: string,
    url: string,
    token?: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<LightMyRequestResponse>;
};

export async function bootOps(): Promise<Ctx> {
  const { bootIntegrationHarness } = await import("./integration-harness.js");
  const h = await bootIntegrationHarness();
  const { prisma } = await import("../src/db.js");
  // Harness gap shared by the other integration suites: shared-runtime's
  // registry is populated by server bootstrap in production, explicitly here.
  const { registerPrisma } = await import("@proovra/shared-runtime");
  registerPrisma(prisma as never);
  const inj = (method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({ method: method as never, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { payload: body as never } : {}) });
  return { h, prisma, inj };
}

let seq = 0;
export async function makeUser(c: Ctx, tag: string, opts: { platformRole?: string; plan?: PlanType } = {}) {
  const email = `${tag}-${Date.now()}-${seq++}@ops-truth.test`;
  const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
  const { signJwt } = await import("../src/services/jwt.js");
  const { recordAuthenticatedSession } = await import("../src/services/access-control/session-inventory.service.js");
  const u = await c.prisma.user.create({
    data: { email, provider: "EMAIL", providerUserId: email, firstName: tag, lastName: "Ops", emailVerifiedAt: new Date(), ...(opts.platformRole ? { platformRole: opts.platformRole } : {}) },
  });
  await c.prisma.userLegalAcceptance.createMany({
    data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({ userId: u.id, policyKey, policyVersion: policyVersion as string, source: "ops-truth" })),
  });
  if (opts.plan) await c.prisma.entitlement.create({ data: { userId: u.id, plan: opts.plan, active: true } });
  const token = signJwt({ sub: u.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) }, process.env.AUTH_JWT_SECRET!, 3600);
  const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
  await recordAuthenticatedSession({ userId: u.id, teamId: null, sid: payload.sid, iat: payload.iat, exp: payload.exp, ipPreview: "127.0.0.1", uaPreview: "ops-truth" });
  return { id: u.id as string, email, token };
}

export async function personalSpace(_c: Ctx, userId: string): Promise<string> {
  const { ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js");
  return (await ensurePersonalWorkspace({ userId })).teamId;
}

export async function makeWorkspace(
  c: Ctx,
  ownerId: string,
  opts: {
    name: string;
    kind?: "ORGANIZATION" | "OWNED";
    orgId?: string;
    billingPlan?: PlanType;
    billingStatus?: TeamBillingStatus;
  },
) {
  let orgId = opts.orgId;
  if (!orgId) {
    const kind = (opts.kind ?? "ORGANIZATION") === "OWNED" ? "SYSTEM" : "CUSTOMER";
    const org = await c.prisma.organization.create({ data: { name: `${opts.name}-org`, billingOwnerUserId: ownerId, status: "ACTIVE", kind } });
    await c.prisma.organizationSecurityPolicy.create({ data: { organizationId: org.id, policyVersion: 1 } });
    await c.prisma.organizationMembership.create({ data: { organizationId: org.id, userId: ownerId, role: "ORG_OWNER" } });
    orgId = org.id;
  }
  const t = await c.prisma.team.create({
    data: { name: opts.name, ownerUserId: ownerId, isPersonal: false, organizationId: orgId, workspaceKind: opts.kind ?? "ORGANIZATION", ...(opts.billingPlan ? { billingPlan: opts.billingPlan } : {}), ...(opts.billingStatus ? { billingStatus: opts.billingStatus } : {}) },
  });
  await c.prisma.teamMember.create({ data: { teamId: t.id, userId: ownerId, role: "OWNER", status: "ACTIVE" } });
  return { teamId: t.id as string, orgId: orgId as string };
}

export async function addMember(
  c: Ctx,
  teamId: string,
  userId: string,
  role: TeamRole,
  status: TeamMemberStatus = "ACTIVE",
) {
  await c.prisma.teamMember.create({ data: { teamId, userId, role, status } });
}

let fp = 0;
/** Overrides for a seeded condition; every field is optional. */
type IncidentSeed = {
  scope?: IncidentScope;
  sourceId?: string | null;
  category?: IncidentCategory;
  severity?: IncidentSeverity;
  status?: IncidentStatus;
  fingerprint?: string;
  title?: string;
  safeSummary?: string;
  relatedEvidenceId?: string | null;
  occurrenceCount?: number;
};

export async function seedIncident(c: Ctx, teamId: string | null, o: IncidentSeed = {}) {
  return c.prisma.operationalIncident.create({
    data: {
      teamId,
      scope: o.scope ?? (teamId ? "WORKSPACE" : "LEGACY_UNSCOPED"),
      sourceId: "sourceId" in o ? o.sourceId : "governance.policy_condition",
      category: o.category ?? "GOVERNANCE",
      severity: o.severity ?? "HIGH",
      status: o.status ?? "OPEN",
      fingerprint: o.fingerprint ?? `ops-truth:${Date.now()}:${fp++}`,
      title: o.title ?? "ops-truth condition",
      safeSummary: o.safeSummary ?? "ops-truth",
      relatedEvidenceId: o.relatedEvidenceId ?? null,
      updatedAt: new Date(),
      ...(o.occurrenceCount ? { occurrenceCount: o.occurrenceCount } : {}),
    },
  });
}

export async function seedEvidence(c: Ctx, teamId: string | null, ownerUserId: string, extra: Record<string, unknown> = {}) {
  const team = teamId ? await c.prisma.team.findUnique({ where: { id: teamId }, select: { organizationId: true } }) : null;
  return c.prisma.evidence.create({ data: { title: "ops-truth evidence", type: "PHOTO", status: "SIGNED", teamId, organizationId: team?.organizationId ?? null, ownerUserId, ...extra } });
}

export async function sweep(workspaceId: string) {
  const { reconcileWorkspaceOperations } = await import("../src/services/operations/operations-reconciliation.service.js");
  return reconcileWorkspaceOperations({ workspaceId, trigger: "cli" });
}

/** The capability envelope the web gates on, for the given workspace. */
export async function envelopeFor(c: Ctx, token: string, teamId: string) {
  await c.inj("POST", "/v1/platform/context/switch-workspace", token, { workspaceId: teamId });
  const r = await c.inj("GET", "/v1/platform/context", token);
  const body = r.json() as { capabilities?: Record<string, boolean> };
  const wrapped = body as { capabilities?: Record<string, boolean>; envelope?: { capabilities?: Record<string, boolean> } };
  const caps = wrapped?.capabilities ?? wrapped?.envelope?.capabilities ?? {};
  return { status: r.statusCode, caps: caps as Record<string, boolean> };
}
