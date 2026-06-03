/**
 * PROOVRA Phase 3A Elite Closure — Prisma-backed policy store.
 *
 * Real persistence layer for the Redaction Policy Engine. Replaces
 * the Phase 3A Closure in-memory cache. Provides:
 *
 *   * `createPolicy` / `archivePolicy`
 *   * `createPolicyVersion` (append-only ordinal)
 *   * `transitionPolicyVersion` (bounded state machine driven by
 *     REDACTION_POLICY_VERSION_TRANSITIONS)
 *   * `assignPolicyVersion` / `revokePolicyAssignment`
 *   * `listPolicies` + `listPolicyVersions` + `listAssignmentsForScope`
 *   * `resolveEffectivePolicy` — bounded inheritance resolver
 *     (GLOBAL → WORKSPACE → CASE → PROJECT with deterministic
 *     precedence).
 *   * `appendPolicyAudit` — bounded audit emitter shared by every
 *     transition.
 *
 * Hard rules:
 *   * Workspace-anchored at every entry point.
 *   * Append-only versions; PUBLISH atomically supersedes the prior
 *     PUBLISHED row inside a `$transaction`.
 *   * Policy publication requires DRAFT → IN_REVIEW → APPROVED →
 *     PUBLISHED with separation of duties enforced server-side.
 *   * NEVER default-deny: missing provider/kind entries mean
 *     enabled. The orchestrator's `isPolicyAllowed` reads the
 *     resolved effective policy and refuses ONLY when an explicit
 *     `false` is recorded.
 */
import { POLICY_ASSIGNMENT_PRECEDENCE, POLICY_ASSIGNMENT_SCOPES, POLICY_DETECTION_RULE_ACTIONS, REDACTION_POLICY_ACTIVITY_CODES, REDACTION_POLICY_DOCUMENT_SCHEMA_VERSION, REDACTION_POLICY_VERSION_STATES, REDACTION_POLICY_VERSION_TRANSITIONS, isAllowedPolicyVersionTransition, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
// ---------------------------------------------------------------------------
// Internal — document normalisation + validation
// ---------------------------------------------------------------------------
function normaliseDocument(doc) {
    const customRules = (doc.customRules ?? []).filter(isValidCustomRule).slice(0, 200);
    const ruleActions = {};
    for (const [k, v] of Object.entries(doc.ruleActions ?? {})) {
        if (POLICY_DETECTION_RULE_ACTIONS.includes(v)) {
            ruleActions[k] =
                v;
        }
    }
    return {
        schemaVersion: REDACTION_POLICY_DOCUMENT_SCHEMA_VERSION,
        providers: doc.providers ?? {},
        kinds: doc.kinds ?? {},
        ruleActions,
        customRules,
    };
}
function isValidCustomRule(r) {
    if (!r || typeof r !== "object")
        return false;
    if (!r.name || r.name.length > 80)
        return false;
    if (!r.pattern || r.pattern.length > 400)
        return false;
    if (typeof r.rawConfidence !== "number" || r.rawConfidence < 0 || r.rawConfidence > 1) {
        return false;
    }
    if (!POLICY_DETECTION_RULE_ACTIONS.includes(r.action)) {
        return false;
    }
    if (r.flags && /[^imsu]/.test(r.flags))
        return false;
    try {
        new RegExp(r.pattern, r.flags ?? "");
    }
    catch {
        return false;
    }
    return true;
}
// ---------------------------------------------------------------------------
// Policy CRUD
// ---------------------------------------------------------------------------
export async function createPolicy(input) {
    const prisma = input.prisma ?? defaultPrisma;
    if (!input.name || input.name.length > 180) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    try {
        const created = await prisma.redactionPolicy.create({
            data: {
                teamId: input.teamId,
                name: input.name.trim(),
                description: input.description?.slice(0, 600) ?? null,
                createdByUserId: input.createdByUserId,
            },
            select: { id: true },
        });
        await appendPolicyAudit({
            prisma,
            teamId: input.teamId,
            policyId: created.id,
            code: "POLICY_CREATED",
            actorUserId: input.createdByUserId,
            payload: { name: input.name },
        });
        return { ok: true, policyId: created.id };
    }
    catch {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
}
export async function archivePolicy(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const updated = await prisma.redactionPolicy.updateMany({
        where: { id: input.policyId, teamId: input.teamId, archivedAt: null },
        data: { archivedAt: new Date() },
    });
    if (updated.count === 0) {
        return { ok: false, denial: "PROJECT_NOT_FOUND" };
    }
    await appendPolicyAudit({
        prisma,
        teamId: input.teamId,
        policyId: input.policyId,
        code: "POLICY_ARCHIVED",
        actorUserId: input.actorUserId,
    });
    return { ok: true };
}
// ---------------------------------------------------------------------------
// Policy versions
// ---------------------------------------------------------------------------
export async function createPolicyVersion(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const policy = await prisma.redactionPolicy.findFirst({
        where: { id: input.policyId, teamId: input.teamId, archivedAt: null },
        select: { id: true },
    });
    if (!policy)
        return { ok: false, denial: "PROJECT_NOT_FOUND" };
    const doc = normaliseDocument(input.document);
    const previous = await prisma.redactionPolicyVersion.findFirst({
        where: { policyId: input.policyId },
        orderBy: { versionOrdinal: "desc" },
        select: { versionOrdinal: true },
    });
    const next = (previous?.versionOrdinal ?? 0) + 1;
    const created = await prisma.redactionPolicyVersion.create({
        data: {
            policyId: input.policyId,
            teamId: input.teamId,
            versionOrdinal: next,
            state: "DRAFT",
            rationale: input.rationale?.slice(0, 600) ?? null,
            providers: doc.providers,
            kinds: doc.kinds,
            ruleActions: doc.ruleActions,
            customRules: doc.customRules,
            authoredByUserId: input.authoredByUserId,
        },
        select: { id: true, versionOrdinal: true },
    });
    await appendPolicyAudit({
        prisma,
        teamId: input.teamId,
        policyId: input.policyId,
        policyVersionId: created.id,
        code: "POLICY_VERSION_CREATED",
        actorUserId: input.authoredByUserId,
        payload: { versionOrdinal: created.versionOrdinal },
    });
    return {
        ok: true,
        policyVersionId: created.id,
        versionOrdinal: created.versionOrdinal,
    };
}
export async function transitionPolicyVersion(input) {
    const prisma = input.prisma ?? defaultPrisma;
    if (!REDACTION_POLICY_VERSION_STATES.includes(input.toState)) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    const version = await prisma.redactionPolicyVersion.findFirst({
        where: { id: input.policyVersionId, teamId: input.teamId },
        select: {
            id: true,
            state: true,
            policyId: true,
            authoredByUserId: true,
        },
    });
    if (!version)
        return { ok: false, denial: "VERSION_NOT_FOUND" };
    const from = version.state;
    if (!isAllowedPolicyVersionTransition(from, input.toState)) {
        return { ok: false, denial: "INVALID_TRANSITION" };
    }
    // Server-side separation of duties — the approver cannot be the
    // author. Bounded by REDACTION_POLICY_VERSION_TRANSITIONS — APPROVE
    // path (IN_REVIEW → APPROVED) and PUBLISH path (APPROVED →
    // PUBLISHED) both enforce this.
    if ((input.toState === "APPROVED" || input.toState === "PUBLISHED") &&
        version.authoredByUserId === input.actorUserId) {
        return { ok: false, denial: "NOT_PERMITTED" };
    }
    const now = new Date();
    const patch = { state: input.toState };
    if (input.toState === "IN_REVIEW")
        patch.submittedAtUtc = now;
    if (input.toState === "APPROVED") {
        patch.approvedAtUtc = now;
        patch.approvedByUserId = input.actorUserId;
    }
    if (input.toState === "PUBLISHED")
        patch.publishedAtUtc = now;
    if (input.toState === "SUPERSEDED")
        patch.supersededAtUtc = now;
    await prisma.$transaction(async (tx) => {
        if (input.toState === "PUBLISHED") {
            // Stamp prior PUBLISHED versions of the same policy as SUPERSEDED.
            await tx.redactionPolicyVersion.updateMany({
                where: {
                    teamId: input.teamId,
                    policyId: version.policyId,
                    state: "PUBLISHED",
                    NOT: { id: input.policyVersionId },
                },
                data: { state: "SUPERSEDED", supersededAtUtc: now },
            });
        }
        await tx.redactionPolicyVersion.update({
            where: { id: input.policyVersionId },
            data: patch,
        });
    });
    const code = input.toState === "IN_REVIEW"
        ? "POLICY_VERSION_SUBMITTED"
        : input.toState === "APPROVED"
            ? "POLICY_VERSION_APPROVED"
            : input.toState === "REJECTED"
                ? "POLICY_VERSION_REJECTED"
                : input.toState === "PUBLISHED"
                    ? "POLICY_VERSION_PUBLISHED"
                    : input.toState === "SUPERSEDED"
                        ? "POLICY_VERSION_SUPERSEDED"
                        : input.toState === "ROLLED_BACK"
                            ? "POLICY_VERSION_ROLLED_BACK"
                            : "POLICY_VERSION_CREATED";
    await appendPolicyAudit({
        prisma,
        teamId: input.teamId,
        policyId: version.policyId,
        policyVersionId: input.policyVersionId,
        code,
        actorUserId: input.actorUserId,
        payload: { from, to: input.toState },
    });
    return { ok: true, from, to: input.toState };
}
// ---------------------------------------------------------------------------
// Policy assignments
// ---------------------------------------------------------------------------
export async function assignPolicyVersion(input) {
    const prisma = input.prisma ?? defaultPrisma;
    if (!POLICY_ASSIGNMENT_SCOPES.includes(input.scope)) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    const version = await prisma.redactionPolicyVersion.findFirst({
        where: { id: input.policyVersionId, teamId: input.teamId },
        select: { id: true, policyId: true, state: true },
    });
    if (!version)
        return { ok: false, denial: "VERSION_NOT_FOUND" };
    if (version.state !== "PUBLISHED") {
        return { ok: false, denial: "INVALID_TRANSITION" };
    }
    if (input.scope === "GLOBAL" && input.scopeTargetId !== null) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    if (input.scope !== "GLOBAL" && !input.scopeTargetId) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    const created = await prisma.redactionPolicyAssignment.create({
        data: {
            teamId: input.teamId,
            policyId: version.policyId,
            policyVersionId: input.policyVersionId,
            scope: input.scope,
            scopeTargetId: input.scopeTargetId,
            rationale: input.rationale?.slice(0, 600) ?? null,
            assignedByUserId: input.assignedByUserId,
        },
        select: { id: true },
    });
    await appendPolicyAudit({
        prisma,
        teamId: input.teamId,
        policyId: version.policyId,
        policyVersionId: input.policyVersionId,
        code: "POLICY_ASSIGNMENT_CREATED",
        actorUserId: input.assignedByUserId,
        payload: {
            scope: input.scope,
            scopeTargetId: input.scopeTargetId,
            assignmentId: created.id,
        },
    });
    return { ok: true, assignmentId: created.id };
}
export async function revokePolicyAssignment(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const assignment = await prisma.redactionPolicyAssignment.findFirst({
        where: {
            id: input.assignmentId,
            teamId: input.teamId,
            revokedAtUtc: null,
        },
        select: { id: true, policyId: true, policyVersionId: true },
    });
    if (!assignment)
        return { ok: false, denial: "PROJECT_NOT_FOUND" };
    await prisma.redactionPolicyAssignment.update({
        where: { id: input.assignmentId },
        data: { revokedAtUtc: new Date() },
    });
    await appendPolicyAudit({
        prisma,
        teamId: input.teamId,
        policyId: assignment.policyId,
        policyVersionId: assignment.policyVersionId,
        code: "POLICY_ASSIGNMENT_REVOKED",
        actorUserId: input.actorUserId,
        payload: { assignmentId: input.assignmentId },
    });
    return { ok: true };
}
// ---------------------------------------------------------------------------
// Reads + projection
// ---------------------------------------------------------------------------
export async function listPolicies(input) {
    const prisma = input.prisma ?? defaultPrisma;
    return prisma.redactionPolicy.findMany({
        where: { teamId: input.teamId, archivedAt: null },
        orderBy: { createdAt: "desc" },
    });
}
export async function listPolicyVersions(input) {
    const prisma = input.prisma ?? defaultPrisma;
    return prisma.redactionPolicyVersion.findMany({
        where: { teamId: input.teamId, policyId: input.policyId },
        orderBy: { versionOrdinal: "desc" },
    });
}
export async function listAssignmentsForScope(input) {
    const prisma = input.prisma ?? defaultPrisma;
    return prisma.redactionPolicyAssignment.findMany({
        where: {
            teamId: input.teamId,
            scope: input.scope,
            scopeTargetId: input.scopeTargetId,
            revokedAtUtc: null,
        },
        orderBy: { assignedAtUtc: "desc" },
    });
}
export async function listAuditForPolicy(input) {
    const prisma = input.prisma ?? defaultPrisma;
    return prisma.redactionPolicyAudit.findMany({
        where: { teamId: input.teamId, policyId: input.policyId },
        orderBy: { occurredAtUtc: "desc" },
        take: Math.min(input.limit ?? 200, 500),
    });
}
// ---------------------------------------------------------------------------
// Inheritance resolver — GLOBAL → WORKSPACE → CASE → PROJECT
// ---------------------------------------------------------------------------
export async function resolveEffectivePolicy(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const targets = [
        { scope: "GLOBAL", scopeTargetId: null },
        { scope: "WORKSPACE", scopeTargetId: input.teamId },
    ];
    if (input.caseId)
        targets.push({ scope: "CASE", scopeTargetId: input.caseId });
    if (input.projectId) {
        targets.push({ scope: "PROJECT", scopeTargetId: input.projectId });
    }
    // Fetch every live assignment for the candidate scopes in one round trip.
    const assignments = await prisma.redactionPolicyAssignment.findMany({
        where: {
            teamId: input.teamId,
            revokedAtUtc: null,
            OR: targets.map((t) => ({
                scope: t.scope,
                scopeTargetId: t.scopeTargetId,
            })),
        },
        include: {
            policyVersion: {
                select: {
                    id: true,
                    versionOrdinal: true,
                    state: true,
                    providers: true,
                    kinds: true,
                    ruleActions: true,
                    customRules: true,
                },
            },
            policy: { select: { id: true } },
        },
    });
    // Order by precedence ascending (GLOBAL → WORKSPACE → CASE →
    // PROJECT) so higher-precedence overwrites.
    assignments.sort((a, b) => POLICY_ASSIGNMENT_PRECEDENCE[a.scope] -
        POLICY_ASSIGNMENT_PRECEDENCE[b.scope]);
    const providers = {
        MANUAL: true,
        REGEX_PII: true,
        POLICY_RULE: true,
        AWS_REKOGNITION_FACES: true,
        AWS_REKOGNITION_TEXT: true,
        AZURE_DOCUMENT_INTELLIGENCE: true,
        OCR_TEXT_LAYER: true,
        DEEPGRAM_TRANSCRIPT: true,
        CUSTOM_PROVIDER: true,
    };
    const kinds = {};
    const ruleActions = {};
    const customRules = [];
    const resolution = [];
    for (const a of assignments) {
        if (a.policyVersion.state !== "PUBLISHED")
            continue;
        const pv = a.policyVersion;
        const docProviders = (pv.providers ?? {});
        for (const [k, v] of Object.entries(docProviders)) {
            if (typeof v === "boolean") {
                providers[k] = v;
            }
        }
        const docKinds = (pv.kinds ?? {});
        for (const [k, v] of Object.entries(docKinds)) {
            if (typeof v === "boolean") {
                kinds[k] = v;
            }
        }
        const docActions = (pv.ruleActions ?? {});
        for (const [k, v] of Object.entries(docActions)) {
            if (POLICY_DETECTION_RULE_ACTIONS.includes(v)) {
                ruleActions[k] =
                    v;
            }
        }
        // Custom rules are concatenated (higher-precedence scopes
        // append, never overwrite — bounded to 1000 across all
        // assignments).
        if (Array.isArray(pv.customRules)) {
            for (const r of pv.customRules) {
                if (customRules.length >= 1000)
                    break;
                customRules.push(r);
            }
        }
        resolution.push({
            scope: a.scope,
            scopeTargetId: a.scopeTargetId,
            policyId: a.policyId,
            policyVersionId: a.policyVersionId,
            versionOrdinal: pv.versionOrdinal,
        });
    }
    return {
        schemaVersion: REDACTION_POLICY_DOCUMENT_SCHEMA_VERSION,
        effectiveAtUtc: new Date().toISOString(),
        providers,
        kinds,
        ruleActions,
        customRules,
        resolution,
    };
}
// ---------------------------------------------------------------------------
// Bounded audit emitter
// ---------------------------------------------------------------------------
export async function appendPolicyAudit(input) {
    if (!REDACTION_POLICY_ACTIVITY_CODES.includes(input.code)) {
        throw new Error(`policy-audit: unknown code ${input.code}`);
    }
    const prisma = input.prisma ?? defaultPrisma;
    const row = await prisma.redactionPolicyAudit.create({
        data: {
            teamId: input.teamId,
            policyId: input.policyId,
            policyVersionId: input.policyVersionId ?? null,
            code: input.code,
            actorUserId: input.actorUserId ?? null,
            payload: (input.payload ?? null),
        },
        select: { id: true },
    });
    return { id: row.id };
}
// Compile-time guard.
function _assertVersionTransitionMapIsConsistent() {
    for (const s of REDACTION_POLICY_VERSION_STATES) {
        if (!Array.isArray(REDACTION_POLICY_VERSION_TRANSITIONS[s])) {
            throw new Error("REDACTION_POLICY_VERSION_TRANSITIONS shape changed");
        }
    }
}
void _assertVersionTransitionMapIsConsistent;
