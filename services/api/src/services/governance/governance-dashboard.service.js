/**
 * PROOVRA Phase 4A — Governance dashboard aggregator.
 *
 * Bounded executive view of compliance / access reviews / delegated
 * admin / departments / cross-org / policy violations / audit health
 * / security health / trust health.
 */
import { DELEGATED_ADMIN_TIERS, GOVERNANCE_DASHBOARD_SCHEMA_VERSION, GOVERNANCE_POLICY_KINDS, TRUST_AND_GOVERNANCE_LIMITATIONS, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
export async function projectGovernanceDashboard(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // Policy compliance.
    const policyRows = await prisma.governancePolicy
        .findMany({
        where: { teamId: input.teamId },
        select: { kind: true, state: true },
    })
        .catch(() => []);
    const policiesPerKind = {};
    for (const k of GOVERNANCE_POLICY_KINDS) {
        policiesPerKind[k] = 0;
    }
    let policiesActive = 0;
    let policiesDraft = 0;
    let policiesDeprecated = 0;
    for (const p of policyRows) {
        policiesPerKind[p.kind] =
            (policiesPerKind[p.kind] ?? 0) + 1;
        if (p.state === "ACTIVE")
            policiesActive += 1;
        if (p.state === "DRAFT")
            policiesDraft += 1;
        if (p.state === "DEPRECATED")
            policiesDeprecated += 1;
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
        .catch(() => []);
    const totalCampaigns = campaignRows.length;
    let openCampaigns = 0;
    let pendingItems = 0;
    let approvedItems = 0;
    let revokedItems = 0;
    let escalatedItems = 0;
    for (const c of campaignRows) {
        if (c.state === "OPEN")
            openCampaigns += 1;
        for (const it of c.items) {
            if (it.decision === "PENDING")
                pendingItems += 1;
            else if (it.decision === "APPROVED")
                approvedItems += 1;
            else if (it.decision === "REVOKED")
                revokedItems += 1;
            else if (it.decision === "ESCALATED")
                escalatedItems += 1;
        }
    }
    // Delegated admin.
    const grantRows = await prisma.delegatedAdminGrant
        .findMany({
        where: { teamId: input.teamId },
        select: { tier: true, state: true, revokedAtUtc: true },
    })
        .catch(() => []);
    const grantsPerTier = {};
    for (const t of DELEGATED_ADMIN_TIERS) {
        grantsPerTier[t] = 0;
    }
    let activeGrants = 0;
    let revokedLast30d = 0;
    for (const g of grantRows) {
        if (g.state === "ACTIVE") {
            activeGrants += 1;
            grantsPerTier[g.tier] =
                (grantsPerTier[g.tier] ?? 0) + 1;
        }
        if (g.state === "REVOKED" &&
            g.revokedAtUtc &&
            g.revokedAtUtc.getTime() >= since30d.getTime()) {
            revokedLast30d += 1;
        }
    }
    // Departments.
    const departments = await prisma.department
        .count({
        where: { teamId: input.teamId, state: "ACTIVE" },
    })
        .catch(() => 0);
    // Cross-org.
    const crossOrgActive = await prisma.crossOrgReviewGrant
        .count({
        where: { teamId: input.teamId, state: "ACCEPTED" },
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
    const publishedByKind = {
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
        .catch(() => []);
    for (const r of trustRows) {
        publishedByKind[r.kind] = (publishedByKind[r.kind] ?? 0) + 1;
    }
    const activeSubprocessors = await prisma.subprocessor
        .count({ where: { teamId: input.teamId, state: "ACTIVE" } })
        .catch(() => 0);
    // Security health — real signals where available.
    // mfaCoveragePct: fraction of workspace members with at least one
    // ACTIVE MfaFactor. Uses TeamMember (the schema model) not TeamMembership.
    const [totalUsers, usersWithMfa] = await Promise.all([
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
            .catch(() => []),
    ]);
    const usersWithMfaCount = Array.isArray(usersWithMfa) ? usersWithMfa.length : 0;
    const mfaCoveragePct = totalUsers > 0
        ? Math.round((usersWithMfaCount / totalUsers) * 100)
        : 0;
    // samlEnabled: no SamlConnection model in current schema. Bounded honest.
    const samlEnabled = false;
    // scimEnabled: no SCIM endpoint in current codebase. Bounded honest.
    const scimEnabled = false;
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
