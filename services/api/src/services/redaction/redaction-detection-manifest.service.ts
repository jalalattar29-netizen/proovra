/**
 * PROOVRA Phase 3A Closure — Detection manifest writer.
 *
 * Bounded shape consumed by the verification package + report
 * builder. For each PUBLISHED redaction version, the manifest
 * carries:
 *
 *   * Per-provider counts of suggested detections.
 *   * Per-detection-kind counts (FACE, EMAIL, ...).
 *   * Bounded breakdown of accepted / rejected / modified /
 *     deferred decisions.
 *   * Provider probe states at manifest-build time (so an offline
 *     reader can see WHY a provider produced nothing).
 *
 * Hard rules:
 *   * NEVER includes raw detection text, geometry, or rationale.
 *   * Counts + bounded enum values only.
 *   * Workspace-anchored — every read filters on teamId.
 */

import type { PrismaClient } from "@prisma/client";

import type {
  RedactionConfidenceBand,
  RedactionDecisionState,
  RedactionDetectionKind,
  RedactionDetectionProvider,
  RedactionProviderProbe,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { buildRedactionProviderHealth } from "./redaction-provider-health.service.js";

export type RedactionDetectionManifestEntry = {
  projectId: string;
  evidenceId: string;
  versionId: string;
  versionOrdinal: number;
  publishedAtUtc: string | null;
  totalDetections: number;
  perProvider: Partial<Record<RedactionDetectionProvider, number>>;
  perKind: Partial<Record<RedactionDetectionKind, number>>;
  perDecision: Partial<Record<RedactionDecisionState, number>>;
  perConfidence: Partial<Record<RedactionConfidenceBand, number>>;
  providerProbes: ReadonlyArray<RedactionProviderProbe>;
};

export type RedactionDetectionManifest = {
  schemaVersion: "PROOVRA_REDACTION_DETECTION_MANIFEST_V1";
  generatedAtUtc: string;
  teamId: string;
  evidenceId: string;
  entries: ReadonlyArray<RedactionDetectionManifestEntry>;
};

export async function buildRedactionDetectionManifest(input: {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
}): Promise<RedactionDetectionManifest> {
  const prisma = input.prisma ?? defaultPrisma;
  const project = await prisma.redactionProject.findFirst({
    where: { teamId: input.teamId, evidenceId: input.evidenceId },
    select: {
      id: true,
      versions: {
        where: { state: "PUBLISHED" },
        orderBy: { publishedAtUtc: "desc" },
        select: {
          id: true,
          versionOrdinal: true,
          publishedAtUtc: true,
          detections: {
            select: {
              kind: true,
              provider: true,
              confidenceBand: true,
              decisionState: true,
            },
          },
        },
      },
    },
  });
  const probes = (await buildRedactionProviderHealth({
    teamId: input.teamId,
  })).map(
    (p): RedactionProviderProbe => ({
      provider: p.provider,
      state: p.state,
      reason: p.reason,
    }),
  );
  const entries: RedactionDetectionManifestEntry[] = [];
  for (const v of project?.versions ?? []) {
    const perProvider: Partial<Record<RedactionDetectionProvider, number>> = {};
    const perKind: Partial<Record<RedactionDetectionKind, number>> = {};
    const perDecision: Partial<Record<RedactionDecisionState, number>> = {};
    const perConfidence: Partial<Record<RedactionConfidenceBand, number>> = {};
    for (const d of v.detections) {
      perProvider[d.provider as RedactionDetectionProvider] =
        (perProvider[d.provider as RedactionDetectionProvider] ?? 0) + 1;
      perKind[d.kind as RedactionDetectionKind] =
        (perKind[d.kind as RedactionDetectionKind] ?? 0) + 1;
      perDecision[d.decisionState as RedactionDecisionState] =
        (perDecision[d.decisionState as RedactionDecisionState] ?? 0) + 1;
      perConfidence[d.confidenceBand as RedactionConfidenceBand] =
        (perConfidence[d.confidenceBand as RedactionConfidenceBand] ?? 0) + 1;
    }
    entries.push({
      projectId: project!.id,
      evidenceId: input.evidenceId,
      versionId: v.id,
      versionOrdinal: v.versionOrdinal,
      publishedAtUtc: v.publishedAtUtc?.toISOString() ?? null,
      totalDetections: v.detections.length,
      perProvider,
      perKind,
      perDecision,
      perConfidence,
      providerProbes: probes,
    });
  }
  return {
    schemaVersion: "PROOVRA_REDACTION_DETECTION_MANIFEST_V1",
    generatedAtUtc: new Date().toISOString(),
    teamId: input.teamId,
    evidenceId: input.evidenceId,
    entries,
  };
}
