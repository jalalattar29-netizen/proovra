/**
 * Phase 1B Closure — worker-side ProvenanceChain loader.
 *
 * Thin adapter that loads the bounded ProvenanceChain so the worker's
 * verification-package builder can include `provenance/chain.json`.
 *
 * The chain assembly logic lives in the API service
 * (`services/api/src/services/capture-trust/provenance-projection.service.ts`).
 * We re-use it here by lazy-importing — the worker shares the same
 * Prisma client, so the projection runs identically.
 *
 * Hard rules:
 *   * Never throws — returns null on any failure so the package
 *     still builds.
 *   * Bounded shape; no provider raw bytes; no operator-internal
 *     identifiers beyond what the projection emits.
 */

import type { ProvenanceChain } from "@proovra/shared";

export async function loadProvenanceChainForPackage(
  evidenceId: string,
): Promise<ProvenanceChain | null> {
  if (!evidenceId) return null;
  try {
    // Lazy import so the API path is not required by the worker bundle
    // when the trust pipeline is disabled.
    const mod = await import(
      "../../../api/src/services/capture-trust/provenance-projection.service.js"
    );
    if (typeof mod?.projectProvenanceChain !== "function") return null;
    return await mod.projectProvenanceChain({ evidenceId });
  } catch {
    return null;
  }
}
