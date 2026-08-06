/**
 * Phase 21 — Noop observability provider.
 *
 * Used when OBSERVABILITY_ENABLED is not "true" OR when both Sentry
 * and OTEL providers are unconfigured. Every method returns immediately
 * without raising. Tests inject this directly via
 * `setObservabilityProviderForTests`.
 */

import type {
  ObservabilityProvider,
  ObservabilitySpan,
} from "./provider.js";

class NoopSpan implements ObservabilitySpan {
  addEvent(): void {
    /* noop */
  }
  setAttribute(): void {
    /* noop */
  }
  recordException(): void {
    /* noop */
  }
  end(): void {
    /* noop */
  }
}

const SINGLETON_SPAN = new NoopSpan();

export class NoopObservabilityProvider implements ObservabilityProvider {
  readonly name = "noop" as const;

  isReady(): boolean {
    return false;
  }

  startSpan(): ObservabilitySpan {
    return SINGLETON_SPAN;
  }

  captureException(): void {
    /* noop */
  }

  setUserContext(): void {
    /* noop */
  }
}
