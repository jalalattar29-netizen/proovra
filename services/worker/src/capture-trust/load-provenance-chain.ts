/**
 * Phase 1B Closure — worker-side ProvenanceChain loader.
 *
 * Thin adapter that loads the bounded ProvenanceChain so the worker's
 * verification-package builder can include `provenance/chain.json`.
 *
 * Boundary discipline:
 *   This loader MUST NOT import from `services/api/src/...`. The
 *   worker and the API ship as SEPARATE Docker images; the API source
 *   tree is not copied into the worker image. Cross-service `src`
 *   imports also break TS resolution under the worker's tsconfig and
 *   break Phase 2.7C image-layer caching.
 *
 *   UC-0 — the projection is THE shared implementation in
 *   `@proovra/shared-runtime` (`loadProvenanceChain`), which the API uses
 *   too. The worker-local copy it replaced inferred the capture mode from
 *   `uploadSource` / `captureMethod`; it was deleted, so the chain a package
 *   ships cannot drift from the chain the API serves.
 *
 * Hard rules:
 *   * Never throws — returns null on any failure so the package
 *     still builds.
 *   * Bounded shape; no provider raw bytes; no operator-internal
 *     identifiers beyond what the projection emits.
 */

import type { ProvenanceChainProjection } from "@proovra/shared-runtime";

import { loadProvenanceChain, loadTrustEventRecords } from "@proovra/shared-runtime";

import { prisma } from "../db.js";

export async function loadProvenanceChainForPackage(
  evidenceId: string,
): Promise<ProvenanceChainProjection | null> {
  if (!evidenceId) return null;
  try {
    // UC-TRUST-004 — the package carries the trust-event rows with their hashes,
    // so a reviewer can recompute the capture sub-chain.
    const chain = await loadProvenanceChain(prisma, evidenceId);
    return { ...chain, trustEventRecords: await loadTrustEventRecords(prisma, evidenceId) };
  } catch {
    return null;
  }
}
