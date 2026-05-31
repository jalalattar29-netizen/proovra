/**
 * PROOVRA Phase 3A — Redaction project + version services.
 *
 * Owns the lifecycle of a (team, evidence) redaction project and
 * the append-only version history inside it. Every transition is
 * bounded by the shared state machine and emits a redaction
 * activity event.
 *
 * Hard rules:
 *   * Workspace-anchored at every entry point.
 *   * Original Evidence row is NEVER altered.
 *   * Versions are append-only; an APPROVED version that gets
 *     PUBLISHED supersedes the prior PUBLISHED version.
 */

import type { PrismaClient } from "@prisma/client";
import {
  REDACTION_ARTIFACT_KINDS,
  isAllowedVersionTransition,
  type RedactionArtifactKind,
  type RedactionDenialReason,
  type RedactionVersionState,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitRedactionActivity } from "./redaction-activity.service.js";

// ---------------------------------------------------------------------------
// Project lifecycle
// ---------------------------------------------------------------------------

export type OpenRedactionProjectInput = {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  artifactKind: RedactionArtifactKind;
  title?: string | null;
  createdByUserId: string;
};

export type OpenRedactionProjectResult =
  | { ok: true; projectId: string; opened: boolean }
  | { ok: false; denial: RedactionDenialReason };

/**
 * Idempotent project opener. If a project already exists for the
 * (team, evidence) pair we return it; otherwise we create a new
 * one. The DRAFT state means no reviewer has submitted anything
 * for approval yet.
 */
export async function openRedactionProject(
  input: OpenRedactionProjectInput,
): Promise<OpenRedactionProjectResult> {
  if (
    !(REDACTION_ARTIFACT_KINDS as ReadonlyArray<string>).includes(
      input.artifactKind,
    )
  ) {
    return { ok: false, denial: "ARTIFACT_NOT_REDACTABLE" };
  }
  const prisma = input.prisma ?? defaultPrisma;

  // Workspace-anchored existence check on the evidence row.
  const evidence = await prisma.evidence.findFirst({
    where: { id: input.evidenceId, teamId: input.teamId },
    select: { id: true },
  });
  if (!evidence) {
    return { ok: false, denial: "PROJECT_NOT_FOUND" };
  }

  const existing = await prisma.redactionProject.findFirst({
    where: { teamId: input.teamId, evidenceId: input.evidenceId },
    select: { id: true },
  });
  if (existing) {
    return { ok: true, projectId: existing.id, opened: false };
  }

  const created = await prisma.redactionProject.create({
    data: {
      teamId: input.teamId,
      evidenceId: input.evidenceId,
      artifactKind: input.artifactKind,
      title: input.title?.slice(0, 200) ?? null,
      createdByUserId: input.createdByUserId,
    },
    select: { id: true },
  });
  await emitRedactionActivity({
    prisma,
    teamId: input.teamId,
    projectId: created.id,
    code: "PROJECT_CREATED",
    actorUserId: input.createdByUserId,
    payload: {
      evidenceId: input.evidenceId,
      artifactKind: input.artifactKind,
    },
  });
  return { ok: true, projectId: created.id, opened: true };
}

// ---------------------------------------------------------------------------
// Version lifecycle
// ---------------------------------------------------------------------------

export type CreateRedactionVersionInput = {
  prisma?: PrismaClient;
  teamId: string;
  projectId: string;
  authoredByUserId: string;
  rationale?: string | null;
};

export type CreateRedactionVersionResult =
  | { ok: true; versionId: string; versionOrdinal: number }
  | { ok: false; denial: RedactionDenialReason };

/**
 * Append a new DRAFT version to a project. Each version gets a
 * monotonically increasing `versionOrdinal` per project.
 */
export async function createRedactionVersion(
  input: CreateRedactionVersionInput,
): Promise<CreateRedactionVersionResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const project = await prisma.redactionProject.findFirst({
    where: { id: input.projectId, teamId: input.teamId },
    select: { id: true },
  });
  if (!project) return { ok: false, denial: "PROJECT_NOT_FOUND" };
  const previous = await prisma.redactionVersion.findFirst({
    where: { projectId: input.projectId },
    orderBy: { versionOrdinal: "desc" },
    select: { versionOrdinal: true },
  });
  const nextOrdinal = (previous?.versionOrdinal ?? 0) + 1;
  const created = await prisma.redactionVersion.create({
    data: {
      projectId: input.projectId,
      teamId: input.teamId,
      versionOrdinal: nextOrdinal,
      state: "DRAFT",
      authoredByUserId: input.authoredByUserId,
      rationale: input.rationale?.slice(0, 600) ?? null,
    },
    select: { id: true, versionOrdinal: true },
  });
  await emitRedactionActivity({
    prisma,
    teamId: input.teamId,
    projectId: input.projectId,
    versionId: created.id,
    code: "VERSION_CREATED",
    actorUserId: input.authoredByUserId,
    payload: { versionOrdinal: created.versionOrdinal },
  });
  return {
    ok: true,
    versionId: created.id,
    versionOrdinal: created.versionOrdinal,
  };
}

export type TransitionRedactionVersionInput = {
  prisma?: PrismaClient;
  teamId: string;
  versionId: string;
  toState: RedactionVersionState;
  actorUserId: string;
  rationale?: string | null;
};

export type TransitionRedactionVersionResult =
  | { ok: true; from: RedactionVersionState; to: RedactionVersionState }
  | { ok: false; denial: RedactionDenialReason };

/**
 * Bounded state-machine transition. Refuses any transition that is
 * not in `REDACTION_VERSION_TRANSITIONS`. When transitioning to
 * PUBLISHED we also stamp the prior PUBLISHED version of the same
 * project as SUPERSEDED.
 */
export async function transitionRedactionVersion(
  input: TransitionRedactionVersionInput,
): Promise<TransitionRedactionVersionResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const version = await prisma.redactionVersion.findFirst({
    where: { id: input.versionId, teamId: input.teamId },
    select: { id: true, state: true, projectId: true },
  });
  if (!version) return { ok: false, denial: "VERSION_NOT_FOUND" };
  const from = version.state as RedactionVersionState;
  if (!isAllowedVersionTransition(from, input.toState)) {
    return { ok: false, denial: "INVALID_TRANSITION" };
  }

  const now = new Date();
  const patch: Record<string, unknown> = { state: input.toState };
  if (input.toState === "IN_REVIEW") patch.submittedAtUtc = now;
  if (input.toState === "APPROVED") patch.approvedAtUtc = now;
  if (input.toState === "REJECTED") patch.rejectedAtUtc = now;
  if (input.toState === "PUBLISHED") patch.publishedAtUtc = now;
  if (input.toState === "SUPERSEDED") patch.supersededAtUtc = now;
  if (input.rationale) {
    patch.rationale = input.rationale.slice(0, 600);
  }

  await prisma.$transaction(async (tx) => {
    if (input.toState === "PUBLISHED") {
      // Stamp the prior PUBLISHED version (if any) as SUPERSEDED.
      await tx.redactionVersion.updateMany({
        where: {
          teamId: input.teamId,
          projectId: version.projectId,
          state: "PUBLISHED",
          NOT: { id: input.versionId },
        },
        data: { state: "SUPERSEDED", supersededAtUtc: now },
      });
      // Also flip the project state to PUBLISHED.
      await tx.redactionProject.update({
        where: { id: version.projectId },
        data: { state: "PUBLISHED" },
      });
    }
    if (input.toState === "IN_REVIEW") {
      await tx.redactionProject.update({
        where: { id: version.projectId },
        data: { state: "IN_REVIEW" },
      });
    }
    if (input.toState === "APPROVED") {
      await tx.redactionProject.update({
        where: { id: version.projectId },
        data: { state: "APPROVED" },
      });
    }
    if (input.toState === "REJECTED") {
      await tx.redactionProject.update({
        where: { id: version.projectId },
        data: { state: "REJECTED" },
      });
    }
    await tx.redactionVersion.update({
      where: { id: input.versionId },
      data: patch,
    });
  });

  const code =
    input.toState === "IN_REVIEW"
      ? "VERSION_SUBMITTED_FOR_REVIEW"
      : input.toState === "APPROVED"
      ? "VERSION_APPROVED"
      : input.toState === "REJECTED"
      ? "VERSION_REJECTED"
      : input.toState === "PUBLISHED"
      ? "VERSION_PUBLISHED"
      : "VERSION_SUPERSEDED";

  await emitRedactionActivity({
    prisma,
    teamId: input.teamId,
    projectId: version.projectId,
    versionId: input.versionId,
    code,
    actorUserId: input.actorUserId,
    payload: {
      from,
      to: input.toState,
      rationalePreview: input.rationale?.slice(0, 80) ?? null,
    },
  });

  return { ok: true, from, to: input.toState };
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export async function listRedactionProjectsForTeam(input: {
  prisma?: PrismaClient;
  teamId: string;
  limit?: number;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.redactionProject.findMany({
    where: { teamId: input.teamId },
    orderBy: { createdAt: "desc" },
    take: Math.min(input.limit ?? 100, 500),
  });
}
