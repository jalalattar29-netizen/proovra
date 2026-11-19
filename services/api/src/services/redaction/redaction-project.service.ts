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

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  REDACTION_ARTIFACT_KINDS,
  REDACTION_SOURCE_BYTE_BUDGET,
  isAllowedVersionTransition,
  type RedactionArtifactKind,
  type RedactionDenialReason,
  type RedactionVersionState,
} from "@proovra/shared";

import { workspaceEvidenceWhere } from "@proovra/shared-runtime";
import { evaluateDerivedProductionEligibility } from "@proovra/shared-runtime/media-intelligence";

import { prisma as defaultPrisma } from "../../db.js";
import { emitRedactionActivity } from "./redaction-activity.service.js";
import { resolveEffectivePolicy } from "./redaction-policy-store.service.js";

/**
 * PRO-R3-13 — the artifact kind is the RECORD's, not the caller's: an image
 * mime type is an IMAGE project, a PDF a PDF project, video/audio their own
 * (refused later as unsupported media). Unknown -> null (not redactable).
 */
function artifactKindForRecord(record: { mimeType: string | null; type: string | null }): RedactionArtifactKind | null {
  const m = (record.mimeType ?? "").toLowerCase();
  if (m.startsWith("image/")) return "IMAGE";
  if (m === "application/pdf") return "PDF";
  if (m.startsWith("video/")) return "VIDEO";
  if (m.startsWith("audio/")) return "AUDIO";
  if (m.length > 0) return null; // a known type no redaction renders
  // No mime type recorded (legacy): the record's capture type, where it is unambiguous.
  if (record.type === "PHOTO") return "IMAGE";
  if (record.type === "VIDEO") return "VIDEO";
  if (record.type === "AUDIO") return "AUDIO";
  return null;
}

/** Prisma's unique-constraint violation (P2002), by its stable code. */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "P2002";
}

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

  // Workspace-anchored existence check on the evidence row — through the
  // canonical workspace scope (a Personal record stored with a NULL team id
  // belongs to its owner's personal workspace).
  const evidence = await prisma.evidence.findFirst({
    where: { AND: [{ id: input.evidenceId }, await workspaceEvidenceWhere(input.teamId, prisma as never)] },
    select: { id: true, mimeType: true, sizeBytes: true, type: true },
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

  // PRO-R3-13 — a redaction starts only from a SEALED record still in
  // service (the shared derived-production rule the worker relies on).
  const eligibility = await evaluateDerivedProductionEligibility(input.evidenceId, prisma as never);
  if (!eligibility.eligible) {
    return { ok: false, denial: "EVIDENCE_NOT_ELIGIBLE" };
  }
  // The project's media is the record's own.
  // A record whose media is known must match the requested kind; a record
  // with no usable media facts (legacy DOCUMENT without a mime type) is left
  // to the caller's kind, and the renderer still fails closed on wrong media.
  const recordKind = artifactKindForRecord({ mimeType: evidence.mimeType ?? null, type: (evidence.type as string | null) ?? null });
  const knownMedia = (evidence.mimeType ?? "").length > 0 || evidence.type !== "DOCUMENT";
  if (knownMedia && recordKind !== input.artifactKind) {
    return { ok: false, denial: "ARTIFACT_NOT_REDACTABLE" };
  }
  // PRO-W2C2-04 — above the one source budget the copy could never render.
  if (evidence.sizeBytes !== null && Number(evidence.sizeBytes) > REDACTION_SOURCE_BYTE_BUDGET) {
    return { ok: false, denial: "SOURCE_TOO_LARGE" };
  }

  let created: { id: string };
  try {
    created = await prisma.redactionProject.create({
      data: {
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        artifactKind: input.artifactKind,
        title: input.title?.slice(0, 200) ?? null,
        createdByUserId: input.createdByUserId,
        // PRO-R3-13 — a declared project state (the column default OPEN is not one).
        state: "DRAFT",
      },
      select: { id: true },
    });
  } catch (err) {
    // B5B-F-203 (free audit 0ea0) — a concurrent open (double submit) won the
    // UNIQUE(teamId, evidenceId) race: answer with ITS project, never a 500.
    if (!isUniqueViolation(err)) throw err;
    const winner = await prisma.redactionProject.findFirst({
      where: { teamId: input.teamId, evidenceId: input.evidenceId },
      select: { id: true },
    });
    if (!winner) throw err;
    return { ok: true, projectId: winner.id, opened: false };
  }
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
  let created: { id: string; versionOrdinal: number };
  try {
    created = await prisma.redactionVersion.create({
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
  } catch (err) {
    // B5B-F-203 (free audit 0ea0) — a concurrent "New version" (double submit)
    // took the same ordinal (UNIQUE(projectId, versionOrdinal)): answer with
    // the version that won, never a 500 and never a second draft.
    if (!isUniqueViolation(err)) throw err;
    const winner = await prisma.redactionVersion.findFirst({
      where: { projectId: input.projectId, teamId: input.teamId, versionOrdinal: nextOrdinal },
      select: { id: true, versionOrdinal: true },
    });
    if (!winner) throw err;
    return { ok: true, versionId: winner.id, versionOrdinal: winner.versionOrdinal };
  }
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
  /**
   * Phase 3A redaction closure — when a PUBLISH transition passed the
   * step-up gate the route threads the consumed step-up challenge id
   * here so the VERSION_PUBLISHED audit row records that a fresh
   * step-up authorised the disclosure. This is bounded metadata only
   * (the challenge id, NOT the OTP / phone / session token) and reuses
   * the existing redaction activity audit path — no second audit
   * system, no new activity code.
   */
  stepUpChallengeId?: string | null;
  /**
   * PRO-094 — a write that must commit with the transition or not at all (the
   * approval verdict that drives it). Runs inside the transition's transaction,
   * after the state compare-and-swap has won.
   */
  withinTransition?: (tx: Prisma.TransactionClient) => Promise<void>;
};

/** The version's state moved between the read and the write. */
class RedactionTransitionLost extends Error {}

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
  // PRO-R3-03 — a version with nothing to mask is not submitted for approval:
  // it would render and publish an unmasked copy as "redacted".
  if (input.toState === "IN_REVIEW") {
    const regionCount = await prisma.redactionRegion.count({
      where: { versionId: input.versionId, teamId: input.teamId },
    });
    if (regionCount === 0) return { ok: false, denial: "VERSION_HAS_NO_REGIONS" };
  }
  // PRO-R3-08 — the policy's BLOCK_PUBLICATION rule is enforced where the
  // version can still be worked: a version with an undecided suggestion of a
  // blocked kind is not submitted (decisions need a DRAFT), and is not
  // published if the policy came into force after it was submitted.
  if (input.toState === "IN_REVIEW" || input.toState === "PUBLISHED") {
    const effective = await resolveEffectivePolicy({
      prisma,
      teamId: input.teamId,
      projectId: version.projectId,
    });
    const blockedKinds = Object.entries(effective.ruleActions ?? {})
      .filter(([, action]) => action === "BLOCK_PUBLICATION")
      .map(([kind]) => kind);
    if (blockedKinds.length > 0) {
      const undecided = await prisma.redactionDetection.count({
        where: {
          versionId: input.versionId,
          teamId: input.teamId,
          kind: { in: blockedKinds },
          decisionState: { in: ["SUGGESTED", "DEFERRED"] },
        },
      });
      if (undecided > 0) return { ok: false, denial: "POLICY_REJECTED" };
    }
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

  const committed = await prisma.$transaction(async (tx) => {
    /*
     * PRO-094 (FEATURES-12) — COMPARE-AND-SWAP ON THE STATE THAT WAS CHECKED.
     *
     * The transition read the state, checked the edge, and then wrote the new
     * state by id alone, so two verdicts on one IN_REVIEW version (APPROVE and
     * REQUEST_CHANGES) both passed and the last writer won: the version ended
     * in DRAFT with an APPROVE on record. The version row is now written first,
     * on the condition that it is still in the state the edge was checked
     * from; the loser changes nothing (its project update and its caller's
     * approval row roll back with it) and is refused as an invalid transition.
     */
    const swapped = await tx.redactionVersion.updateMany({
      where: { id: input.versionId, teamId: input.teamId, state: from },
      data: patch,
    });
    if (swapped.count !== 1) throw new RedactionTransitionLost();
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
    if (input.withinTransition) await input.withinTransition(tx);
    return true;
  }).catch((err: unknown) => {
    if (err instanceof RedactionTransitionLost) return false;
    throw err;
  });
  if (!committed) return { ok: false, denial: "INVALID_TRANSITION" };

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
      // Phase 3A redaction closure — record that the PUBLISH disclosure
      // was authorised by a fresh step-up. `stepUpVerified` is true only
      // when the route consumed a challenge for this publish; the
      // bounded challenge id is stored for the audit trail (never the
      // OTP / phone / session token).
      ...(input.toState === "PUBLISHED"
        ? {
            stepUpVerified: input.stepUpChallengeId != null,
            stepUpChallengeId: input.stepUpChallengeId ?? null,
            stepUpPurpose: input.stepUpChallengeId != null
              ? "REDACTION_PUBLISH"
              : null,
          }
        : {}),
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
  /** Records closed to the caller (hiddenRecordIdsInWorkspace). */
  hiddenEvidenceIds?: readonly string[];
}) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.redactionProject.findMany({
    where: {
      teamId: input.teamId,
      ...(input.hiddenEvidenceIds?.length
        ? { evidenceId: { notIn: [...input.hiddenEvidenceIds] } }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(input.limit ?? 100, 500),
  });
}
