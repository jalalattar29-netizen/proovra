/**
 * Phase 14 — Case-level legal holds.
 *
 * A case hold preserves every evidence row linked to the case (via
 * `Evidence.caseId`). It is sibling to `EvidenceLegalHold` (per-record
 * holds); evidence-is-held resolution walks BOTH and treats either
 * an active per-record OR an active case hold as a preservation
 * signal.
 *
 * Holds do NOT assert legal admissibility. They are internal
 * preservation controls that flag the linked records as
 * "preserved pending review".
 *
 * Wording: "internal preservation control" / "preserved pending
 * review". Never claim "legally compliant", "court admissible",
 * "certified retention", "legally binding".
 */
import { prisma as defaultPrisma } from "../../db.js";
import { appendCustodyEvent, } from "../custody-events.service.js";
export class CaseLegalHoldError extends Error {
    code;
    details;
    constructor(code, details) {
        super(code);
        this.code = code;
        this.details = details;
        this.name = "CaseLegalHoldError";
    }
}
export async function placeCaseLegalHold(input, client = defaultPrisma) {
    const c = await client.case.findUnique({
        where: { id: input.caseId },
        select: { id: true, teamId: true },
    });
    if (!c || c.teamId !== input.teamId) {
        throw new CaseLegalHoldError("case_not_in_workspace");
    }
    const hold = await client.caseLegalHold.create({
        data: {
            teamId: input.teamId,
            caseId: input.caseId,
            title: input.title.slice(0, 180),
            reason: input.reason?.slice(0, 4000) ?? null,
            status: "ACTIVE",
            placedByUserId: input.actorUserId,
        },
    });
    // Audit a custody event on every evidence currently in the case so
    // the forensic chain reflects the new preservation control. Best
    // effort — failures here don't undo the hold.
    try {
        const linked = await client.evidence.findMany({
            where: { caseId: input.caseId },
            select: { id: true },
        });
        await Promise.all(linked.map((e) => appendCustodyEvent({
            evidenceId: e.id,
            eventType: "CASE_LEGAL_HOLD_APPLIED",
            payload: {
                caseId: input.caseId,
                caseLegalHoldId: hold.id,
                title: hold.title,
                placedByUserId: input.actorUserId,
            },
        }).catch(() => null)));
    }
    catch {
        /* swallow */
    }
    return hold;
}
/**
 * Release a case hold. When the workspace policy
 * `requireLegalHoldReleaseApproval` flag is true, the caller MUST
 * pass `approvalAcknowledged: true` (operator-confirmed). The flag is
 * checked by the calling route — this function only enforces the
 * release-note contract.
 */
export async function releaseCaseLegalHold(input, client = defaultPrisma) {
    const note = input.releaseNote.trim();
    if (note.length === 0) {
        throw new CaseLegalHoldError("release_note_required");
    }
    const hold = await client.caseLegalHold.findUnique({
        where: { id: input.id },
    });
    if (!hold || hold.teamId !== input.teamId) {
        throw new CaseLegalHoldError("hold_not_found");
    }
    if (hold.status === "RELEASED")
        return hold;
    const released = await client.caseLegalHold.update({
        where: { id: input.id },
        data: {
            status: "RELEASED",
            releasedAtUtc: new Date(),
            releasedByUserId: input.actorUserId,
            releaseNote: note.slice(0, 4000),
        },
    });
    try {
        const linked = await client.evidence.findMany({
            where: { caseId: hold.caseId },
            select: { id: true },
        });
        await Promise.all(linked.map((e) => appendCustodyEvent({
            evidenceId: e.id,
            eventType: "CASE_LEGAL_HOLD_RELEASED",
            payload: {
                caseId: hold.caseId,
                caseLegalHoldId: hold.id,
                releasedByUserId: input.actorUserId,
                // Release note is INTERNAL — captured in the custody event
                // so reviewers can audit, but NEVER surfaced on public
                // verify or any external surface.
                releaseNoteInternal: note.slice(0, 4000),
            },
        }).catch(() => null)));
    }
    catch {
        /* swallow */
    }
    return released;
}
// -----------------------------------------------------------------------------
// Inheritance resolver
// -----------------------------------------------------------------------------
/**
 * Returns true if the given evidence is preserved by EITHER a
 * per-record hold OR a case-level hold on its linked case. This is
 * the canonical "is held" check used by the retention sweeper, the
 * delete enforcement, and the operations UI.
 */
export async function isEvidenceUnderAnyLegalHold(evidenceId, client = defaultPrisma) {
    const ev = await client.evidence.findUnique({
        where: { id: evidenceId },
        select: { id: true, caseId: true },
    });
    if (!ev)
        return false;
    // Per-record hold check first (cheap).
    const directHold = await client.evidenceLegalHold.findFirst({
        where: { evidenceId, status: "ACTIVE" },
        select: { id: true },
    });
    if (directHold)
        return true;
    if (!ev.caseId)
        return false;
    const caseHold = await client.caseLegalHold.findFirst({
        where: { caseId: ev.caseId, status: "ACTIVE" },
        select: { id: true },
    });
    return !!caseHold;
}
// -----------------------------------------------------------------------------
// Read helpers
// -----------------------------------------------------------------------------
// Phase 32.7.3 — explicit `select` clause to bound the query
// surface to columns the projection actually uses. See the
// matching constant on EvidenceLegalHold in governance.service.ts
// for the rationale.
//
// Phase 32.7.4 — narrowed further: `createdAt` and `updatedAt`
// removed from both the select AND the projection. The sibling
// `LEGAL_HOLD_SELECT` (used by /v1/governance/legal-holds) does
// NOT include these two columns, and that endpoint returns 200 in
// production. The case-legal-holds endpoint still 503s, which
// strongly suggests one of `created_at` / `updated_at` is missing
// from the `case_legal_holds` table in production (the user's
// column inspection listed them under "etc." without confirming).
//
// Removing them from the select restores 200 if that hypothesis
// is correct. The frontend `CaseLegalHold` type in
// apps/web/app/(app)/governance/page.tsx does NOT use either
// field, so the projection-shape narrowing is a no-op for the
// canonical consumer. The POST place + POST release handlers
// also call `projectCaseLegalHold(...)` on the returned row; the
// projection now omits the two fields from its return shape, so
// downstream consumers cannot accidentally depend on them.
const CASE_LEGAL_HOLD_SELECT = {
    id: true,
    teamId: true,
    caseId: true,
    title: true,
    status: true,
    placedByUserId: true,
    placedAtUtc: true,
    releasedByUserId: true,
    releasedAtUtc: true,
};
export async function listCaseLegalHolds(input, client = defaultPrisma) {
    return client.caseLegalHold.findMany({
        where: {
            teamId: input.teamId,
            ...(input.caseId ? { caseId: input.caseId } : {}),
            ...(input.status ? { status: input.status } : {}),
        },
        orderBy: { placedAtUtc: "desc" },
        take: Math.min(Math.max(input.limit ?? 50, 1), 200),
        select: CASE_LEGAL_HOLD_SELECT,
    });
}
// Phase 32.7.3 — accept the bounded projection type.
export function projectCaseLegalHold(hold) {
    return {
        id: hold.id,
        teamId: hold.teamId,
        caseId: hold.caseId,
        title: hold.title,
        status: hold.status,
        placedByUserId: hold.placedByUserId,
        placedAtUtc: hold.placedAtUtc.toISOString(),
        releasedByUserId: hold.releasedByUserId,
        releasedAtUtc: hold.releasedAtUtc?.toISOString() ?? null,
    };
}
