/**
 * PROOVRA Phase 4A — Governance dashboard aggregator.
 *
 * Bounded executive view of compliance / access reviews / delegated
 * admin / departments / cross-org / policy violations / audit health
 * / security health / trust health.
 */

import type { PrismaClient } from "@prisma/client";
import {
  DELEGATED_ADMIN_TIERS,
  GOVERNANCE_DASHBOARD_SCHEMA_VERSION,
  GOVERNANCE_POLICY_KINDS,
  TRUST_AND_GOVERNANCE_LIMITATIONS,
  type DelegatedAdminTier,
  type GovernanceDashboardProjection,
  type GovernancePolicyKind,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { organizationIdForPolicy } from "../identity/org-security-policy.service.js";

export async function projectGovernanceDashboard(input: {
  prisma?: PrismaClient;
  teamId: string;
}): Promise<GovernanceDashboardProjection> {
  const prisma = input.prisma ?? defaultPrisma;
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Policy compliance.
  const policyRows = await prisma.governancePolicy
    .findMany({
      where: { teamId: input.teamId },
      select: { kind: true, state: true },
    })
    .catch(() => [] as Array<{ kind: string; state: string }>);
  const policiesPerKind = {} as Record<GovernancePolicyKind, number>;
  for (const k of GOVERNANCE_POLICY_KINDS) {
    policiesPerKind[k] = 0;
  }
  let policiesActive = 0;
  let policiesDraft = 0;
  let policiesDeprecated = 0;
  for (const p of policyRows) {
    policiesPerKind[p.kind as GovernancePolicyKind] =
      (policiesPerKind[p.kind as GovernancePolicyKind] ?? 0) + 1;
    if (p.state === "ACTIVE") policiesActive += 1;
    if (p.state === "DRAFT") policiesDraft += 1;
    if (p.state === "DEPRECATED") policiesDeprecated += 1;
  }

  // Access reviews.
  const campaignRows = await prisma.accessReviewCampaign
    .findMany({
      where: { teamId: input.teamId },
      select: {
        state: true,
        items: { select: { decision: true } },
      },
    })
    .catch(() => [] as Array<{
      state: string;
      items: Array<{ decision: string }>;
    }>);
  const totalCampaigns = campaignRows.length;
  let openCampaigns = 0;
  let pendingItems = 0;
  let approvedItems = 0;
  let revokedItems = 0;
  let escalatedItems = 0;
  for (const c of campaignRows) {
    if (c.state === "OPEN") openCampaigns += 1;
    for (const it of c.items) {
      if (it.decision === "PENDING") pendingItems += 1;
      else if (it.decision === "APPROVED") approvedItems += 1;
      else if (it.decision === "REVOKED") revokedItems += 1;
      else if (it.decision === "ESCALATED") escalatedItems += 1;
    }
  }

  // Delegated admin.
  const grantRows = await prisma.delegatedAdminGrant
    .findMany({
      where: { teamId: input.teamId },
      select: { tier: true, state: true, revokedAtUtc: true },
    })
    .catch(() => [] as Array<{ tier: string; state: string; revokedAtUtc: Date | null }>);
  const grantsPerTier = {} as Record<DelegatedAdminTier, number>;
  for (const t of DELEGATED_ADMIN_TIERS) {
    grantsPerTier[t] = 0;
  }
  let activeGrants = 0;
  let revokedLast30d = 0;
  for (const g of grantRows) {
    if (g.state === "ACTIVE") {
      activeGrants += 1;
      grantsPerTier[g.tier as DelegatedAdminTier] =
        (grantsPerTier[g.tier as DelegatedAdminTier] ?? 0) + 1;
    }
    if (
      g.state === "REVOKED" &&
      g.revokedAtUtc &&
      g.revokedAtUtc.getTime() >= since30d.getTime()
    ) {
      revokedLast30d += 1;
    }
  }

  // Departments.
  const departments = await prisma.department
    .count({
      where: { teamId: input.teamId, state: "ACTIVE" },
    })
    .catch(() => 0);
  const crossOrgPending = await prisma.crossOrgReviewGrant
    .count({
      where: { teamId: input.teamId, state: "INVITED" },
    })
    .catch(() => 0);

  // Policy violations (audit codes that imply enforcement).
  const violations30d = await prisma.governancePolicyAudit
    .count({
      where: {
        teamId: input.teamId,
        occurredAtUtc: { gte: since30d },
        code: { in: ["POLICY_VIOLATION", "POLICY_BLOCK"] },
      },
    })
    .catch(() => 0);
  const blocking30d = await prisma.governancePolicyAudit
    .count({
      where: {
        teamId: input.teamId,
        occurredAtUtc: { gte: since30d },
        code: "POLICY_BLOCK",
      },
    })
    .catch(() => 0);

  // Audit health from the intelligence_activity_events store
  // (cross-domain lifecycle audit).
  const activity24h = await prisma.intelligenceActivityEvent
    .count({
      where: { teamId: input.teamId, occurredAtUtc: { gte: since24h } },
    })
    .catch(() => 0);
  const activity30d = await prisma.intelligenceActivityEvent
    .count({
      where: { teamId: input.teamId, occurredAtUtc: { gte: since30d } },
    })
    .catch(() => 0);

  // Trust health (article counts).
  const publishedByKind: Record<string, number> = {
    TRUST_CENTER: 0,
    METHODOLOGY: 0,
    AI_DISCLOSURE: 0,
    SECURITY: 0,
  };
  const trustRows = await prisma.trustCenterArticle
    .findMany({
      where: { teamId: input.teamId, state: "PUBLISHED" },
      select: { kind: true },
    })
    .catch(() => [] as Array<{ kind: string }>);
  for (const r of trustRows) {
    publishedByKind[r.kind] = (publishedByKind[r.kind] ?? 0) + 1;
  }
  const activeSubprocessors = await prisma.subprocessor
    .count({ where: { teamId: input.teamId, state: "ACTIVE" } })
    .catch(() => 0);

  // Security health — real signals where available.
  // mfaCoveragePct: fraction of workspace members with at least one
  // ACTIVE MfaFactor. Uses TeamMember (the schema model) not TeamMembership.
  const [
    totalUsers,
    usersWithMfa,
    activeSsoConnections,
    activeScimTokens,
    orgSecurityPolicy,
  ] = await Promise.all([
    prisma.teamMember
      .count({ where: { teamId: input.teamId } })
      .catch(() => 0),
    prisma.mfaFactor
      .findMany({
        where: {
          status: "ACTIVE",
          user: { teamMembers: { some: { teamId: input.teamId } } },
        },
        distinct: ["userId"],
        select: { userId: true },
      })
      .catch(() => [] as Array<{ userId: string }>),
    prisma.ssoConnection
      .count({
        where: {
          teamId: input.teamId,
          status: { notIn: ["DISABLED", "REVOKED", "PENDING"] },
        },
      })
      .catch(() => 0),
    prisma.scimProvisioningToken
      .count({
        where: {
          teamId: input.teamId,
          status: "ACTIVE",
        },
      })
      .catch(() => 0),
    // §1.1 — resolve the parent CUSTOMER org, then read the ONE policy by
    // AUTHORITATIVE organizationId (never teamId). Display-only readiness flags.
    (async () => {
      const orgId = await organizationIdForPolicy(input.teamId, prisma);
      return orgId
        ? prisma.organizationSecurityPolicy.findUnique({
            where: { organizationId: orgId },
            select: { ssoReadyFlag: true, scimReadyFlag: true },
          })
        : null;
    })().catch(() => null),
  ]);
  const usersWithMfaCount = Array.isArray(usersWithMfa) ? usersWithMfa.length : 0;
  const mfaCoveragePct = totalUsers > 0
    ? Math.round((usersWithMfaCount / totalUsers) * 100)
    : 0;
  const samlEnabled =
    activeSsoConnections > 0 || orgSecurityPolicy?.ssoReadyFlag === true;
  const scimEnabled =
    activeScimTokens > 0 || orgSecurityPolicy?.scimReadyFlag === true;

  // policyViolations: real counts from intelligenceActivityEvent where code
  // IN ('POLICY_VIOLATION','POLICY_BLOCK') — these are also written by the
  // governance policy audit. The governancePolicyAudit table is already
  // queried above (violations30d / blocking30d). Overlay with activity events
  // for a broader signal that captures trust + delegated-tier violations too.
  //
  // Phase 4A Final Closure: the new runtime gates (gateSecurityAction,
  // gateRetentionAction, gateReviewDecision, gateVerificationAction,
  // gateRedactionAction) all route through the policy evaluators which
  // emit POLICY_VIOLATION / POLICY_BLOCK codes into
  // intelligenceActivityEvent. No counter change needed here — those
  // codes land in the same table and are already included in the count
  // below. The dashboard will therefore reflect real gate activity from
  // the new auth / evidence / reviewer / verification / redaction
  // code paths as soon as ENFORCE mode is activated.
  const actViolations30d = await prisma.intelligenceActivityEvent
    .count({
      where: {
        teamId: input.teamId,
        occurredAtUtc: { gte: since30d },
        code: { in: ["POLICY_VIOLATION", "POLICY_BLOCK"] },
      },
    })
    .catch(() => 0);
  const totalViolations30d = violations30d + actViolations30d;

  // departments.reviewers: count of active DepartmentMembership rows
  // in this workspace.
  const departmentMembershipCount = await prisma.departmentMembership
    .count({ where: { teamId: input.teamId, state: "ACTIVE" } })
    .catch(() => 0);

  // crossOrg.activeGrants: filter to grants where externalReviewGrantId
  // IS NOT NULL (portal-backed grants).
  const crossOrgPortalBacked = await prisma.crossOrgReviewGrant
    .count({
      where: {
        teamId: input.teamId,
        state: "ACCEPTED",
        externalReviewGrantId: { not: null },
      },
    })
    .catch(() => 0);

  return {
    schemaVersion: GOVERNANCE_DASHBOARD_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    teamId: input.teamId,
    compliance: {
      policyCount: policyRows.length,
      policiesActive,
      policiesDraft,
      policiesDeprecated,
      policiesPerKind,
    },
    accessReviews: {
      totalCampaigns,
      openCampaigns,
      pendingItems,
      approvedItems,
      revokedItems,
      escalatedItems,
    },
    delegatedAdminActivity: {
      activeGrants,
      revokedLast30d,
      grantsPerTier,
    },
    departments: {
      total: departments,
      // No Department→Workspace FK in schema — bounded honest 0.
      workspaces: 0,
      reviewers: departmentMembershipCount,
    },
    crossOrg: {
      activeGrants: crossOrgPortalBacked,
      pendingInvitations: crossOrgPending,
    },
    policyViolations: {
      totalLast30d: totalViolations30d,
      blockingLast30d: blocking30d,
    },
    auditHealth: {
      activityEventsLast24h: activity24h,
      activityEventsLast30d: activity30d,
    },
    securityHealth: {
      mfaCoveragePct,
      samlEnabled,
      scimEnabled,
    },
    trustHealth: {
      publishedTrustArticles: publishedByKind["TRUST_CENTER"] ?? 0,
      publishedMethodologyArticles: publishedByKind["METHODOLOGY"] ?? 0,
      publishedAiDisclosureArticles: publishedByKind["AI_DISCLOSURE"] ?? 0,
      publishedSecurityArticles: publishedByKind["SECURITY"] ?? 0,
      activeSubprocessors,
    },
    limitations: TRUST_AND_GOVERNANCE_LIMITATIONS,
  };
}
