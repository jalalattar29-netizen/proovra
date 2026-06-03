/**
 * PROOVRA Phase 4B — Chain Transfer service.
 *
 * Workspace-anchored lifecycle for cross-organization chain-of-custody
 * transfers. State machine:
 *
 *   INITIATED → (ACCEPTED | REJECTED | EXPIRED | REVOKED)
 *   ACCEPTED  → COMPLETED
 *
 * Hard rules:
 *   * Every entry point is workspace-anchored (teamId).
 *   * Recipient org slug is bounded and validated.
 *   * Webhook emission is forward-declared (best-effort) and MUST
 *     never break the operational write.
 */
import { CHAIN_TRANSFER_STATES, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { appendCustodyEvent } from "../custody-events.service.js";
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
        // Audit / fan-out failure MUST never break the operational write.
    }
}
// ---------------------------------------------------------------------------
// Custody-event helper (I4 — custody continuity on transfer)
// ---------------------------------------------------------------------------
/**
 * Appends a CHAIN_TRANSFER_CUSTODY_EXTENDED event to every evidenceId in the
 * transfer. Fire-and-forget — audit fan-out failure MUST NOT break the write.
 * Uses the existing appendCustodyEvent emitter from custody-events.service.ts
 * (Phase 1B) — no duplicate system.
 */
async function emitTransferCustodyEvents(evidenceIds, payload) {
    for (const evidenceId of evidenceIds) {
        void appendCustodyEvent({
            evidenceId,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            eventType: "CHAIN_TRANSFER_CUSTODY_EXTENDED",
            payload: {
                code: "CHAIN_TRANSFER_CUSTODY_EXTENDED",
                transferId: payload.transferId,
                fromOrganizationId: payload.fromOrganizationId,
                toOrganizationSlug: payload.toOrganizationSlug,
                state: payload.state,
                transitionedAtUtc: payload.transitionedAtUtc,
            },
        }).catch(() => {
            /* fire-and-forget — audit fan-out must never break the operational write */
        });
    }
}
// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;
const TERMINAL_STATES = [
    "REJECTED",
    "EXPIRED",
    "REVOKED",
    "COMPLETED",
];
export async function initiateChainTransfer(input) {
    if (!Array.isArray(input.evidenceIds) || input.evidenceIds.length === 0) {
        return { ok: false, denial: "INVALID_EVIDENCE" };
    }
    if (!SLUG_PATTERN.test(input.toOrganizationSlug)) {
        return { ok: false, denial: "INVALID_SLUG" };
    }
    const prisma = input.prisma ?? defaultPrisma;
    const expiresAt = input.expiresAtUtc == null
        ? null
        : input.expiresAtUtc instanceof Date
            ? input.expiresAtUtc
            : new Date(input.expiresAtUtc);
    const row = await prisma.chainTransfer.create({
        data: {
            teamId: input.teamId,
            fromOrganizationId: input.fromOrganizationId,
            toOrganizationSlug: input.toOrganizationSlug.slice(0, 120),
            evidenceIds: input.evidenceIds,
            caseId: input.caseId ?? null,
            state: "INITIATED",
            reasonNote: input.reasonNote?.slice(0, 400) ?? null,
            expiresAtUtc: expiresAt,
            initiatedByUserId: input.initiatedByUserId,
        },
        select: { id: true },
    });
    void tryEmitWebhookEvent("CHAIN_TRANSFER_INITIATED", {
        transferId: row.id,
        fromOrganizationId: input.fromOrganizationId,
        toOrganizationSlug: input.toOrganizationSlug,
        evidenceCount: input.evidenceIds.length,
    }, { prisma, teamId: input.teamId });
    // I4 — custody continuity: extend chain for each evidenceId on initiation.
    void emitTransferCustodyEvents(input.evidenceIds, {
        transferId: row.id,
        fromOrganizationId: input.fromOrganizationId,
        toOrganizationSlug: input.toOrganizationSlug,
        state: "INITIATED",
        transitionedAtUtc: new Date().toISOString(),
    });
    return { ok: true, transferId: row.id };
}
export async function acceptChainTransfer(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const row = await prisma.chainTransfer.findFirst({
        where: { id: input.transferId, teamId: input.teamId },
        select: { id: true, state: true, fromOrganizationId: true, toOrganizationSlug: true, evidenceIds: true },
    });
    if (!row)
        return { ok: false, denial: "NOT_FOUND" };
    if (row.state !== "INITIATED")
        return { ok: false, denial: "INVALID_STATE" };
    await prisma.chainTransfer.update({
        where: { id: row.id },
        data: {
            state: "ACCEPTED",
            acceptedByUserId: input.acceptingUserId,
            respondedAtUtc: new Date(),
            ...(input.acceptingOrgId
                ? { toOrganizationId: input.acceptingOrgId }
                : {}),
        },
    });
    void tryEmitWebhookEvent("CHAIN_TRANSFER_ACCEPTED", {
        transferId: row.id,
        fromOrganizationId: row.fromOrganizationId,
        toOrganizationSlug: row.toOrganizationSlug,
        acceptingUserId: input.acceptingUserId,
    }, { prisma, teamId: input.teamId });
    // I4 — custody continuity: extend chain for each evidenceId on acceptance.
    const acceptEvidenceIds = Array.isArray(row.evidenceIds)
        ? row.evidenceIds
        : [];
    void emitTransferCustodyEvents(acceptEvidenceIds, {
        transferId: row.id,
        fromOrganizationId: row.fromOrganizationId,
        toOrganizationSlug: row.toOrganizationSlug,
        state: "ACCEPTED",
        transitionedAtUtc: new Date().toISOString(),
    });
    return { ok: true };
}
export async function rejectChainTransfer(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const row = await prisma.chainTransfer.findFirst({
        where: { id: input.transferId, teamId: input.teamId },
        select: { id: true, state: true },
    });
    if (!row)
        return { ok: false, denial: "NOT_FOUND" };
    if (row.state !== "INITIATED")
        return { ok: false, denial: "INVALID_STATE" };
    await prisma.chainTransfer.update({
        where: { id: row.id },
        data: {
            state: "REJECTED",
            rejectedByUserId: input.rejectingUserId,
            respondedAtUtc: new Date(),
            ...(input.reason != null
                ? { reasonNote: input.reason.slice(0, 400) }
                : {}),
        },
    });
    return { ok: true };
}
export async function revokeChainTransfer(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const row = await prisma.chainTransfer.findFirst({
        where: { id: input.transferId, teamId: input.teamId },
        select: { id: true, state: true },
    });
    if (!row)
        return { ok: false, denial: "NOT_FOUND" };
    if (TERMINAL_STATES.includes(row.state)) {
        return { ok: false, denial: "INVALID_STATE" };
    }
    await prisma.chainTransfer.update({
        where: { id: row.id },
        data: {
            state: "REVOKED",
            respondedAtUtc: new Date(),
        },
    });
    void input.actorUserId; // bounded actor reference; not persisted on this row.
    return { ok: true };
}
export async function completeChainTransfer(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const row = await prisma.chainTransfer.findFirst({
        where: { id: input.transferId, teamId: input.teamId },
        select: { id: true, state: true, evidenceIds: true, fromOrganizationId: true, toOrganizationSlug: true },
    });
    if (!row)
        return { ok: false, denial: "NOT_FOUND" };
    if (row.state !== "ACCEPTED")
        return { ok: false, denial: "INVALID_STATE" };
    const completedAt = new Date();
    await prisma.chainTransfer.update({
        where: { id: row.id },
        data: {
            state: "COMPLETED",
            packageId: input.packageId,
            completedAtUtc: completedAt,
        },
    });
    // I4 — custody continuity: extend chain for each evidenceId on completion.
    const completeEvidenceIds = Array.isArray(row.evidenceIds)
        ? row.evidenceIds
        : [];
    void emitTransferCustodyEvents(completeEvidenceIds, {
        transferId: row.id,
        fromOrganizationId: row.fromOrganizationId,
        toOrganizationSlug: row.toOrganizationSlug,
        state: "COMPLETED",
        transitionedAtUtc: completedAt.toISOString(),
    });
    return { ok: true };
}
export async function listChainTransfers(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const rows = await prisma.chainTransfer.findMany({
        where: {
            teamId: input.teamId,
            ...(input.state ? { state: input.state } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 200,
    });
    return rows.map((r) => ({
        id: r.id,
        teamId: r.teamId,
        fromOrganizationId: r.fromOrganizationId,
        toOrganizationSlug: r.toOrganizationSlug,
        toOrganizationId: r.toOrganizationId,
        evidenceIds: Array.isArray(r.evidenceIds)
            ? r.evidenceIds
            : [],
        caseId: r.caseId,
        state: r.state,
        packageId: r.packageId,
        reasonNote: r.reasonNote,
        expiresAtUtc: r.expiresAtUtc?.toISOString() ?? null,
        initiatedByUserId: r.initiatedByUserId,
        acceptedByUserId: r.acceptedByUserId,
        rejectedByUserId: r.rejectedByUserId,
        createdAt: r.createdAt.toISOString(),
        respondedAtUtc: r.respondedAtUtc?.toISOString() ?? null,
        completedAtUtc: r.completedAtUtc?.toISOString() ?? null,
    }));
}
// Compile-time guard.
function _assertEnumsIntact() {
    const _s = "INITIATED";
    void _s;
    void CHAIN_TRANSFER_STATES;
}
void _assertEnumsIntact;
