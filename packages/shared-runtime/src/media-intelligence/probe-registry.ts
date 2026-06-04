/**
 * Wave 3 Phase 7B — Producer-mode probe registry seam.
 *
 * Background:
 *   The Wave 1 producer-mode resolver (`producer-mode.ts`) needs to
 *   consult four probes that physically live in `services/api/src/...`:
 *
 *     * `probeAzureDocumentIntelligence`   — Azure DI probe
 *     * `probeDeepgram`                    — Deepgram probe
 *     * `isSemanticReadyAtRuntime`         — semantic search readiness
 *     * `resolveEmbeddingProviderFromEnv`  — embedding provider name
 *
 *   The earlier implementation used dynamic relative-path imports
 *   from `packages/shared-runtime/...` up into `services/api/...`.
 *   That works at runtime in the monorepo layout but cannot compile
 *   inside `pnpm --filter @proovra/shared-runtime build` because
 *   the cross-package paths resolve outside `rootDir: ./src`.
 *
 * Fix:
 *   This module exposes a small registration seam. The api package
 *   bootstraps the four probes at process start via
 *   `services/api/src/services/media-intelligence/probe-bootstrap.ts`,
 *   which calls `registerProbes(...)`. The producer-mode resolver
 *   then consults `getProbes()` to read whichever probes are
 *   registered.
 *
 * Hard contracts:
 *   * NEVER cross-import services/api code from this package — the
 *     seam is the ONLY communication channel.
 *   * `getProbes()` NEVER throws. If no probes are registered the
 *     fallback returns honest NOT_CONFIGURED for every kind so the
 *     resolver collapses to NOT_CONFIGURED in environments where
 *     the api process has not bootstrapped probes (e.g. an isolated
 *     worker or a `pnpm test --filter @proovra/shared-runtime`).
 *   * `registerProbes()` is idempotent — calling it again replaces
 *     the registered set. Tests can override per-test.
 *   * Registration is process-local — there is no inter-process
 *     coupling beyond the standard module cache.
 */

export type AzureProbeShape = { state: string; reason: string | null };
export type DeepgramProbeShape = { state: string; reason: string | null };

export interface EmbeddingProviderShape {
  name?: string;
}

export interface ProducerProbeSet {
  probeAzureDocumentIntelligence: () => Promise<AzureProbeShape>;
  probeDeepgram: () => Promise<DeepgramProbeShape>;
  isSemanticReadyAtRuntime: () => boolean;
  resolveEmbeddingProviderFromEnv: () => EmbeddingProviderShape;
}

const NOT_CONFIGURED_PROBE_SET: ProducerProbeSet = {
  probeAzureDocumentIntelligence: async () => ({
    state: "NOT_CONFIGURED",
    reason: "probe_unavailable",
  }),
  probeDeepgram: async () => ({
    state: "NOT_CONFIGURED",
    reason: "probe_unavailable",
  }),
  isSemanticReadyAtRuntime: () => false,
  resolveEmbeddingProviderFromEnv: () => ({ name: "disabled" }),
};

let REGISTERED_PROBES: ProducerProbeSet | null = null;

/**
 * Register the four producer-mode probes for this process. Called
 * once at api process startup from `probe-bootstrap.ts`.
 */
export function registerProbes(probes: ProducerProbeSet): void {
  REGISTERED_PROBES = probes;
}

/**
 * Read the registered probes, or fall back to honest NOT_CONFIGURED.
 * Never throws.
 */
export function getProbes(): ProducerProbeSet {
  return REGISTERED_PROBES ?? NOT_CONFIGURED_PROBE_SET;
}

/**
 * Reset the registered probes. Used by tests and the `pnpm build`
 * verification — never call from production code paths.
 */
export function _resetProbesForTests(): void {
  REGISTERED_PROBES = null;
}
