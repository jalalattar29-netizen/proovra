/**
 * PROOVRA Phase 3A — Redaction → Verification Package manifest writer.
 *
 * Builds the bounded `RedactionVerificationManifestEntry` shape
 * consumed by the worker's verification-package pipeline. Returns
 * ONLY published versions — never DRAFT / IN_REVIEW / REJECTED
 * versions, because the verification package represents what the
 * platform asserts as the latest accountable state for the
 * evidence.
 *
 * Hard rules:
 *   * Workspace-anchored.
 *   * NEVER region geometry, NEVER detection text. Counts + hashes
 *     + approval bookkeeping only.
 *   * Offline verification must remain possible — every entry
 *     carries the derivative's `fileSha256` so a reader can verify
 *     the derivative bytes match the manifest without re-hitting
 *     the platform.
 */

import type { PrismaClient } from "@prisma/client";
import type {
  RedactionApprovalProjection,
  RedactionApprovalVerdict,
  RedactionArtifactKind,
  RedactionDerivativeKind,
  RedactionVerificationManifestEntry,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

export async function buildRedactionVerificationEntries(input: {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
}): Promise<ReadonlyArray<RedactionVerificationManifestEntry>> {
  const prisma = input.prisma ?? defaultPrisma;
  const projects = await prisma.redactionProject.findMany({
    where: { teamId: input.teamId, evidenceId: input.evidenceId },
    include: {
      versions: {
        where: { state: "PUBLISHED" },
        orderBy: { publishedAtUtc: "desc" },
        include: {
          approvals: { orderBy: { decidedAtUtc: "asc" } },
          regions: { select: { id: true } },
          derivative: true,
        },
      },
    },
  });
  const out: RedactionVerificationManifestEntry[] = [];
  for (const project of projects) {
    for (const v of project.versions) {
      out.push({
        projectId: project.id,
        evidenceId: project.evidenceId,
        artifactKind: project.artifactKind as RedactionArtifactKind,
        publishedVersion: {
          id: v.id,
          versionOrdinal: v.versionOrdinal,
          publishedAtUtc: v.publishedAtUtc?.toISOString() ?? "",
          publishedByUserId: v.authoredByUserId,
          regionCount: v.regions.length,
          derivative: v.derivative
            ? {
                kind: v.derivative.kind as RedactionDerivativeKind,
                storageKey: v.derivative.storageKey,
                byteSize: v.derivative.byteSize
                  ? Number(v.derivative.byteSize)
                  : null,
                fileSha256: v.derivative.fileSha256,
              }
            : null,
          approvals: v.approvals.map(
            (a: (typeof v.approvals)[number]): RedactionApprovalProjection => ({
              id: a.id,
              verdict: a.verdict as RedactionApprovalVerdict,
              // R7-redaction: services migrated to approverUserId as canonical actor; coalesce to legacy approvedByUserId fallback then "" so the non-null projection contract holds
              approverUserId: a.approverUserId ?? a.approvedByUserId ?? "",
              // R7-redaction: decidedAtUtc became nullable when approval workflow split into decide-then-finalize; coalesce to approvedAtUtc which is always set
              decidedAtUtc: (a.decidedAtUtc ?? a.approvedAtUtc).toISOString(),
              rationale: a.rationale,
            }),
          ),
        },
      });
    }
  }
  return out;
}
