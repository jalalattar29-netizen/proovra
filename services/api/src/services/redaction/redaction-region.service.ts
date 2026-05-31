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

import type { PrismaClient } from "@prisma/client";
import {
  REDACTION_METHODS,
  REDACTION_REGION_KINDS,
  isValidRegionGeometry,
  type RedactionDenialReason,
  type RedactionDetectionProvider,
  type RedactionMethod,
  type RedactionRegionKind,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitRedactionActivity } from "./redaction-activity.service.js";

export type AddRedactionRegionInput = {
  prisma?: PrismaClient;
  teamId: string;
  versionId: string;
  kind: RedactionRegionKind;
  method: RedactionMethod;
  geometry: Record<string, unknown>;
  rationale?: string | null;
  authoredByUserId: string;
  sourceDetectionId?: string | null;
  sourceProvider?: RedactionDetectionProvider | null;
};

export type AddRedactionRegionResult =
  | { ok: true; regionId: string }
  | { ok: false; denial: RedactionDenialReason };

export async function addRedactionRegion(
  input: AddRedactionRegionInput,
): Promise<AddRedactionRegionResult> {
  if (!(REDACTION_REGION_KINDS as ReadonlyArray<string>).includes(input.kind)) {
    return { ok: false, denial: "REGION_INVALID" };
  }
  if (!(REDACTION_METHODS as ReadonlyArray<string>).includes(input.method)) {
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
  if (!version) return { ok: false, denial: "VERSION_NOT_FOUND" };
  if (version.state !== "DRAFT") {
    return { ok: false, denial: "VERSION_LOCKED" };
  }

  const created = await prisma.redactionRegion.create({
    data: {
      teamId: input.teamId,
      versionId: input.versionId,
      kind: input.kind,
      method: input.method,
      geometry: input.geometry as never,
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

export type RemoveRedactionRegionInput = {
  prisma?: PrismaClient;
  teamId: string;
  regionId: string;
  actorUserId: string;
  rationale?: string | null;
};

export type RemoveRedactionRegionResult =
  | { ok: true }
  | { ok: false; denial: RedactionDenialReason };

export async function removeRedactionRegion(
  input: RemoveRedactionRegionInput,
): Promise<RemoveRedactionRegionResult> {
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
  if (!region) return { ok: false, denial: "REGION_INVALID" };
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

export async function listRedactionRegionsForVersion(input: {
  prisma?: PrismaClient;
  teamId: string;
  versionId: string;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.redactionRegion.findMany({
    where: { teamId: input.teamId, versionId: input.versionId },
    orderBy: { createdAt: "asc" },
  });
}
