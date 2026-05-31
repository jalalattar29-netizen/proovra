/**
 * PROOVRA Phase 3A — Redaction decision service.
 *
 * The bounded "human-in-the-loop" gate. A detection is just a
 * suggestion — only a `RedactionDecision` row with state
 * ACCEPTED / MODIFIED promotes a detection into a redaction
 * region the derivative renderer will actually mask.
 *
 * Hard rules:
 *   * Decisions can only be made on detections whose version is
 *     in DRAFT.
 *   * ACCEPTED + MODIFIED both create a corresponding region.
 *   * REJECTED preserves the decision row (audit answers "why
 *     was this NOT redacted?").
 *   * Every decision emits a bounded activity event.
 */

import type { PrismaClient } from "@prisma/client";
import {
  REDACTION_DECISION_STATES,
  isValidRegionGeometry,
  type RedactionDecisionState,
  type RedactionDenialReason,
  type RedactionRegionKind,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitRedactionActivity } from "./redaction-activity.service.js";
import { addRedactionRegion } from "./redaction-region.service.js";

export type RecordDetectionDecisionInput = {
  prisma?: PrismaClient;
  teamId: string;
  detectionId: string;
  decisionState: RedactionDecisionState;
  /**
   * Required when decisionState === "MODIFIED" — the bounded new
   * geometry the reviewer drew. Refused if the geometry kind does
   * not match the detection's region kind.
   */
  modifiedRegionGeometry?: Record<string, unknown>;
  rationale?: string | null;
  decidedByUserId: string;
};

export type RecordDetectionDecisionResult =
  | {
      ok: true;
      decisionId: string;
      promotedRegionId: string | null;
    }
  | { ok: false; denial: RedactionDenialReason };

export async function recordDetectionDecision(
  input: RecordDetectionDecisionInput,
): Promise<RecordDetectionDecisionResult> {
  if (
    !(REDACTION_DECISION_STATES as ReadonlyArray<string>).includes(
      input.decisionState,
    )
  ) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const detection = await prisma.redactionDetection.findFirst({
    where: { id: input.detectionId, teamId: input.teamId },
    select: {
      id: true,
      versionId: true,
      provider: true,
      kind: true,
      suggestedRegionKind: true,
      suggestedRegionGeometry: true,
      suggestedMethod: true,
      version: { select: { state: true, projectId: true } },
    },
  });
  if (!detection) return { ok: false, denial: "DETECTION_NOT_FOUND" };
  if (detection.version.state !== "DRAFT") {
    return { ok: false, denial: "VERSION_LOCKED" };
  }
  if (
    input.decisionState === "MODIFIED" &&
    (!input.modifiedRegionGeometry ||
      !isValidRegionGeometry(
        detection.suggestedRegionKind as RedactionRegionKind,
        input.modifiedRegionGeometry,
      ))
  ) {
    return { ok: false, denial: "REGION_OUT_OF_BOUNDS" };
  }

  // Phase 4A Final Closure — REDACTION policy gate. Currently delegates
  // to the Phase 3A engine which returns ALLOW with a bounded note.
  // Wiring the surface here means future strengthening of
  // evaluateRedactionPolicy will take effect without further route edits.
  // Best-effort — failures NEVER block the human-in-the-loop flow.
  try {
    const { gateRedactionAction } = await import(
      "../../services/governance/policy-runtime-gates.service.js"
    );
    // Detection has a versionId → projectId; resolve evidenceId via project.
    const project = await prisma.redactionProject.findFirst({
      where: { id: detection.version.projectId },
      select: { evidenceId: true },
    });
    if (project?.evidenceId) {
      await gateRedactionAction({
        prisma,
        teamId: input.teamId,
        evidenceId: project.evidenceId,
      });
      // WARN / BLOCK from the gate is advisory at this stage — the gate
      // currently returns ALLOW. Log a warn on BLOCK for observability.
    }
  } catch {
    /* redaction gate is best-effort */
  }

  // Persist the decision row.
  const created = await prisma.redactionDecision.create({
    data: {
      teamId: input.teamId,
      versionId: detection.versionId,
      detectionId: detection.id,
      decisionState: input.decisionState,
      modifiedRegionGeometry:
        input.decisionState === "MODIFIED"
          ? (input.modifiedRegionGeometry as never)
          : (undefined as never),
      rationale: input.rationale?.slice(0, 600) ?? null,
      decidedByUserId: input.decidedByUserId,
    },
    select: { id: true },
  });

  // Flip the detection's latest decision state.
  await prisma.redactionDetection.update({
    where: { id: detection.id },
    data: { decisionState: input.decisionState },
  });

  // ACCEPTED / MODIFIED promote into a region on the version.
  let promotedRegionId: string | null = null;
  if (
    input.decisionState === "ACCEPTED" ||
    input.decisionState === "MODIFIED"
  ) {
    const geometry =
      input.decisionState === "MODIFIED"
        ? (input.modifiedRegionGeometry as Record<string, unknown>)
        : (detection.suggestedRegionGeometry as Record<string, unknown>);
    const region = await addRedactionRegion({
      prisma,
      teamId: input.teamId,
      versionId: detection.versionId,
      kind: detection.suggestedRegionKind as RedactionRegionKind,
      method: detection.suggestedMethod as never,
      geometry,
      authoredByUserId: input.decidedByUserId,
      sourceDetectionId: detection.id,
      sourceProvider: detection.provider as never,
      rationale: input.rationale ?? null,
    });
    if (region.ok) {
      promotedRegionId = region.regionId;
    }
  }

  const code =
    input.decisionState === "ACCEPTED"
      ? "DETECTION_ACCEPTED"
      : input.decisionState === "MODIFIED"
      ? "DETECTION_MODIFIED"
      : input.decisionState === "REJECTED"
      ? "DETECTION_REJECTED"
      : input.decisionState === "DEFERRED"
      ? "DETECTION_DEFERRED"
      : "DETECTION_GENERATED";

  await emitRedactionActivity({
    prisma,
    teamId: input.teamId,
    projectId: detection.version.projectId,
    versionId: detection.versionId,
    code,
    actorUserId: input.decidedByUserId,
    payload: {
      detectionId: detection.id,
      promotedRegionId,
      rationalePreview: input.rationale?.slice(0, 80) ?? null,
    },
  });

  return {
    ok: true,
    decisionId: created.id,
    promotedRegionId,
  };
}

export async function listDecisionsForVersion(input: {
  prisma?: PrismaClient;
  teamId: string;
  versionId: string;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.redactionDecision.findMany({
    where: { teamId: input.teamId, versionId: input.versionId },
    orderBy: { decidedAtUtc: "asc" },
  });
}
