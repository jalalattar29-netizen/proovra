/**
 * PROOVRA Phase 4A Closure — Verification package trust + governance manifests.
 *
 * Produces five OPTIONAL advisory JSON files that the verification package
 * may carry (intelligence/trust-, governance-, methodology-, ai-disclosure-
 * and subprocessor-manifest.json).
 *
 * RG-20 / PRO-G2-01: the Worker no longer keeps its own copy of these
 * queries. Four of them lacked the workspace predicate and sealed every
 * tenant's published articles and subprocessor names into this workspace's
 * immutable package. The ONE builder lives in @proovra/shared-runtime and is
 * the same function the API preview route calls, so preview and package
 * cannot diverge again. Every read is anchored on `teamId` and bounded.
 */

import type { PrismaClient } from "@prisma/client";
import { buildTrustVerificationManifests } from "@proovra/shared-runtime";

export type TrustAndGovernanceManifestEntry = {
  path: string;
  json: unknown;
};

export async function buildTrustAndGovernanceManifests(input: {
  prisma: PrismaClient;
  teamId: string;
}): Promise<ReadonlyArray<TrustAndGovernanceManifestEntry>> {
  if (!input.teamId) return [];
  return buildTrustVerificationManifests({ prisma: input.prisma, teamId: input.teamId });
}
