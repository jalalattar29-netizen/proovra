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
 *   The projection logic lives next to this loader in
 *   `./provenance-projection.ts` — a worker-local PURE Prisma
 *   projection that depends only on `@prisma/client` and
 *   `@proovra/shared` (the same two deps the worker already carries).
 *   It is byte-for-byte equivalent to the API copy at
 *   `services/api/src/services/capture-trust/provenance-projection.service.ts`;
 *   contract drift between the two surfaces as a typecheck failure
 *   against the shared `ProvenanceChain` type.
 *
 * Hard rules:
 *   * Never throws — returns null on any failure so the package
 *     still builds.
 *   * Bounded shape; no provider raw bytes; no operator-internal
 *     identifiers beyond what the projection emits.
 */

import type { ProvenanceChain } from "@proovra/shared";

import { projectProvenanceChain } from "./provenance-projection.js";

export async function loadProvenanceChainForPackage(
  evidenceId: string,
): Promise<ProvenanceChain | null> {
  if (!evidenceId) return null;
  try {
    return await projectProvenanceChain({ evidenceId });
  } catch {
    return null;
  }
}
