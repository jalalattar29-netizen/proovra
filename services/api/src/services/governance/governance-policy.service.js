/**
 * PROOVRA Phase 4A — Governance policy service.
 *
 * Policy registry + assignment + inheritance + override + append-only
 * audit. Six policy kinds: SECURITY / REVIEW / RETENTION / REDACTION
 * / INTELLIGENCE / VERIFICATION.
 *
 * Hard rules:
 *   * Bounded rule shape — `rule` is JSON, kind-specific.
 *   * Bounded enforcement mode: BLOCK / WARN / AUDIT_ONLY.
 *   * Every policy mutation writes a governance_policy_audit row.
 *   * `resolveEffectivePolicies` walks the org → department →
 *     workspace inheritance chain, applying overrides in scope-narrowing
 *     order.
 */
import { GOVERNANCE_POLICY_ENFORCEMENT_MODES, GOVERNANCE_POLICY_KINDS, GOVERNANCE_POLICY_SCOPES, GOVERNANCE_POLICY_STATES, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
export async function createPolicy(input) {
    if (!GOVERNANCE_POLICY_KINDS.includes(input.kind)) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    if (!GOVERNANCE_POLICY_ENFORCEMENT_MODES.includes(input.enforcementMode)) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.slug)) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    const prisma = input.prisma ?? defaultPrisma;
    const policy = await prisma.governancePolicy.create({
        data: {
            teamId: input.teamId,
            kind: input.kind,
            slug: input.slug,
            name: input.name.slice(0, 200),
            summary: input.summary.slice(0, 600),
            state: input.state ?? "DRAFT",
            enforcementMode: input.enforcementMode,
            version: 1,
            rule: input.rule,
            createdByUserId: input.createdByUserId,
        },
        select: { id: true, version: true },
    });
    await emitPolicyAudit({
        prisma,
        teamId: input.teamId,
        policyId: policy.id,
        code: "POLICY_CREATED",
        actorUserId: input.createdByUserId,
        reason: `kind=${input.kind}; mode=${input.enforcementMode}`,
    });
    return { ok: true, policyId: policy.id, version: policy.version ?? 1 };
}
export async function activatePolicy(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const row = await prisma.governancePolicy.findFirst({
        where: { id: input.policyId, teamId: input.teamId },
    });
    if (!row)
        return { ok: false };
    await prisma.governancePolicy.update({
        where: { id: row.id },
        data: { state: "ACTIVE" },
    });
    await emitPolicyAudit({
        prisma,
        teamId: input.teamId,
        policyId: row.id,
        code: "POLICY_ACTIVATED",
        actorUserId: input.actorUserId,
        reason: null,
    });
    return { ok: true };
}
export async function deprecatePolicy(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const row = await prisma.governancePolicy.findFirst({
        where: { id: input.policyId, teamId: input.teamId },
    });
    if (!row)
        return { ok: false };
    await prisma.governancePolicy.update({
        where: { id: row.id },
        data: { state: "DEPRECATED" },
    });
    await emitPolicyAudit({
        prisma,
        teamId: input.teamId,
        policyId: row.id,
        code: "POLICY_DEPRECATED",
        actorUserId: input.actorUserId,
        reason: null,
    });
    return { ok: true };
}
export async function assignPolicy(input) {
    if (!GOVERNANCE_POLICY_SCOPES.includes(input.scope)) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    const prisma = input.prisma ?? defaultPrisma;
    const row = await prisma.governancePolicyAssignment.upsert({
        where: {
            policyId_scope_scopeTargetId: {
                policyId: input.policyId,
                scope: input.scope,
                scopeTargetId: input.scopeTargetId,
            },
        },
        create: {
            teamId: input.teamId,
            policyId: input.policyId,
            scope: input.scope,
            scopeTargetId: input.scopeTargetId,
            inheritFromParent: input.inheritFromParent ?? true,
            isOverride: input.isOverride ?? false,
            assignedByUserId: input.assignedByUserId,
        },
        update: {
            inheritFromParent: input.inheritFromParent ?? true,
            isOverride: input.isOverride ?? false,
            assignedByUserId: input.assignedByUserId,
        },
        select: { id: true },
    });
    await emitPolicyAudit({
        prisma,
        teamId: input.teamId,
        policyId: input.policyId,
        code: "POLICY_ASSIGNED",
        actorUserId: input.assignedByUserId,
        reason: `scope=${input.scope}; target=${input.scopeTargetId.slice(0, 8)}…; override=${input.isOverride ?? false}`,
    });
    return { ok: true, assignmentId: row.id };
}
// Phase 4A Final Closure — department scope note for listPolicies.
// GovernancePolicy rows are workspace-scoped (teamId) and do NOT carry
// a departmentId column in the current schema. Department filtering
// is therefore not applicable here; policies are visible to any
// authenticated workspace member with the appropriate delegated tier.
// If a departmentId is added to GovernancePolicy in a future migration,
// apply buildStrictDepartmentScopeWhere(envelope) and merge into the
// findMany where-clause above.
export async function listPolicies(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const rows = await prisma.governancePolicy.findMany({
        where: {
            teamId: input.teamId,
            ...(input.kind ? { kind: input.kind } : {}),
            ...(input.state ? { state: input.state } : {}),
        },
        orderBy: [{ kind: "asc" }, { name: "asc" }],
    });
    return rows.map((p) => ({
        id: p.id,
        kind: p.kind,
        // R7-governance: slug/summary are R7-additive nullable. Coalesce to "" for non-null projection
        // contract. Policy-evaluation engine reads the columns directly (not the projection).
        slug: p.slug ?? "",
        name: p.name,
        summary: p.summary ?? "",
        state: p.state,
        enforcementMode: p.enforcementMode,
        rule: p.rule ?? {},
        // R7-governance: version is R7-additive Int? with default 1; coalesce to 1 for non-null contract.
        version: p.version ?? 1,
        createdByUserId: p.createdByUserId ?? "",
        createdAtUtc: p.createdAt.toISOString(),
    }));
}
// Phase 4A Final Closure — department scope note for listPolicyAssignments.
// GovernancePolicyAssignment rows have a scopeTargetId that may reference
// a departmentId when scope === 'DEPARTMENT'. The findMany already filters
// by scopeTargetId when the caller passes one, so the caller controls
// department-scoped visibility. Full strict dept-scope enforcement
// (resolveUserDepartmentScope + buildStrictDepartmentScopeWhere) should
// be applied by the route layer when listing all assignments without an
// explicit scopeTargetId, to prevent cross-department policy leakage.
export async function listPolicyAssignments(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const rows = await prisma.governancePolicyAssignment.findMany({
        where: {
            teamId: input.teamId,
            ...(input.policyId ? { policyId: input.policyId } : {}),
            ...(input.scope ? { scope: input.scope } : {}),
            ...(input.scopeTargetId ? { scopeTargetId: input.scopeTargetId } : {}),
        },
        orderBy: { assignedAtUtc: "desc" },
        take: 500,
    });
    return rows.map((a) => ({
        id: a.id,
        policyId: a.policyId,
        // R7-governance: scope is R7-additive nullable; fall back to legacy scopeKind so enforcement
        // engine + dashboard always see a bounded scope kind.
        scope: (a.scope ?? a.scopeKind),
        // R7-governance: scopeTargetId may be null only for ORGANIZATION-wide assignments. Coalesce to ""
        // to satisfy the non-null projection contract (the ORGANIZATION scope explains the empty target).
        scopeTargetId: a.scopeTargetId ?? "",
        inheritFromParent: a.inheritFromParent,
        isOverride: a.isOverride,
        assignedByUserId: a.assignedByUserId ?? "",
        assignedAtUtc: a.assignedAtUtc.toISOString(),
    }));
}
export async function listPolicyAudit(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const rows = await prisma.governancePolicyAudit.findMany({
        where: {
            teamId: input.teamId,
            ...(input.policyId ? { policyId: input.policyId } : {}),
        },
        orderBy: { occurredAtUtc: "desc" },
        take: Math.min(input.limit ?? 200, 500),
    });
    return rows.map((r) => ({
        id: r.id,
        policyId: r.policyId,
        // R7-governance: code is R7-additive nullable; fall back to legacy `action` so audit federator
        // always emits a non-null event code. NO AUDIT EVENT LOST — every Phase 4A write supplies `code`;
        // legacy rows have `action` which the coalesce surfaces.
        code: r.code ?? r.action ?? "",
        actorUserId: r.actorUserId,
        reason: r.reason,
        occurredAtUtc: r.occurredAtUtc.toISOString(),
    }));
}
/**
 * Resolve the effective policies for a (org, dept, workspace) tuple.
 * Walks the inheritance chain: ORGANIZATION → DEPARTMENT → WORKSPACE.
 * If a narrower assignment carries `isOverride = true`, the parent's
 * rule is replaced for that policy kind+slug; otherwise both apply.
 */
export async function resolveEffectivePolicies(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const scopes = [];
    if (input.organizationId)
        scopes.push({ scope: "ORGANIZATION", id: input.organizationId });
    if (input.departmentId)
        scopes.push({ scope: "DEPARTMENT", id: input.departmentId });
    if (input.workspaceId)
        scopes.push({ scope: "WORKSPACE", id: input.workspaceId });
    if (scopes.length === 0)
        return [];
    const assignments = await prisma.governancePolicyAssignment.findMany({
        where: {
            teamId: input.teamId,
            OR: scopes.map((s) => ({ scope: s.scope, scopeTargetId: s.id })),
        },
        include: { policy: true },
    });
    // Build a per-(kind+slug) map; later (narrower) assignments win
    // when they're flagged `isOverride`.
    const ordered = [];
    for (const s of scopes) {
        ordered.push(...assignments.filter((a) => a.scope === s.scope && a.scopeTargetId === s.id));
    }
    const byKey = new Map();
    for (const a of ordered) {
        if (a.policy.state !== "ACTIVE")
            continue;
        if (input.kind && a.policy.kind !== input.kind)
            continue;
        const key = `${a.policy.kind}:${a.policy.slug}`;
        const proj = {
            id: a.policy.id,
            kind: a.policy.kind,
            // R7-governance: same coalesce pattern as listPolicies — non-null projection contract held.
            slug: a.policy.slug ?? "",
            name: a.policy.name,
            summary: a.policy.summary ?? "",
            state: a.policy.state,
            enforcementMode: a.policy.enforcementMode,
            rule: a.policy.rule ?? {},
            version: a.policy.version ?? 1,
            createdByUserId: a.policy.createdByUserId ?? "",
            createdAtUtc: a.policy.createdAt.toISOString(),
        };
        if (!byKey.has(key) || a.isOverride)
            byKey.set(key, proj);
    }
    return Array.from(byKey.values());
}
export async function emitPolicyAudit(input) {
    const prisma = input.prisma ?? defaultPrisma;
    try {
        await prisma.governancePolicyAudit.create({
            data: {
                teamId: input.teamId,
                policyId: input.policyId,
                code: input.code.slice(0, 60),
                actorUserId: input.actorUserId,
                reason: input.reason?.slice(0, 600) ?? null,
            },
        });
    }
    catch {
        /* swallow — audit must never block ops */
    }
}
// Compile-time guard.
function _assertEnumsIntact() {
    const _k = "SECURITY";
    void _k;
    void GOVERNANCE_POLICY_STATES;
}
void _assertEnumsIntact;
