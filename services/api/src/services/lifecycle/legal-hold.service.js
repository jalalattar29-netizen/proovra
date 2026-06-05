/**
 * PROOVRA Phase 4B — Legal Hold service (canonical 4B implementation).
 *
 * Workspace-anchored preservation control over `legal_holds`. A legal
 * hold suspends destructive lifecycle transitions (DELETE / DESTROY /
 * ARCHIVE_RESTRICTED) on the scoped target until the hold is released.
 *
 * Supersedes the Phase 4A governance/case-legal-hold and
 * governance/legal-hold paths for the unified 4B model — the 4A
 * surface remains as a legacy case-only preservation primitive.
 *
 * Hard rules:
 *   * Workspace-anchored on every read + write path.
 *   * Bounded `LegalHoldKind` + `LegalHoldState` vocabularies.
 *   * Webhook fan-out is fire-and-forget — operational path is never
 *     blocked by an audit / fan-out failure.
 *   * `assertNoLegalHoldOrBlock` is the canonical destructive-action
 *     gate consumed by the destruction governance + retention sweeper
 *     services.
 */
import { LEGAL_HOLD_KINDS, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { emitLifecycleEvent } from "../intelligence/intelligence-activity.service.js";
async function tryEmitWebhookEvent(eventKind, payload, ctx) {
    try {
        const mod = (await import("../packaging/webhooks/webhook-platform.service.js").catch(() => ({})));
        if (typeof mod.emitWebhookEvent === "function") {
            await mod.emitWebhookEvent({
                prisma: ctx.prisma,
                teamId: ctx.teamId,
                eventKind,
                payload,
            });
        }
    }
    catch {
        // Audit fan-out failure MUST never break the operational path.
    }
}
function toProjection(row) {
    return {
        id: row.id,
        teamId: row.teamId,
        kind: row.kind,
        scopeTargetId: row.scopeTargetId,
        name: row.name,
        reason: row.reason,
        state: row.state,
        createdByUserId: row.createdByUserId,
        createdAt: row.createdAt.toISOString(),
        releasedByUserId: row.releasedByUserId,
        releasedAtUtc: row.releasedAtUtc ? row.releasedAtUtc.toISOString() : null,
        expiresAtUtc: row.expiresAtUtc ? row.expiresAtUtc.toISOString() : null,
    };
}
function isLegalHoldKind(value) {
    return LEGAL_HOLD_KINDS.includes(value);
}
export async function createLegalHold(input) {
    if (!isLegalHoldKind(input.kind)) {
        return { ok: false, denial: "INVALID_KIND" };
    }
    let scopeTargetId;
    if (input.kind === "EVIDENCE" || input.kind === "CASE") {
        if (!input.scopeTargetId) {
            return { ok: false, denial: "SCOPE_TARGET_REQUIRED" };
        }
        scopeTargetId = input.scopeTargetId;
    }
    else {
        // WORKSPACE / ORGANIZATION default to the workspace id.
        scopeTargetId = input.scopeTargetId ?? input.teamId;
    }
    const prisma = input.prisma ?? defaultPrisma;
    const row = await prisma.legalHold.create({
        data: {
            teamId: input.teamId,
            kind: input.kind,
            scopeTargetId,
            name: input.name.slice(0, 200),
            reason: input.reason.slice(0, 600),
            state: "ACTIVE",
            createdByUserId: input.createdByUserId,
            expiresAtUtc: input.expiresAtUtc ?? null,
        },
        select: { id: true },
    });
    // Phase 6 — Resolve template-identity trio for audit traceability
    // when the hold targets an Evidence row. Identity-only; never
    // drives any policy decision. Wrapped in try/catch — never breaks
    // the legal-hold flow. Legacy rows surface NULL members.
    let templateProvenance = {
        templateSlug: null,
        templateVersion: null,
        templateDbId: null,
    };
    if (input.kind === "EVIDENCE" && scopeTargetId) {
        try {
            const ev = await prisma.evidence.findUnique({
                where: { id: scopeTargetId },
                select: {
                    templateSlug: true,
                    templateVersion: true,
                    templateDbId: true,
                },
            });
            if (ev) {
                templateProvenance = {
                    templateSlug: ev.templateSlug ?? null,
                    templateVersion: ev.templateVersion ?? null,
                    templateDbId: ev.templateDbId ?? null,
                };
            }
        }
        catch {
            /* identity propagation must never break legal-hold flow */
        }
    }
    void tryEmitWebhookEvent("LEGAL_HOLD_APPLIED", {
        holdId: row.id,
        kind: input.kind,
        scopeTargetId,
        // Phase 6 — template provenance trio for downstream
        // traceability. Identity-only; never drives policy.
        templateSlug: templateProvenance.templateSlug,
        templateVersion: templateProvenance.templateVersion,
        templateDbId: templateProvenance.templateDbId,
    }, { prisma, teamId: input.teamId });
    return { ok: true, holdId: row.id };
}
export async function releaseLegalHold(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const existing = await prisma.legalHold.findFirst({
        where: { id: input.holdId, teamId: input.teamId },
        select: { id: true, state: true, kind: true, scopeTargetId: true },
    });
    if (!existing) {
        return { ok: false, denial: "NOT_FOUND" };
    }
    if (existing.state === "RELEASED") {
        return { ok: false, denial: "ALREADY_RELEASED" };
    }
    await prisma.legalHold.update({
        where: { id: existing.id },
        data: {
            state: "RELEASED",
            releasedByUserId: input.releasedByUserId,
            releasedAtUtc: new Date(),
        },
    });
    void tryEmitWebhookEvent("LEGAL_HOLD_RELEASED", {
        holdId: existing.id,
        kind: existing.kind,
        scopeTargetId: existing.scopeTargetId,
        reason: input.reason ? input.reason.slice(0, 200) : null,
    }, { prisma, teamId: input.teamId });
    return { ok: true };
}
export async function listLegalHolds(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const rows = await prisma.legalHold.findMany({
        where: {
            teamId: input.teamId,
            ...(input.kind ? { kind: input.kind } : {}),
            ...(input.scopeTargetId ? { scopeTargetId: input.scopeTargetId } : {}),
            ...(input.state ? { state: input.state } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 500,
    });
    return rows.map((row) => toProjection(row));
}
/**
 * Canonical "is held" check. Consults BOTH the Phase 4B `legal_holds`
 * table (via LegalHold model) AND the Phase 4A `case_legal_holds`
 * table (via CaseLegalHold model) so a single call is a complete
 * preservation signal regardless of which era placed the hold.
 */
export async function isUnderLegalHold(input) {
    const prisma = input.prisma ?? defaultPrisma;
    // --- Phase 4B: LegalHold rows (EVIDENCE / WORKSPACE / ORGANIZATION / CASE) ---
    const orClauses = [
        { kind: "EVIDENCE", scopeTargetId: input.evidenceId },
        { kind: "WORKSPACE", scopeTargetId: input.teamId },
        { kind: "ORGANIZATION" },
    ];
    if (input.caseId) {
        orClauses.push({ kind: "CASE", scopeTargetId: input.caseId });
    }
    const rows4B = await prisma.legalHold.findMany({
        where: {
            teamId: input.teamId,
            state: "ACTIVE",
            OR: orClauses,
        },
        select: { id: true },
        take: 100,
    });
    // --- Phase 4A: CaseLegalHold rows (per-record EvidenceLegalHold + case-level) ---
    // Resolve the case id for the evidence if not provided.
    let resolvedCaseId = input.caseId ?? null;
    const hold4AIds = [];
    try {
        // Per-record hold (EvidenceLegalHold).
        const directHold = await prisma.evidenceLegalHold.findFirst({
            where: { evidenceId: input.evidenceId, status: "ACTIVE" },
            select: { id: true },
        });
        if (directHold)
            hold4AIds.push(directHold.id);
        // Case-level hold (CaseLegalHold). Look up caseId if needed.
        if (!resolvedCaseId) {
            const ev = await prisma.evidence.findUnique({
                where: { id: input.evidenceId },
                select: { caseId: true },
            });
            resolvedCaseId = ev?.caseId ?? null;
        }
        if (resolvedCaseId) {
            const caseHold = await prisma.caseLegalHold.findFirst({
                where: { caseId: resolvedCaseId, status: "ACTIVE" },
                select: { id: true },
            });
            if (caseHold)
                hold4AIds.push(caseHold.id);
        }
    }
    catch {
        // 4A tables may not exist in all environments — tolerate gracefully.
    }
    const holdIds4B = rows4B.map((r) => r.id);
    const allHoldIds = [...holdIds4B, ...hold4AIds];
    const sources = [
        ...(holdIds4B.length > 0 ? ["4B"] : []),
        ...(hold4AIds.length > 0 ? ["4A"] : []),
    ];
    return {
        underHold: allHoldIds.length > 0,
        holdIds: allHoldIds,
        sources,
    };
}
export async function assertNoLegalHoldOrBlock(input) {
    const result = await isUnderLegalHold({
        prisma: input.prisma,
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        caseId: input.caseId ?? null,
    });
    if (!result.underHold) {
        return { ok: true };
    }
    // Fire-and-forget POLICY_VIOLATION_LEGAL_HOLD emit. Bounded payload —
    // hold reason text is never logged; only holdIds + action.
    void emitLifecycleEvent({
        prisma: input.prisma,
        teamId: input.teamId,
        code: "POLICY_VIOLATION_LEGAL_HOLD",
        evidenceId: input.evidenceId,
        caseId: input.caseId ?? null,
        reason: `hold_blocked:${input.action}:${result.holdIds.slice(0, 10).join(",")}`.slice(0, 200),
        targetType: "LEGAL_HOLD",
        targetId: result.holdIds[0] ?? null,
    });
    return {
        ok: false,
        denial: "LEGAL_HOLD_BLOCKED",
        holdIds: result.holdIds,
    };
}
export async function countActiveHolds(input) {
    const prisma = input.prisma ?? defaultPrisma;
    return prisma.legalHold.count({
        where: {
            teamId: input.teamId,
            state: "ACTIVE",
            ...(input.kind ? { kind: input.kind } : {}),
        },
    });
}
