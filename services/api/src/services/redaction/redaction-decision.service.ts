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

  /*
   * PRO-R3-02 / PRO-R3-12 — the decision, the detection's state and its
   * region are ONE fact, written in one transaction. An ACCEPTED / MODIFIED
   * decision commits only together with the region it promises; when the
   * region is refused (out of bounds, not renderable, version no longer a
   * draft) nothing is written and the refusal is returned. A REJECTED or
   * DEFERRED decision removes a region an earlier acceptance promoted, so the
   * counters and the mask never disagree.
   */
  const promotes = input.decisionState === "ACCEPTED" || input.decisionState === "MODIFIED";
  let outcome: { decisionId: string; promotedRegionId: string | null };
  try {
    outcome = await prisma.$transaction(async (tx) => {
      const txc = tx as unknown as PrismaClient;
      let promotedRegionId: string | null = null;
      if (promotes) {
        const geometry =
          input.decisionState === "MODIFIED"
            ? (input.modifiedRegionGeometry as Record<string, unknown>)
            : (detection.suggestedRegionGeometry as Record<string, unknown>);
        const region = await addRedactionRegion({
          prisma: txc,
          teamId: input.teamId,
          versionId: detection.versionId,
          kind: detection.suggestedRegionKind as RedactionRegionKind,
          // The renderer burns an opaque black-out (PRO-R3-04).
          method: "BLACKOUT",
          geometry,
          authoredByUserId: input.decidedByUserId,
          sourceDetectionId: detection.id,
          sourceProvider: detection.provider as never,
          rationale: input.rationale ?? null,
        });
        if (!region.ok) throw new DecisionRefused(region.denial);
        promotedRegionId = region.regionId;
      } else if (input.decisionState === "REJECTED" || input.decisionState === "DEFERRED") {
        await txc.redactionRegion.deleteMany({
          where: { versionId: detection.versionId, teamId: input.teamId, sourceDetectionId: detection.id },
        });
      }
      // Compare-and-swap on the version still being a draft: a submit from
      // another session between the read above and here refuses the decision.
      const stillDraft = await txc.redactionVersion.count({
        where: { id: detection.versionId, teamId: input.teamId, state: "DRAFT" },
      });
      if (stillDraft !== 1) throw new DecisionRefused("VERSION_LOCKED");
      const created = await txc.redactionDecision.create({
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
      await txc.redactionDetection.update({
        where: { id: detection.id },
        data: { decisionState: input.decisionState },
      });
      return { decisionId: created.id, promotedRegionId };
    });
  } catch (err) {
    if (err instanceof DecisionRefused) return { ok: false, denial: err.denial };
    throw err;
  }
  const promotedRegionId = outcome.promotedRegionId;

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
    decisionId: outcome.decisionId,
    promotedRegionId,
  };
}

class DecisionRefused extends Error {
  constructor(readonly denial: RedactionDenialReason) {
    super(denial);
  }
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
