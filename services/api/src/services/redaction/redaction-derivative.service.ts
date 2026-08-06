/**
 * PROOVRA Phase 3A — Redaction derivative orchestrator.
 *
 * Single source of truth for the derivative lifecycle. The actual
 * heavy lifting (sharp / pdf-lib / ffmpeg) runs in the worker; this
 * file is the API-side bookkeeper that:
 *
 *   1. Refuses the request unless the version is APPROVED.
 *   2. Commits a QUEUED `RedactionDerivative` row BEFORE the durable enqueue
 *      (12B Correction 5) — only the worker claims QUEUED→RENDERING.
 *   3. Emits the DERIVATIVE_REQUESTED event so the operator timeline is
 *      honest about WHAT was asked for and BY WHOM.
 *   4. Exposes the admin `quarantineDerivative` transition. READY/FAILED
 *      completion lives EXCLUSIVELY in the worker-side writer
 *      (services/worker/src/redaction/redaction-derivative-writer.ts).
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
import { enqueueRedactionDerivativeRender } from "../../queue/redaction-derivative-queue.js";
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

/**
 * PHASE 12B WAVE 2A — shipping scope: IMAGE + PDF render end-to-end.
 * VIDEO / AUDIO are FUTURE_NOT_SHIPPING (no temporal-region renderer exists):
 * they are rejected BEFORE any derivative row or job exists with the stable
 * UNSUPPORTED_REDACTION_MEDIA denial. The Evidence itself is never classified
 * unsupported — only its redaction-derivative capability.
 */
const SHIPPING_ARTIFACT_KINDS: ReadonlySet<RedactionArtifactKind> = new Set([
  "IMAGE",
  "PDF",
]);

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
  // FUTURE_NOT_SHIPPING media — deny BEFORE creating any record or job.
  if (!SHIPPING_ARTIFACT_KINDS.has(artifactKind)) {
    return { ok: false, denial: "UNSUPPORTED_REDACTION_MEDIA" };
  }

  const derivativeKind = ARTIFACT_TO_DERIVATIVE[artifactKind];

  // PHASE 12B DURABILITY (Correction 5): the row is committed QUEUED BEFORE
  // enqueue; ONLY the worker performs the atomic QUEUED→RENDERING claim. An
  // enqueue failure leaves a recoverable, observable QUEUED row that the
  // stranded-QUEUED reconciler re-enqueues. Retries never create a second
  // derivative (UNIQUE versionId) or a second job (stable jobId).
  let derivativeId: string;
  const existing = version.derivative;
  if (existing) {
    derivativeId = existing.id;
    if (existing.state === "QUARANTINED") {
      return { ok: false, denial: "DERIVATIVE_QUARANTINED" };
    }
    if (existing.state === "READY") {
      // Already rendered — idempotent success, no re-enqueue.
      return { ok: true, derivativeId, state: "READY" };
    }
    if (existing.state === "FAILED" || existing.state === "PENDING") {
      // Reset for a fresh render attempt. RENDERING/QUEUED rows are left
      // untouched (a live claim/job owns them) — the idempotent enqueue
      // below collapses onto the live job.
      await prisma.redactionDerivative.update({
        where: { id: derivativeId },
        data: { state: "QUEUED", failureReason: null, lastErrorPreview: null },
      });
    }
  } else {
    const created = await prisma.redactionDerivative.create({
      data: {
        teamId: input.teamId,
        versionId: input.versionId,
        kind: derivativeKind,
        state: "QUEUED",
      },
      select: { id: true },
    });
    derivativeId = created.id;
  }
  await emitRedactionActivity({
    prisma,
    teamId: input.teamId,
    projectId: version.projectId,
    versionId: input.versionId,
    code: "DERIVATIVE_REQUESTED",
    actorUserId: input.requestedByUserId,
    payload: { derivativeId, kind: derivativeKind },
  });

  const enq = await enqueueRedactionDerivativeRender({ derivativeId });
  if (!enq.enqueued) {
    // Recoverable: row stays QUEUED; reconciler will enqueue. Honest state out.
    return { ok: true, derivativeId, state: "QUEUED" };
  }
  return { ok: true, derivativeId, state: "QUEUED" };
}

// PHASE 12B WAVE 2A — the READY/FAILED completion writers were DELETED
// from the API. READY/FAILED completion has exactly ONE authority: the
// worker-side writer (services/worker/src/redaction/redaction-derivative-writer.ts)
// — atomic claim, stale-transition rejection, anti-overwrite guard, machine
// (no-session) activity attribution. The API keeps request (QUEUED-first),
// read projection, and the admin quarantine transition only.

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
