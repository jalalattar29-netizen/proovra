/**
 * PROOVRA Phase 3A — Redaction derivative orchestrator.
 *
 * Single source of truth for the derivative lifecycle. The actual
 * heavy lifting (sharp / pdf-lib / ffmpeg) runs in the worker; this
 * file is the API-side bookkeeper that:
 *
 *   1. Refuses the request unless the version is APPROVED.
 *   2. Stamps a PENDING `RedactionDerivative` row.
 *   3. Emits DERIVATIVE_REQUESTED + DERIVATIVE_RENDER_STARTED events
 *      so the operator timeline is honest about WHAT was asked for
 *      and BY WHOM, regardless of whether the renderer is reachable.
 *   4. Exposes idempotent `markDerivativeReady`,
 *      `markDerivativeFailed`, and `quarantineDerivative` calls so
 *      the worker can write the outcome back atomically.
 *
 * Hard rules:
 *   * One derivative per version (UNIQUE on versionId).
 *   * The derivative NEVER overwrites the original Evidence row.
 *     Storage keys live in a separate prefix and the API refuses
 *     to write a derivative row whose `storageKey` equals the
 *     evidence's `storageKey`.
 *   * PUBLISHED is gated on a READY derivative.
 */

import type { PrismaClient } from "@prisma/client";
import {
  REDACTION_ARTIFACT_KINDS,
  type RedactionArtifactKind,
  type RedactionDenialReason,
  type RedactionDerivativeKind,
  type RedactionDerivativeState,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitRedactionActivity } from "./redaction-activity.service.js";

const ARTIFACT_TO_DERIVATIVE: Readonly<
  Record<RedactionArtifactKind, RedactionDerivativeKind>
> = {
  IMAGE: "IMAGE_REDACTED",
  PDF: "PDF_REDACTED",
  VIDEO: "VIDEO_REDACTED",
  AUDIO: "AUDIO_REDACTED",
};

export type RequestDerivativeInput = {
  prisma?: PrismaClient;
  teamId: string;
  versionId: string;
  requestedByUserId: string;
};

export type RequestDerivativeResult =
  | { ok: true; derivativeId: string; state: RedactionDerivativeState }
  | { ok: false; denial: RedactionDenialReason };

export async function requestRedactionDerivative(
  input: RequestDerivativeInput,
): Promise<RequestDerivativeResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const version = await prisma.redactionVersion.findFirst({
    where: { id: input.versionId, teamId: input.teamId },
    select: {
      id: true,
      state: true,
      projectId: true,
      project: { select: { artifactKind: true, evidenceId: true } },
      derivative: { select: { id: true, state: true } },
    },
  });
  if (!version) return { ok: false, denial: "VERSION_NOT_FOUND" };
  if (version.state !== "APPROVED" && version.state !== "PUBLISHED") {
    return { ok: false, denial: "INVALID_TRANSITION" };
  }
  const artifactKind = version.project.artifactKind as RedactionArtifactKind;
  if (!(REDACTION_ARTIFACT_KINDS as ReadonlyArray<string>).includes(artifactKind)) {
    return { ok: false, denial: "ARTIFACT_NOT_REDACTABLE" };
  }

  const derivativeKind = ARTIFACT_TO_DERIVATIVE[artifactKind];

  // Idempotent: if a derivative row already exists, reuse it.
  let derivativeId: string;
  if (version.derivative) {
    derivativeId = version.derivative.id;
    await prisma.redactionDerivative.update({
      where: { id: derivativeId },
      data: {
        state: "RENDERING",
        renderStartedAt: new Date(),
        failureReason: null,
        lastErrorPreview: null,
      },
    });
  } else {
    const created = await prisma.redactionDerivative.create({
      data: {
        teamId: input.teamId,
        versionId: input.versionId,
        kind: derivativeKind,
        state: "PENDING",
      },
      select: { id: true },
    });
    derivativeId = created.id;
    await prisma.redactionDerivative.update({
      where: { id: derivativeId },
      data: { state: "RENDERING", renderStartedAt: new Date() },
    });
  }
  await emitRedactionActivity({
    prisma,
    teamId: input.teamId,
    projectId: version.projectId,
    versionId: input.versionId,
    code: "DERIVATIVE_REQUESTED",
    actorUserId: input.requestedByUserId,
    payload: {
      derivativeId,
      kind: derivativeKind,
    },
  });
  await emitRedactionActivity({
    prisma,
    teamId: input.teamId,
    projectId: version.projectId,
    versionId: input.versionId,
    code: "DERIVATIVE_RENDER_STARTED",
    actorUserId: input.requestedByUserId,
    payload: { derivativeId },
  });

  return { ok: true, derivativeId, state: "RENDERING" };
}

export type MarkDerivativeReadyInput = {
  prisma?: PrismaClient;
  teamId: string;
  derivativeId: string;
  storageBucket: string;
  storageKey: string;
  storageRegion?: string;
  byteSize: number;
  fileSha256: string;
  contentType: string;
  renderEngine: string;
  actorUserId?: string;
};

export type MarkDerivativeReadyResult =
  | { ok: true }
  | { ok: false; denial: RedactionDenialReason };

export async function markDerivativeReady(
  input: MarkDerivativeReadyInput,
): Promise<MarkDerivativeReadyResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const derivative = await prisma.redactionDerivative.findFirst({
    where: { id: input.derivativeId, teamId: input.teamId },
    select: {
      id: true,
      versionId: true,
      version: {
        select: {
          projectId: true,
          project: { select: { evidenceId: true } },
        },
      },
    },
  });
  if (!derivative) return { ok: false, denial: "DERIVATIVE_NOT_READY" };
  // Refuse if the derivative storage key collides with the
  // original Evidence storage key — the platform NEVER overwrites
  // the original artifact.
  const evidence = await prisma.evidence.findFirst({
    where: { id: derivative.version.project.evidenceId, teamId: input.teamId },
    select: { storageKey: true, storageBucket: true },
  });
  if (
    evidence &&
    evidence.storageBucket === input.storageBucket &&
    evidence.storageKey === input.storageKey
  ) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }

  await prisma.redactionDerivative.update({
    where: { id: input.derivativeId },
    data: {
      state: "READY",
      storageBucket: input.storageBucket,
      storageKey: input.storageKey,
      storageRegion: input.storageRegion ?? null,
      byteSize: BigInt(input.byteSize),
      fileSha256: input.fileSha256,
      contentType: input.contentType,
      renderEngine: input.renderEngine,
      renderedAtUtc: new Date(),
      failureReason: null,
      lastErrorPreview: null,
    },
  });
  await emitRedactionActivity({
    prisma,
    teamId: input.teamId,
    projectId: derivative.version.projectId,
    versionId: derivative.versionId,
    code: "DERIVATIVE_RENDER_COMPLETED",
    actorUserId: input.actorUserId ?? null,
    payload: {
      derivativeId: input.derivativeId,
      renderEngine: input.renderEngine,
      fileSha256: input.fileSha256,
      byteSize: input.byteSize,
    },
  });
  return { ok: true };
}

export type MarkDerivativeFailedInput = {
  prisma?: PrismaClient;
  teamId: string;
  derivativeId: string;
  failureReason: string;
  errorPreview?: string;
  actorUserId?: string;
};

export async function markDerivativeFailed(
  input: MarkDerivativeFailedInput,
): Promise<{ ok: true } | { ok: false; denial: RedactionDenialReason }> {
  const prisma = input.prisma ?? defaultPrisma;
  const derivative = await prisma.redactionDerivative.findFirst({
    where: { id: input.derivativeId, teamId: input.teamId },
    select: {
      id: true,
      versionId: true,
      version: { select: { projectId: true } },
    },
  });
  if (!derivative) return { ok: false, denial: "DERIVATIVE_NOT_READY" };
  await prisma.redactionDerivative.update({
    where: { id: input.derivativeId },
    data: {
      state: "FAILED",
      failureReason: input.failureReason.slice(0, 120),
      lastErrorPreview: input.errorPreview?.slice(0, 400) ?? null,
    },
  });
  await emitRedactionActivity({
    prisma,
    teamId: input.teamId,
    projectId: derivative.version.projectId,
    versionId: derivative.versionId,
    code: "DERIVATIVE_RENDER_FAILED",
    actorUserId: input.actorUserId ?? null,
    payload: {
      derivativeId: input.derivativeId,
      failureReason: input.failureReason.slice(0, 120),
    },
  });
  return { ok: true };
}

export async function quarantineDerivative(input: {
  prisma?: PrismaClient;
  teamId: string;
  derivativeId: string;
  reason: string;
  actorUserId: string;
}): Promise<{ ok: true } | { ok: false; denial: RedactionDenialReason }> {
  const prisma = input.prisma ?? defaultPrisma;
  const derivative = await prisma.redactionDerivative.findFirst({
    where: { id: input.derivativeId, teamId: input.teamId },
    select: {
      id: true,
      versionId: true,
      version: { select: { projectId: true } },
    },
  });
  if (!derivative) return { ok: false, denial: "DERIVATIVE_NOT_READY" };
  await prisma.redactionDerivative.update({
    where: { id: input.derivativeId },
    data: {
      state: "QUARANTINED",
      failureReason: input.reason.slice(0, 120),
    },
  });
  await emitRedactionActivity({
    prisma,
    teamId: input.teamId,
    projectId: derivative.version.projectId,
    versionId: derivative.versionId,
    code: "DERIVATIVE_QUARANTINED",
    actorUserId: input.actorUserId,
    payload: { derivativeId: input.derivativeId, reason: input.reason },
  });
  return { ok: true };
}

export async function getDerivativeForVersion(input: {
  prisma?: PrismaClient;
  teamId: string;
  versionId: string;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.redactionDerivative.findFirst({
    where: { teamId: input.teamId, versionId: input.versionId },
  });
}
