/**
 * Phase 27 — Enterprise Retention Engine.
 *
 * First-class versioned retention policy CRUD with inheritance,
 * conflict resolution, and append-only history. Layered on top of the
 * Phase 14 governance.service.ts (which holds the workspace-default
 * retention-day columns) — Phase 27 adds the named, scoped, versioned
 * policy objects operators bind to evidence types / cases / regulatory
 * profiles.
 *
 * Hard rules:
 *   - Every mutation writes a new RetentionPolicyVersion row + bumps
 *     `currentVersion`. The previous version is immutable.
 *   - The resolver returns ONE effective policy per evidence according
 *     to the shared `RETENTION_PRECEDENCE_ORDER` (CASE > EVIDENCE_TYPE
 *     > REGULATORY > WORKSPACE).
 *   - SUPERSEDED / ARCHIVED policies are never removed — they remain
 *     for audit history. Only ACTIVE policies participate in the
 *     resolver.
 *   - Operator-readable display name + change note are required;
 *     legal text is not stored here (it stays in EvidenceLegalHold).
 */
import * as prismaPkg from "@prisma/client";
import { RETENTION_POLICY_SCOPES, RETENTION_POLICY_STATUSES, RetentionPolicyCreateInputSchema, RetentionPolicyUpdateInputSchema, isAllowedRetentionPolicyTransition, pickHighestPrecedencePolicy, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { resolveTeamRetentionPolicy } from "../organization/retention-inheritance.service.js";
// -----------------------------------------------------------------------------
// Error
// -----------------------------------------------------------------------------
export class RetentionEngineError extends Error {
    code;
    details;
    constructor(code, details) {
        super(code);
        this.code = code;
        this.details = details;
        this.name = "RetentionEngineError";
    }
}
export function projectPolicy(row) {
    return {
        id: row.id,
        teamId: row.teamId,
        displayName: row.displayName,
        description: row.description,
        status: row.status,
        scope: row.scope,
        scopeQualifier: row.scopeQualifier,
        caseId: row.caseId,
        retentionDays: row.retentionDays,
        immutable: row.immutable,
        autoExtensionEnabled: row.autoExtensionEnabled,
        autoExtensionDays: row.autoExtensionDays,
        supersededByPolicyId: row.supersededByPolicyId,
        currentVersion: row.currentVersion,
        createdByUserId: row.createdByUserId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        archivedAtUtc: row.archivedAtUtc?.toISOString() ?? null,
    };
}
const SCOPE_SET = new Set(RETENTION_POLICY_SCOPES);
const STATUS_SET = new Set(RETENTION_POLICY_STATUSES);
// -----------------------------------------------------------------------------
// Create
// -----------------------------------------------------------------------------
export async function createRetentionPolicy(input, client = defaultPrisma) {
    const parsed = RetentionPolicyCreateInputSchema.safeParse(input);
    if (!parsed.success) {
        throw new RetentionEngineError("RETENTION_POLICY_INVALID", {
            detail: parsed.error.flatten(),
        });
    }
    if (!SCOPE_SET.has(input.scope)) {
        throw new RetentionEngineError("RETENTION_POLICY_INVALID");
    }
    try {
        const row = await client.evidenceRetentionPolicy.create({
            data: {
                teamId: input.teamId,
                displayName: input.displayName.slice(0, 180),
                description: input.description?.slice(0, 2000) ?? null,
                status: "ACTIVE",
                scope: input.scope,
                scopeQualifier: input.scopeQualifier ?? null,
                caseId: input.caseId ?? null,
                retentionDays: input.retentionDays ?? null,
                immutable: input.immutable ?? false,
                autoExtensionEnabled: input.autoExtensionEnabled ?? false,
                autoExtensionDays: input.autoExtensionDays ?? null,
                currentVersion: 1,
                createdByUserId: input.actorUserId,
            },
        });
        // Seed version 1.
        await client.evidenceRetentionPolicyVersion.create({
            data: {
                retentionPolicyId: row.id,
                version: 1,
                retentionDays: row.retentionDays,
                immutable: row.immutable,
                autoExtensionEnabled: row.autoExtensionEnabled,
                autoExtensionDays: row.autoExtensionDays,
                diffJson: { initial: true },
                authoredByUserId: input.actorUserId,
                changeNote: input.changeNote?.slice(0, 2000) ?? "Initial policy",
            },
        });
        bump("retention_policy_created_total");
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "retention_policy_created",
            severity: "WARNING",
            details: {
                retentionPolicyId: row.id,
                scope: input.scope,
                retentionDays: input.retentionDays,
                immutable: input.immutable ?? false,
                actorUserId: input.actorUserId,
            },
        });
        await appendPlatformAuditLog({
            userId: input.actorUserId,
            action: "retention.policy.create",
            category: "governance",
            severity: "warning",
            source: "retention_engine",
            outcome: "success",
            resourceType: "evidence_retention_policy",
            resourceId: row.id,
            metadata: {
                teamId: input.teamId,
                scope: input.scope,
                retentionDays: input.retentionDays,
            },
            db: client,
        });
        return projectPolicy(row);
    }
    catch (err) {
        if (err instanceof prismaPkg.Prisma.PrismaClientKnownRequestError &&
            err.code === "P2002") {
            throw new RetentionEngineError("RETENTION_POLICY_DUPLICATE");
        }
        throw err;
    }
}
// -----------------------------------------------------------------------------
// Update (writes new version)
// -----------------------------------------------------------------------------
export async function updateRetentionPolicy(input, client = defaultPrisma) {
    const parsed = RetentionPolicyUpdateInputSchema.safeParse(input);
    if (!parsed.success) {
        throw new RetentionEngineError("RETENTION_POLICY_INVALID", {
            detail: parsed.error.flatten(),
        });
    }
    const existing = await client.evidenceRetentionPolicy.findFirst({
        where: { id: input.id, teamId: input.teamId },
    });
    if (!existing) {
        throw new RetentionEngineError("RETENTION_POLICY_NOT_FOUND");
    }
    if (existing.status === "ARCHIVED" || existing.status === "SUPERSEDED") {
        throw new RetentionEngineError("RETENTION_POLICY_TERMINAL", {
            status: existing.status,
        });
    }
    // Compute diff for the version row.
    const diff = {};
    if (input.retentionDays !== undefined &&
        input.retentionDays !== existing.retentionDays) {
        diff.retentionDays = {
            from: existing.retentionDays,
            to: input.retentionDays,
        };
    }
    if (input.immutable !== undefined &&
        input.immutable !== existing.immutable) {
        diff.immutable = { from: existing.immutable, to: input.immutable };
    }
    if (input.autoExtensionEnabled !== undefined &&
        input.autoExtensionEnabled !== existing.autoExtensionEnabled) {
        diff.autoExtensionEnabled = {
            from: existing.autoExtensionEnabled,
            to: input.autoExtensionEnabled,
        };
    }
    if (input.autoExtensionDays !== undefined &&
        input.autoExtensionDays !== existing.autoExtensionDays) {
        diff.autoExtensionDays = {
            from: existing.autoExtensionDays,
            to: input.autoExtensionDays,
        };
    }
    if (input.displayName !== undefined &&
        input.displayName !== existing.displayName) {
        diff.displayName = { from: existing.displayName, to: input.displayName };
    }
    if (Object.keys(diff).length === 0) {
        return projectPolicy(existing); // no-op
    }
    const nextVersion = existing.currentVersion + 1;
    const updated = await client.evidenceRetentionPolicy.update({
        where: { id: existing.id },
        data: {
            displayName: input.displayName?.slice(0, 180) ?? existing.displayName,
            description: input.description === undefined
                ? existing.description
                : input.description?.slice(0, 2000) ?? null,
            retentionDays: input.retentionDays === undefined
                ? existing.retentionDays
                : input.retentionDays,
            immutable: input.immutable ?? existing.immutable,
            autoExtensionEnabled: input.autoExtensionEnabled ?? existing.autoExtensionEnabled,
            autoExtensionDays: input.autoExtensionDays === undefined
                ? existing.autoExtensionDays
                : input.autoExtensionDays,
            currentVersion: nextVersion,
        },
    });
    await client.evidenceRetentionPolicyVersion.create({
        data: {
            retentionPolicyId: updated.id,
            version: nextVersion,
            retentionDays: updated.retentionDays,
            immutable: updated.immutable,
            autoExtensionEnabled: updated.autoExtensionEnabled,
            autoExtensionDays: updated.autoExtensionDays,
            diffJson: diff,
            authoredByUserId: input.actorUserId,
            changeNote: input.changeNote.slice(0, 2000),
        },
    });
    bump("retention_policy_updated_total");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "retention_policy_updated",
        severity: "WARNING",
        details: {
            retentionPolicyId: updated.id,
            version: nextVersion,
            diffKeys: Object.keys(diff),
            actorUserId: input.actorUserId,
        },
    });
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "retention.policy.update",
        category: "governance",
        severity: "warning",
        source: "retention_engine",
        outcome: "success",
        resourceType: "evidence_retention_policy",
        resourceId: updated.id,
        metadata: { teamId: input.teamId, version: nextVersion, diffKeys: Object.keys(diff) },
        db: client,
    });
    return projectPolicy(updated);
}
// -----------------------------------------------------------------------------
// Status transition (PAUSE / SUPERSEDE / ARCHIVE)
// -----------------------------------------------------------------------------
export async function transitionRetentionPolicy(input, client = defaultPrisma) {
    if (!STATUS_SET.has(input.nextStatus)) {
        throw new RetentionEngineError("RETENTION_POLICY_INVALID");
    }
    const existing = await client.evidenceRetentionPolicy.findFirst({
        where: { id: input.id, teamId: input.teamId },
    });
    if (!existing)
        throw new RetentionEngineError("RETENTION_POLICY_NOT_FOUND");
    if (!isAllowedRetentionPolicyTransition(existing.status, input.nextStatus)) {
        throw new RetentionEngineError("RETENTION_POLICY_INVALID_TRANSITION", {
            from: existing.status,
            to: input.nextStatus,
        });
    }
    const now = new Date();
    const updated = await client.evidenceRetentionPolicy.update({
        where: { id: existing.id },
        data: {
            status: input.nextStatus,
            supersededByPolicyId: input.nextStatus === "SUPERSEDED"
                ? input.supersededByPolicyId ?? null
                : existing.supersededByPolicyId,
            archivedAtUtc: input.nextStatus === "ARCHIVED" ? now : existing.archivedAtUtc,
        },
    });
    const nextVersion = existing.currentVersion + 1;
    await client.evidenceRetentionPolicy.update({
        where: { id: updated.id },
        data: { currentVersion: nextVersion },
    });
    await client.evidenceRetentionPolicyVersion.create({
        data: {
            retentionPolicyId: updated.id,
            version: nextVersion,
            retentionDays: updated.retentionDays,
            immutable: updated.immutable,
            autoExtensionEnabled: updated.autoExtensionEnabled,
            autoExtensionDays: updated.autoExtensionDays,
            diffJson: {
                statusTransition: { from: existing.status, to: input.nextStatus },
                supersededByPolicyId: input.supersededByPolicyId ?? null,
            },
            authoredByUserId: input.actorUserId,
            changeNote: input.changeNote.slice(0, 2000),
        },
    });
    if (input.nextStatus === "PAUSED")
        bump("retention_policy_updated_total");
    if (input.nextStatus === "SUPERSEDED")
        bump("retention_policy_superseded_total");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: input.nextStatus === "SUPERSEDED"
            ? "retention_policy_superseded"
            : input.nextStatus === "ARCHIVED"
                ? "retention_policy_archived"
                : input.nextStatus === "PAUSED"
                    ? "retention_policy_paused"
                    : "retention_policy_updated",
        severity: "WARNING",
        details: {
            retentionPolicyId: updated.id,
            from: existing.status,
            to: input.nextStatus,
            actorUserId: input.actorUserId,
        },
    });
    return projectPolicy(updated);
}
export async function listRetentionPolicies(input, client = defaultPrisma) {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const rows = await client.evidenceRetentionPolicy.findMany({
        where: {
            teamId: input.teamId,
            ...(input.status && input.status !== "ALL"
                ? { status: input.status }
                : {}),
            ...(input.scope ? { scope: input.scope } : {}),
        },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        take: limit,
    });
    return rows.map(projectPolicy);
}
export async function listPolicyVersions(input, client = defaultPrisma) {
    const policy = await client.evidenceRetentionPolicy.findFirst({
        where: { id: input.id, teamId: input.teamId },
        select: { id: true },
    });
    if (!policy)
        throw new RetentionEngineError("RETENTION_POLICY_NOT_FOUND");
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const versions = await client.evidenceRetentionPolicyVersion.findMany({
        where: { retentionPolicyId: policy.id },
        orderBy: { authoredAtUtc: "desc" },
        take: limit,
    });
    return versions.map((v) => ({
        version: v.version,
        retentionDays: v.retentionDays,
        immutable: v.immutable,
        diffJson: v.diffJson,
        authoredByUserId: v.authoredByUserId,
        changeNote: v.changeNote,
        authoredAtUtc: v.authoredAtUtc.toISOString(),
    }));
}
export async function resolveEffectiveRetentionPolicy(input, client = defaultPrisma) {
    const candidates = await client.evidenceRetentionPolicy.findMany({
        where: {
            teamId: input.teamId,
            status: "ACTIVE",
            OR: [
                { scope: "WORKSPACE" },
                input.evidenceType
                    ? {
                        scope: "EVIDENCE_TYPE",
                        scopeQualifier: input.evidenceType,
                    }
                    : { id: "__never__" }, // no-op
                input.jurisdiction
                    ? {
                        scope: "REGULATORY",
                        scopeQualifier: input.jurisdiction,
                    }
                    : { id: "__never__" },
                input.caseId
                    ? {
                        scope: "CASE",
                        caseId: input.caseId,
                    }
                    : { id: "__never__" },
            ],
        },
    });
    const conflicts = [];
    // -------------------------------------------------------------------
    // Phase G1 (B0.4) — no explicit policy → consult the Phase B0
    // inheritance resolver before declaring "no_active_policy". This is
    // the operational enforcement of the inheritance contract that B0
    // shipped as a UI-only display.
    // -------------------------------------------------------------------
    if (candidates.length === 0) {
        const inheritance = await resolveTeamRetentionPolicy(input.teamId, client);
        if (inheritance.source === "org_policy_inherited") {
            bump("retention_policy_inherited_total");
            return {
                policy: null,
                reason: "inherited_from_org",
                source: "org_policy_inherited",
                inheritedTemplate: {
                    organizationId: inheritance.organizationId,
                    retentionDays: inheritance.template.retentionDays,
                    immutable: inheritance.template.immutable,
                    description: inheritance.template.description,
                },
                conflicts,
            };
        }
        return {
            policy: null,
            reason: "no_active_policy",
            source: "none",
            conflicts,
        };
    }
    const projected = candidates.map(projectPolicy);
    const winner = pickHighestPrecedencePolicy(projected);
    if (!winner) {
        return {
            policy: null,
            reason: "no_winner",
            source: "none",
            conflicts,
        };
    }
    // Check for genuine conflict at the SAME scope (two ACTIVE policies
    // at the same scope is a config error worth surfacing).
    const sameScopeMatches = projected.filter((p) => p.scope === winner.scope && p.scopeQualifier === winner.scopeQualifier);
    if (sameScopeMatches.length > 1) {
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "retention_policy_updated",
            severity: "WARNING",
            details: {
                scope: winner.scope,
                conflictCount: sameScopeMatches.length,
            },
        });
        conflicts.push({
            code: "duplicate_same_scope",
            detail: `${sameScopeMatches.length} ACTIVE policies at scope ${winner.scope}${winner.scopeQualifier ? `/${winner.scopeQualifier}` : ""}`,
        });
    }
    // -------------------------------------------------------------------
    // Phase G1 (B0.4) — when a workspace-scoped policy exists, compare
    // it against the org template (if any). Operationally relevant
    // conflicts:
    //
    //   * workspace_overrides_immutable — the parent organization
    //     published an immutable template, and the workspace's local
    //     policy effectively bypasses it. The local policy is still
    //     served (the engine cannot retroactively delete operator
    //     intent), but the conflict is surfaced so governance admins
    //     can resolve it.
    //
    //   * workspace_weaker_than_inherited — the local policy's
    //     retention horizon is shorter than the inherited template.
    // -------------------------------------------------------------------
    if (winner.scope === "WORKSPACE") {
        const inheritance = await resolveTeamRetentionPolicy(input.teamId, client);
        if (inheritance.source === "org_policy_inherited") {
            const tmpl = inheritance.template;
            if (tmpl.immutable) {
                conflicts.push({
                    code: "workspace_overrides_immutable",
                    detail: "The parent organization template is marked immutable; the local workspace policy is currently active alongside it. Resolve at the organization level.",
                });
            }
            if (typeof tmpl.retentionDays === "number" &&
                typeof winner.retentionDays === "number" &&
                winner.retentionDays < tmpl.retentionDays) {
                conflicts.push({
                    code: "workspace_weaker_than_inherited",
                    detail: `Local workspace retention (${winner.retentionDays} days) is shorter than the inherited organization template (${tmpl.retentionDays} days).`,
                });
            }
        }
    }
    return {
        policy: winner,
        reason: `picked_${winner.scope.toLowerCase()}`,
        source: "team_policy",
        conflicts,
    };
}
// -----------------------------------------------------------------------------
// Conflict count — operator dashboard signal.
// -----------------------------------------------------------------------------
export async function countActivePolicyConflicts(teamId, client = defaultPrisma) {
    // A "conflict" is two ACTIVE policies covering the same (scope,
    // scopeQualifier, caseId) tuple. We compute by groupBy + count > 1.
    const rows = await client.evidenceRetentionPolicy.groupBy({
        by: ["teamId", "scope", "scopeQualifier", "caseId", "status"],
        where: { teamId, status: "ACTIVE" },
        _count: { _all: true },
    });
    return rows.filter((r) => r._count._all > 1).length;
}
