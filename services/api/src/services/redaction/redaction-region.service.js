/**
 * PROOVRA Phase 3A — Redaction region service.
 *
 * Bounded region store. Each region is the bounded shape that the
 * derivative renderer will mask. Geometry is validated by the
 * shared `isValidRegionGeometry` helper BEFORE the row is written.
 *
 * Hard rules:
 *   * Regions can only be added to a version that is in DRAFT.
 *   * Geometry shape MUST match the region kind.
 *   * The bounded `method` decides how the renderer fills the
 *     region in the derivative.
 */
import { REDACTION_METHODS, REDACTION_REGION_KINDS, isValidRegionGeometry, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { emitRedactionActivity } from "./redaction-activity.service.js";
export async function addRedactionRegion(input) {
    if (!REDACTION_REGION_KINDS.includes(input.kind)) {
        return { ok: false, denial: "REGION_INVALID" };
    }
    if (!REDACTION_METHODS.includes(input.method)) {
        return { ok: false, denial: "REGION_INVALID" };
    }
    if (!isValidRegionGeometry(input.kind, input.geometry)) {
        return { ok: false, denial: "REGION_OUT_OF_BOUNDS" };
    }
    const prisma = input.prisma ?? defaultPrisma;
    const version = await prisma.redactionVersion.findFirst({
        where: { id: input.versionId, teamId: input.teamId },
        select: { id: true, state: true, projectId: true },
    });
    if (!version)
        return { ok: false, denial: "VERSION_NOT_FOUND" };
    if (version.state !== "DRAFT") {
        return { ok: false, denial: "VERSION_LOCKED" };
    }
    const created = await prisma.redactionRegion.create({
        data: {
            teamId: input.teamId,
            versionId: input.versionId,
            kind: input.kind,
            method: input.method,
            geometry: input.geometry,
            rationale: input.rationale?.slice(0, 600) ?? null,
            sourceDetectionId: input.sourceDetectionId ?? null,
            sourceProvider: input.sourceProvider ?? null,
            authoredByUserId: input.authoredByUserId,
        },
        select: { id: true },
    });
    await emitRedactionActivity({
        prisma,
        teamId: input.teamId,
        projectId: version.projectId,
        versionId: input.versionId,
        code: "REGION_ADDED",
        actorUserId: input.authoredByUserId,
        payload: {
            regionId: created.id,
            kind: input.kind,
            method: input.method,
            sourceProvider: input.sourceProvider ?? null,
        },
    });
    return { ok: true, regionId: created.id };
}
export async function removeRedactionRegion(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const region = await prisma.redactionRegion.findFirst({
        where: { id: input.regionId, teamId: input.teamId },
        select: {
            id: true,
            versionId: true,
            kind: true,
            method: true,
            version: { select: { state: true, projectId: true } },
        },
    });
    if (!region)
        return { ok: false, denial: "REGION_INVALID" };
    if (region.version.state !== "DRAFT") {
        return { ok: false, denial: "VERSION_LOCKED" };
    }
    await prisma.redactionRegion.delete({ where: { id: input.regionId } });
    await emitRedactionActivity({
        prisma,
        teamId: input.teamId,
        projectId: region.version.projectId,
        versionId: region.versionId,
        code: "REGION_REMOVED",
        actorUserId: input.actorUserId,
        payload: {
            regionId: input.regionId,
            kind: region.kind,
            method: region.method,
            rationalePreview: input.rationale?.slice(0, 80) ?? null,
        },
    });
    return { ok: true };
}
export async function listRedactionRegionsForVersion(input) {
    const prisma = input.prisma ?? defaultPrisma;
    return prisma.redactionRegion.findMany({
        where: { teamId: input.teamId, versionId: input.versionId },
        orderBy: { createdAt: "asc" },
    });
}
