/**
 * PROOVRA Phase 4B — Verification package lifecycle + exchange manifests.
 *
 * Produces seven OPTIONAL advisory JSON files that the verification package
 * may carry. All manifests:
 *   * Are additive only — downstream tooling works without them.
 *   * Never include raw reasons or PII.
 *   * Carry only bounded counts + bounded ids + bounded states.
 *   * Are workspace-anchored on teamId; optional evidenceId narrows scope.
 *
 * Paths under the `lifecycle/` prefix:
 *   lifecycle/lifecycle-manifest.json
 *   lifecycle/retention-manifest.json
 *   lifecycle/legal-hold-manifest.json
 *   lifecycle/archive-manifest.json
 *   lifecycle/destruction-manifest.json
 *   lifecycle/exchange-manifest.json
 *   lifecycle/transfer-manifest.json
 *
 * Shape-compatible with the API-side preview writers in
 * services/api/src/services/lifecycle/lifecycle-manifest.service.ts.
 * If you change one side, change the other.
 */

import type { PrismaClient } from "@prisma/client";

export type LifecycleManifestFileEntry = {
  path: string;
  json: unknown;
};

const MAX_IDS = 50;

/**
 * PRO-W1C-02 (RG-18) — THE SELECTION, NOT THE WORKSPACE.
 *
 * An exchange package hands SELECTED records to another party. Every family
 * here used to take "the latest row in the workspace" — another record's legal
 * hold, the last counterparty a transfer went to, another package — none of
 * them about the selection and none filtered by the requester's reach; and
 * where no row existed the file still stated an affirmative state (hold
 * ACTIVE, destruction REQUESTED, transfer INITIATED).
 *
 * Now: `evidenceIds` (the builder's scoped, reach-checked id list) is REQUIRED
 * and every family reads only rows that name a selected record. A family with
 * no matching row is OMITTED, never filled with a placeholder state.
 */
export async function buildLifecycleAndExchangeManifests(input: {
  prisma: PrismaClient;
  teamId: string;
  /** The package's scoped selection. Empty = nothing to state. */
  evidenceIds: ReadonlyArray<string>;
}): Promise<ReadonlyArray<LifecycleManifestFileEntry>> {
  const { prisma, teamId } = input;
  const ids = [...new Set(input.evidenceIds)].slice(0, 500);
  const now = new Date().toISOString();
  const out: LifecycleManifestFileEntry[] = [];
  if (ids.length === 0) return out;
  const names = (json: unknown) => Array.isArray(json) && json.some((v) => typeof v === "string" && ids.includes(v));

  let holds: Array<{ id: string; scope: string; status: string; evidenceId: string | null; createdAt: Date; releasedAtUtc: Date | null }> = [];
  let archives: Array<{ evidenceId: string; fromTier: string; toTier: string; transitionedAtUtc: Date; costEstimateUsdMicros: bigint | number }> = [];
  let destructions: Array<{ id: string; state: string; evidenceIds: unknown; certifiedAtUtc: Date | null }> = [];
  try {
    holds = (await prisma.evidenceLegalHold.findMany({
      where: { teamId, scope: "EVIDENCE", evidenceId: { in: ids } },
      orderBy: { createdAt: "desc" },
      take: MAX_IDS,
      select: { id: true, scope: true, status: true, evidenceId: true, createdAt: true, releasedAtUtc: true },
    })) as typeof holds;
  } catch {
    holds = [];
  }
  try {
    archives = (await prisma.archiveTierTransition.findMany({
      where: { teamId, evidenceId: { in: ids } },
      orderBy: { transitionedAtUtc: "desc" },
      take: MAX_IDS,
      select: { evidenceId: true, fromTier: true, toTier: true, transitionedAtUtc: true, costEstimateUsdMicros: true },
    })) as typeof archives;
  } catch {
    archives = [];
  }
  try {
    destructions = (
      (await prisma.destructionRequest.findMany({
        where: { teamId },
        orderBy: { createdAt: "desc" },
        take: 500,
        select: { id: true, state: true, evidenceIds: true, certifiedAtUtc: true },
      })) as typeof destructions
    ).filter((r) => names(r.evidenceIds));
  } catch {
    destructions = [];
  }

  // --- lifecycle-manifest.json: counts about the SELECTION ---
  out.push({
    path: "lifecycle/lifecycle-manifest.json",
    json: {
      schemaVersion: "PROOVRA_LIFECYCLE_MANIFEST_V1",
      generatedAtUtc: now,
      teamId,
      selectedRecordCount: ids.length,
      totalLegalHolds: holds.length,
      totalArchiveTransitions: archives.length,
      totalDestructionRequests: destructions.length,
    },
  });

  // --- legal-hold-manifest.json: only a hold that names a selected record ---
  const hold = holds[0];
  if (hold) {
    out.push({
      path: "lifecycle/legal-hold-manifest.json",
      json: {
        schemaVersion: "PROOVRA_LEGAL_HOLD_MANIFEST_V1",
        generatedAtUtc: now,
        holdId: hold.id,
        kind: hold.scope,
        state: hold.status,
        scopeTargetId: hold.evidenceId,
        createdAt: hold.createdAt.toISOString(),
        releasedAtUtc: hold.releasedAtUtc?.toISOString() ?? null,
      },
    });
  }

  // --- archive-manifest.json ---
  const archive = archives[0];
  if (archive) {
    out.push({
      path: "lifecycle/archive-manifest.json",
      json: {
        schemaVersion: "PROOVRA_ARCHIVE_MANIFEST_V1",
        generatedAtUtc: now,
        evidenceId: archive.evidenceId,
        fromTier: archive.fromTier,
        toTier: archive.toTier,
        transitionedAtUtc: archive.transitionedAtUtc.toISOString(),
        costEstimateUsdMicros: Number(archive.costEstimateUsdMicros),
      },
    });
  }

  // --- destruction-manifest.json ---
  const destruction = destructions[0];
  if (destruction) {
    const cert = await prisma.destructionCertificate
      .findFirst({ where: { requestId: destruction.id }, select: { certificateHash: true, evidenceCount: true } })
      .catch(() => null);
    out.push({
      path: "lifecycle/destruction-manifest.json",
      json: {
        schemaVersion: "PROOVRA_DESTRUCTION_MANIFEST_V1",
        generatedAtUtc: now,
        requestId: destruction.id,
        state: destruction.state,
        evidenceCount:
          cert?.evidenceCount ?? (Array.isArray(destruction.evidenceIds) ? destruction.evidenceIds.length : 0),
        certifiedAtUtc: destruction.certifiedAtUtc?.toISOString() ?? null,
        certificateHash: cert?.certificateHash ?? null,
      },
    });
  }

  // Other exchange packages and chain transfers are the workspace's
  // relationships with third parties, not facts about this selection: they are
  // never written into an exchange package.
  return out;
}

