/**
 * Pricing-hardening — shared resolvers for the Enterprise feature gate
 * used by canonical auth/identity routes (SCIM, SAML admin, etc.).
 *
 * These helpers exist in their own service file so that the route files
 * (`scim.routes.ts`, `saml-auth.routes.ts`) remain within their R8 size
 * baselines and so the gate logic is testable in isolation. Do NOT
 * inline this logic in the route files — the R8 file-size pins in
 * `phase-r8-enterprise-identity-security.test.ts` enforce it.
 */

import type { FastifyReply } from "fastify";
import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import { getPlanCapabilities } from "./plan-catalog.service.js";
import type { EnterpriseFeatureFlags } from "./plan-catalog.service.js";
// PHASE 12 POINT 4 PASS C5 — the canonical commercial envelope, explicit subject.
import { resolveCommercialContext } from "./billing/commercial-context.service.js";

export type TeamGateResult =
  | { ok: true }
  | { ok: false; reason: string; statusCode: number };

/**
 * Returns ok=true iff the team's effective plan (billing-active TEAM
 * plan, otherwise the team owner's Entitlement plan) grants the
 * requested Enterprise feature.
 *
 * Self-contained — does not throw. Callers map the negative result to
 * their route's preferred reply shape (e.g. SCIM uses application/scim+json,
 * SAML uses a JSON envelope).
 */
export async function resolveTeamEnterpriseFeatureGate(
  teamId: string,
  feature: keyof EnterpriseFeatureFlags,
): Promise<TeamGateResult> {
  // PHASE 12 POINT 4 PASS C5 — the effective plan comes from the ONE
  // subject-correct authority.
  //
  // This used to re-derive it here: read `Team.billingPlan`, and when the
  // workspace's billing was NOT live, fall back to the OWNER's personal
  // entitlement. That is an owner-plan fallback on the gate that guards SCIM
  // and SAML, so a suspended or cancelled enterprise workspace kept its
  // enterprise identity features whenever its owner personally held a plan
  // that included them. The canonical policy uses the owner's entitlement
  // ONLY for a PERSONAL workspace; an OWNED/ORGANIZATION workspace answers
  // from its own persisted commercial state (or its organization contract).
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { ownerUserId: true },
  });
  if (!team) {
    return { ok: false, reason: "team_not_found", statusCode: 404 };
  }
  const ctx = await resolveCommercialContext({
    type: "WORKSPACE",
    teamId,
    requesterUserId: team.ownerUserId,
  });
  const effectivePlan = ctx.plan as prismaPkg.PlanType;
  if (!getPlanCapabilities(effectivePlan).enterpriseFeatures[feature]) {
    return {
      ok: false,
      reason: "ENTERPRISE_FEATURE_REQUIRED",
      statusCode: 402,
    };
  }
  return { ok: true };
}

/**
 * Fastify-reply helper. Returns true when the gate denied (reply
 * already sent) so route handlers can early-return. Keeps the route
 * file thin — the helper is NOT inlined inside the canonical auth /
 * identity route files (R8 size baseline).
 */
export async function denyTeamIfNotEnterprise(
  reply: FastifyReply,
  teamId: string,
  feature: keyof EnterpriseFeatureFlags,
): Promise<boolean> {
  const gate = await resolveTeamEnterpriseFeatureGate(teamId, feature);
  if (gate.ok) return false;
  reply.code(gate.statusCode).send({
    error: {
      code: gate.reason,
      message: `Feature "${feature}" is included only on Enterprise plans`,
      upgradeCta: "/contact-sales",
    },
  });
  return true;
}

/**
 * Phase 3 — Enterprise Identity: org-level enterprise gate.
 *
 * An Organization is treated as Enterprise for identity features (SSO,
 * domain verification) iff AT LEAST ONE of its workspaces (Teams) grants the
 * `ssoScim` Enterprise feature under {@link resolveTeamEnterpriseFeatureGate}.
 * This mirrors the "ENTERPRISE = ORGANIZATION" architecture: enterprise is a
 * property of the org, surfaced through its billing-active workspaces.
 *
 * Returns ok=true on the first qualifying workspace. Does not throw.
 */
export async function resolveOrgEnterpriseFeatureGate(
  organizationId: string,
  feature: keyof EnterpriseFeatureFlags,
): Promise<TeamGateResult> {
  const teams = await prisma.team.findMany({
    where: { organizationId },
    select: { id: true },
  });
  if (teams.length === 0) {
    return { ok: false, reason: "organization_not_found", statusCode: 404 };
  }
  for (const team of teams) {
    const gate = await resolveTeamEnterpriseFeatureGate(team.id, feature);
    if (gate.ok) return { ok: true };
  }
  return { ok: false, reason: "ENTERPRISE_FEATURE_REQUIRED", statusCode: 402 };
}

/**
 * Resolves the SAML connection's owning team and gates that team on
 * the `ssoScim` Enterprise feature. Returns the structured deny shape
 * the route layer surfaces to the operator.
 */
export async function resolveSamlConnectionEnterpriseGate(
  connectionId: string,
): Promise<TeamGateResult> {
  const conn = await prisma.ssoConnection.findUnique({
    where: { id: connectionId },
    select: { teamId: true },
  });
  if (!conn) {
    return {
      ok: false,
      reason: "saml_connection_not_found",
      statusCode: 404,
    };
  }
  return resolveTeamEnterpriseFeatureGate(conn.teamId, "ssoScim");
}
