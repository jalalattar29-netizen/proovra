/**
 * Phase 14 — Public verify publication workflow.
 *
 * Adds an explicit publication state on top of the existing public
 * verify route. The route remains unchanged for forensic semantics;
 * Phase 14 adds an EARLY GATE: when `publicVerifyState` is not
 * PUBLISHED, the route returns 404 (no leak of evidence existence).
 *
 * Operator actions:
 *   - publishPublicVerify     — NOT_PUBLISHED / UNPUBLISHED → PUBLISHED
 *   - unpublishPublicVerify   — PUBLISHED → UNPUBLISHED (permanent operator withdrawal)
 *   - suspendPublicVerify     — PUBLISHED → SUSPENDED (temporary hide)
 *   - restorePublicVerify     — SUSPENDED → PUBLISHED
 *
 * Default state of every new evidence row is PUBLISHED (preserves
 * pre-Phase-14 behavior). A workspace can opt into the safer
 * NOT_PUBLISHED-by-default flow via the `requirePublicationApproval`
 * policy flag — service does NOT auto-flip the default; routes that
 * create evidence consult the flag.
 *
 * Wording: never claim "authentic", "admissible", "verified truth".
 * Operator-facing labels: "published", "unpublished by operator",
 * "suspended by operator", "restored by operator".
 */
import { prisma as defaultPrisma } from "../../db.js";
import { appendCustodyEvent } from "../custody-events.service.js";
export class PublicationError extends Error {
    code;
    details;
    constructor(code, details) {
        super(code);
        this.code = code;
        this.details = details;
        this.name = "PublicationError";
    }
}
const ALLOWED_TRANSITIONS = {
    NOT_PUBLISHED: ["PUBLISHED", "UNPUBLISHED"],
    PUBLISHED: ["SUSPENDED", "UNPUBLISHED"],
    SUSPENDED: ["PUBLISHED", "UNPUBLISHED"],
    UNPUBLISHED: ["PUBLISHED"],
};
function assertWorkspace(evidence, teamId) {
    if (evidence.teamId !== teamId) {
        throw new PublicationError("evidence_not_in_workspace");
    }
}
async function applyTransition(evidenceId, from, to, patch, client) {
    const allowed = ALLOWED_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
        throw new PublicationError("invalid_state_transition", { from, to });
    }
    // Atomic where-status guard so concurrent operators cannot both win.
    const claim = await client.evidence.updateMany({
        where: { id: evidenceId, publicVerifyState: from },
        data: { publicVerifyState: to, ...patch },
    });
    if (claim.count !== 1) {
        // Lost the race; return canonical state to caller.
        const fresh = await client.evidence.findUniqueOrThrow({
            where: { id: evidenceId },
        });
        return fresh;
    }
    return client.evidence.findUniqueOrThrow({ where: { id: evidenceId } });
}
export async function publishPublicVerify(input, client = defaultPrisma) {
    const ev = await client.evidence.findUnique({
        where: { id: input.evidenceId },
        select: { id: true, teamId: true, publicVerifyState: true },
    });
    if (!ev)
        throw new PublicationError("evidence_not_in_workspace");
    assertWorkspace(ev, input.teamId);
    const now = new Date();
    const updated = await applyTransition(input.evidenceId, ev.publicVerifyState, "PUBLISHED", {
        publicVerifyPublishedAtUtc: now,
        publicVerifyPublishedByUserId: input.actorUserId,
        publicVerifySuspendedAtUtc: null,
        publicVerifySuspendedByUserId: null,
        publicVerifySuspensionReason: null,
    }, client);
    await appendCustodyEvent({
        evidenceId: input.evidenceId,
        eventType: ev.publicVerifyState === "SUSPENDED"
            ? "PUBLIC_VERIFY_RESTORED"
            : "PUBLIC_VERIFY_PUBLISHED",
        payload: {
            previousState: ev.publicVerifyState,
            actorUserId: input.actorUserId,
            // Reason is internal; captured in custody chain only.
            reasonInternal: input.reason ?? null,
        },
    }).catch(() => null);
    return updated;
}
export async function unpublishPublicVerify(input, client = defaultPrisma) {
    const ev = await client.evidence.findUnique({
        where: { id: input.evidenceId },
        select: { id: true, teamId: true, publicVerifyState: true },
    });
    if (!ev)
        throw new PublicationError("evidence_not_in_workspace");
    assertWorkspace(ev, input.teamId);
    const updated = await applyTransition(input.evidenceId, ev.publicVerifyState, "UNPUBLISHED", {}, client);
    await appendCustodyEvent({
        evidenceId: input.evidenceId,
        eventType: "PUBLIC_VERIFY_UNPUBLISHED",
        payload: {
            previousState: ev.publicVerifyState,
            actorUserId: input.actorUserId,
            reasonInternal: input.reason ?? null,
        },
    }).catch(() => null);
    return updated;
}
export async function suspendPublicVerify(input, client = defaultPrisma) {
    const reason = (input.reason ?? "").trim();
    if (!reason)
        throw new PublicationError("reason_required");
    const ev = await client.evidence.findUnique({
        where: { id: input.evidenceId },
        select: { id: true, teamId: true, publicVerifyState: true },
    });
    if (!ev)
        throw new PublicationError("evidence_not_in_workspace");
    assertWorkspace(ev, input.teamId);
    const now = new Date();
    const updated = await applyTransition(input.evidenceId, ev.publicVerifyState, "SUSPENDED", {
        publicVerifySuspendedAtUtc: now,
        publicVerifySuspendedByUserId: input.actorUserId,
        publicVerifySuspensionReason: reason.slice(0, 400),
    }, client);
    await appendCustodyEvent({
        evidenceId: input.evidenceId,
        eventType: "PUBLIC_VERIFY_SUSPENDED",
        payload: {
            previousState: ev.publicVerifyState,
            actorUserId: input.actorUserId,
            // Reason captured INTERNALLY in the custody chain. The public
            // verify route NEVER returns this value.
            reasonInternal: reason,
        },
    }).catch(() => null);
    return updated;
}
export async function restorePublicVerify(input, client = defaultPrisma) {
    // Restore is an alias for publish-from-suspend; reusing the publish
    // path emits the PUBLIC_VERIFY_RESTORED event when applicable.
    return publishPublicVerify(input, client);
}
// -----------------------------------------------------------------------------
// Read helper used by routes / UI.
// -----------------------------------------------------------------------------
export function projectPublicationState(ev) {
    return {
        state: ev.publicVerifyState,
        publishedAtUtc: ev.publicVerifyPublishedAtUtc?.toISOString() ?? null,
        publishedByUserId: ev.publicVerifyPublishedByUserId,
        suspendedAtUtc: ev.publicVerifySuspendedAtUtc?.toISOString() ?? null,
        suspendedByUserId: ev.publicVerifySuspendedByUserId,
    };
}
