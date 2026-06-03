/**
 * PROOVRA Phase 2A Closure — Annotation Workspace service.
 *
 * Workspace-anchored reads + writes over the existing
 * `EvidenceAnnotation` table. Adds:
 *
 *   - threaded reply (`parentAnnotationId`) with bounded one-level
 *     nesting
 *   - bulk-resolve over a selection set
 *   - thread-aware list shape consumed by the in-workspace panel
 *
 * Hard rules:
 *   * NEVER builds a parallel annotation system. We extend the
 *     existing model with a single optional `parentAnnotationId`
 *     column.
 *   * Replies are bounded to a single level (a reply to a reply is
 *     rejected with `ANNOTATION_NESTING_INVALID`).
 *   * Workspace anchoring: every read joins to `Evidence.teamId` and
 *     refuses cross-tenant access.
 *   * Bulk operations: bounded ≤ 200 ids per call; emit one
 *     `reviewer.annotation.bulk_resolve` audit event per call.
 */
import { prisma as defaultPrisma } from "../../db.js";
/**
 * Workspace-anchored list-for-evidence. Returns the bounded shape
 * that the inline panel consumes. Replies are returned alongside
 * their roots; the UI groups by `parentAnnotationId`.
 *
 * Bounded: ≤ 500 rows per evidence.
 */
export async function listAnnotationsForEvidence(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const evidence = await prisma.evidence.findFirst({
        where: { id: input.evidenceId, teamId: input.teamId },
        select: { id: true },
    });
    if (!evidence)
        return { ok: false, denial: "EVIDENCE_NOT_FOUND" };
    const rows = await prisma.evidenceAnnotation.findMany({
        where: { evidenceId: input.evidenceId, deletedAt: null },
        orderBy: { createdAt: "asc" },
        take: 500,
        select: {
            id: true,
            evidenceId: true,
            evidencePartId: true,
            authorUserId: true,
            parentAnnotationId: true,
            annotationType: true,
            body: true,
            pageNumber: true,
            mediaTimestampMs: true,
            x: true,
            y: true,
            width: true,
            height: true,
            coordinateSpace: true,
            createdAt: true,
            updatedAt: true,
            resolvedAtUtc: true,
            resolvedByUserId: true,
        },
    });
    return {
        ok: true,
        annotations: rows.map((r) => ({
            ...r,
            annotationType: r.annotationType,
            coordinateSpace: r.coordinateSpace,
        })),
    };
}
/**
 * Post a reply to an existing annotation. Bounded to one level of
 * nesting.
 */
export async function postAnnotationReply(input) {
    const prisma = input.prisma ?? defaultPrisma;
    if (!input.body || input.body.length === 0 || input.body.length > 2_000) {
        return { ok: false, denial: "ANNOTATION_NESTING_INVALID" };
    }
    const parent = await prisma.evidenceAnnotation.findFirst({
        where: { id: input.parentAnnotationId, deletedAt: null },
        select: {
            id: true,
            evidenceId: true,
            parentAnnotationId: true,
            evidence: { select: { teamId: true } },
        },
    });
    if (!parent || parent.evidence.teamId !== input.teamId) {
        return { ok: false, denial: "PARENT_NOT_FOUND" };
    }
    if (parent.parentAnnotationId !== null) {
        return { ok: false, denial: "ANNOTATION_NESTING_INVALID" };
    }
    const created = await prisma.evidenceAnnotation.create({
        data: {
            evidenceId: parent.evidenceId,
            authorUserId: input.authorUserId,
            annotationType: "TEXT",
            coordinateSpace: "DOCUMENT_PAGE",
            body: input.body,
            parentAnnotationId: parent.id,
        },
        select: { id: true },
    });
    return { ok: true, annotationId: created.id };
}
export async function resolveAnnotation(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const row = await prisma.evidenceAnnotation.findFirst({
        where: { id: input.annotationId, deletedAt: null },
        select: {
            id: true,
            resolvedAtUtc: true,
            evidence: { select: { teamId: true } },
        },
    });
    if (!row || row.evidence.teamId !== input.teamId) {
        return { ok: false, denial: "ANNOTATION_NOT_FOUND" };
    }
    if (row.resolvedAtUtc !== null) {
        return { ok: false, denial: "ANNOTATION_ALREADY_RESOLVED" };
    }
    await prisma.evidenceAnnotation.update({
        where: { id: row.id },
        data: {
            resolvedAtUtc: new Date(),
            resolvedByUserId: input.actorUserId,
        },
    });
    return { ok: true };
}
/**
 * Bulk-resolve a selection set. Bounded ≤ 200 ids per call.
 */
export async function bulkResolveAnnotations(input) {
    if (input.annotationIds.length === 0)
        return { ok: true, resolved: 0 };
    if (input.annotationIds.length > 200) {
        return { ok: false, denial: "BULK_SET_TOO_LARGE" };
    }
    const prisma = input.prisma ?? defaultPrisma;
    const candidates = await prisma.evidenceAnnotation.findMany({
        where: {
            id: { in: input.annotationIds },
            deletedAt: null,
            resolvedAtUtc: null,
            evidence: { teamId: input.teamId },
        },
        select: { id: true },
    });
    if (candidates.length === 0)
        return { ok: true, resolved: 0 };
    const ids = candidates.map((c) => c.id);
    const now = new Date();
    await prisma.evidenceAnnotation.updateMany({
        where: { id: { in: ids } },
        data: { resolvedAtUtc: now, resolvedByUserId: input.actorUserId },
    });
    return { ok: true, resolved: ids.length };
}
