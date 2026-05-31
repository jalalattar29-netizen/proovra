/**
 * PROOVRA Phase 3A — Redaction project projection.
 *
 * Single bounded read that assembles the redaction workspace view for
 * one project — versions, regions, detection summaries, approvals,
 * derivative, standing limitations. Consumed by:
 *
 *   * the API GET /v1/redaction/projects/:id route,
 *   * the reviewer UI workspace page,
 *   * the reviewer-workspace aggregator (for queue counts),
 *   * the verification-package builder (manifest).
 *
 * Hard rules:
 *   * Workspace-anchored — every join filters on teamId.
 *   * NEVER exposes raw provider error text; honest bounded counts only.
 *   * Output schema is pinned by REDACTION_PROJECTION_SCHEMA_VERSION
 *     so consumers can refuse a version drift.
 */

import type { PrismaClient } from "@prisma/client";
import {
  REDACTION_PROJECTION_SCHEMA_VERSION,
  REDACTION_PROVENANCE_LIMITATIONS,
  type RedactionApprovalProjection,
  type RedactionApprovalVerdict,
  type RedactionArtifactKind,
  type RedactionDenialReason,
  type RedactionDerivativeKind,
  type RedactionDerivativeProjection,
  type RedactionDerivativeState,
  type RedactionMethod,
  type RedactionProjectProjection,
  type RedactionProjectState,
  type RedactionRegionKind,
  type RedactionRegionProjection,
  type RedactionVersionProjection,
  type RedactionVersionState,
  type RedactionDetectionProvider,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

export type ProjectProjectionResult =
  | { ok: true; projection: RedactionProjectProjection }
  | { ok: false; denial: RedactionDenialReason };

export async function projectRedactionProject(input: {
  prisma?: PrismaClient;
  teamId: string;
  projectId: string;
}): Promise<ProjectProjectionResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const project = await prisma.redactionProject.findFirst({
    where: { id: input.projectId, teamId: input.teamId },
    include: {
      versions: {
        orderBy: { versionOrdinal: "desc" },
        include: {
          regions: { orderBy: { createdAt: "asc" } },
          approvals: { orderBy: { decidedAtUtc: "asc" } },
          derivative: true,
          detections: {
            select: { decisionState: true },
          },
        },
      },
    },
  });
  if (!project) return { ok: false, denial: "PROJECT_NOT_FOUND" };

  const versions: RedactionVersionProjection[] = project.versions.map((v) => projectVersion(v));
  const publishedVersion =
    versions.find((v) => v.state === "PUBLISHED") ?? null;

  return {
    ok: true,
    projection: {
      schemaVersion: REDACTION_PROJECTION_SCHEMA_VERSION,
      generatedAtUtc: new Date().toISOString(),
      id: project.id,
      teamId: project.teamId,
      evidenceId: project.evidenceId,
      artifactKind: project.artifactKind as RedactionArtifactKind,
      title: project.title,
      state: project.state as RedactionProjectState,
      createdByUserId: project.createdByUserId,
      createdAtUtc: project.createdAt.toISOString(),
      publishedVersion,
      versions,
      limitations: REDACTION_PROVENANCE_LIMITATIONS,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — bounded mappers
// ---------------------------------------------------------------------------

// R7-redaction: nullability + extra fields match the Prisma row shape after the R7 trust+redaction
// schema fix. Projection callsites in projectVersion() coalesce nullable fields to non-null projection
// contract values; extra fields (projectId, teamId, label, etc.) are ignored by projectVersion.
type VersionWithChildren = {
  id: string;
  projectId: string;
  teamId: string;
  versionOrdinal: number;
  state: string;
  artifactKind: string | null;
  createdByUserId: string | null;
  authoredByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  submittedAtUtc: Date | null;
  approvedAtUtc: Date | null;
  publishedAtUtc: Date | null;
  supersededAtUtc: Date | null;
  rationale: string | null;
  regions: Array<{
    id: string;
    versionId: string;
    teamId: string;
    kind: string;
    method: string;
    geometry: unknown;
    label: string | null;
    createdAt: Date;
    updatedAt: Date;
    rationale: string | null;
    sourceDetectionId: string | null;
    sourceProvider: string | null;
    authoredByUserId: string | null;
  }>;
  approvals: Array<{
    id: string;
    teamId: string;
    versionId: string;
    createdAt: Date;
    verdict: string;
    approverUserId: string | null;
    approvedByUserId: string | null;
    decidedAtUtc: Date | null;
    approvedAtUtc: Date;
    rationale: string | null;
  }>;
  derivative:
    | {
        id: string;
        kind: string;
        state: string;
        storageKey: string | null;
        storageBucket: string | null;
        byteSize: bigint | null;
        fileSha256: string | null;
        renderedAtUtc: Date | null;
        failureReason: string | null;
      }
    | null;
  detections: ReadonlyArray<{ decisionState: string | null }>;
};

function projectVersion(v: VersionWithChildren): RedactionVersionProjection {
  return {
    id: v.id,
    versionOrdinal: v.versionOrdinal,
    state: v.state as RedactionVersionState,
    // R7-redaction: schema relaxed authoredByUserId to nullable for legacy rows; projection contract is non-null
    authoredByUserId: v.authoredByUserId ?? "",
    createdAtUtc: v.createdAt.toISOString(),
    submittedAtUtc: v.submittedAtUtc?.toISOString() ?? null,
    approvedAtUtc: v.approvedAtUtc?.toISOString() ?? null,
    publishedAtUtc: v.publishedAtUtc?.toISOString() ?? null,
    rationale: v.rationale,
    regionCount: v.regions.length,
    acceptedDetectionCount: v.detections.filter(
      (d) => d.decisionState === "ACCEPTED" || d.decisionState === "MODIFIED",
    ).length,
    rejectedDetectionCount: v.detections.filter(
      (d) => d.decisionState === "REJECTED",
    ).length,
    approvals: v.approvals.map(
      (a): RedactionApprovalProjection => ({
        id: a.id,
        verdict: a.verdict as RedactionApprovalVerdict,
        // R7-redaction: approverUserId is canonical actor; fall back to legacy approvedByUserId, then "" to honour non-null projection contract
        approverUserId: a.approverUserId ?? a.approvedByUserId ?? "",
        // R7-redaction: decidedAtUtc became nullable when approval workflow split into decide-then-finalize; fall back to approvedAtUtc which is always set
        decidedAtUtc: (a.decidedAtUtc ?? a.approvedAtUtc).toISOString(),
        rationale: a.rationale,
      }),
    ),
    derivative: v.derivative
      ? ({
          id: v.derivative.id,
          kind: v.derivative.kind as RedactionDerivativeKind,
          state: v.derivative.state as RedactionDerivativeState,
          storageKey: v.derivative.storageKey,
          storageBucket: v.derivative.storageBucket,
          byteSize: v.derivative.byteSize
            ? Number(v.derivative.byteSize)
            : null,
          fileSha256: v.derivative.fileSha256,
          renderedAtUtc: v.derivative.renderedAtUtc?.toISOString() ?? null,
          failureReason: v.derivative.failureReason,
        } satisfies RedactionDerivativeProjection)
      : null,
  };
}

/**
 * Lightweight workspace-aggregator helper. Counts redaction queue
 * states for the reviewer landing page. The reviewer workspace
 * service composes this into its `RedactionReviewerSummary`.
 */
export async function summariseRedactionQueueForTeam(input: {
  prisma?: PrismaClient;
  teamId: string;
}): Promise<{
  pendingDecisionCount: number;
  awaitingApprovalCount: number;
  approvedPendingDerivativeCount: number;
  publishedCount: number;
  rejectedCount: number;
}> {
  const prisma = input.prisma ?? defaultPrisma;
  const [pendingDecisions, inReview, approvedReady, published, rejected] =
    await Promise.all([
      prisma.redactionDetection.count({
        where: { teamId: input.teamId, decisionState: "SUGGESTED" },
      }),
      prisma.redactionVersion.count({
        where: { teamId: input.teamId, state: "IN_REVIEW" },
      }),
      prisma.redactionVersion.count({
        where: {
          teamId: input.teamId,
          state: "APPROVED",
          derivative: { is: { state: { not: "READY" } } },
        },
      }),
      prisma.redactionVersion.count({
        where: { teamId: input.teamId, state: "PUBLISHED" },
      }),
      prisma.redactionVersion.count({
        where: { teamId: input.teamId, state: "REJECTED" },
      }),
    ]);
  return {
    pendingDecisionCount: pendingDecisions,
    awaitingApprovalCount: inReview,
    approvedPendingDerivativeCount: approvedReady,
    publishedCount: published,
    rejectedCount: rejected,
  };
}

// Compile-time check the orchestrator stays in sync with bounded types.
function _assertUsedTypes(): void {
  const _kind: RedactionRegionKind = "BBOX_NORMALIZED";
  const _method: RedactionMethod = "BLACKOUT";
  const _provider: RedactionDetectionProvider = "MANUAL";
  const _region: RedactionRegionProjection = {
    id: "00000000-0000-0000-0000-000000000000",
    kind: _kind,
    method: _method,
    geometry: {},
    createdAtUtc: "1970-01-01T00:00:00Z",
    rationale: null,
    sourceDetectionId: null,
    sourceProvider: _provider,
    authoredByUserId: "00000000-0000-0000-0000-000000000000",
  };
  void _region;
}
void _assertUsedTypes;
