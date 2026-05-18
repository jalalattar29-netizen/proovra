/**
 * Phase 21 — Noop observability provider.
 *
 * Used when OBSERVABILITY_ENABLED is not "true" OR when both Sentry
 * and OTEL providers are unconfigured. Every method returns immediately
 * without raising. Tests inject this directly via
 * `setObservabilityProviderForTests`.
 */

import type {
  CaptureExceptionInput,
  ObservabilityProvider,
  ObservabilitySpan,
  SpanAttributes,
} from "./provider.js";

class NoopSpan implements ObservabilitySpan {
  addEvent(_name: string, _attributes?: SpanAttributes): void {
    /* noop */
  }
  setAttribute(_key: string, _value: string | number | boolean | null): void {
    /* noop */
  }
  recordException(_err: unknown, _context?: SpanAttributes): void {
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

  startSpan(_name: string, _attributes?: SpanAttributes): ObservabilitySpan {
    return SINGLETON_SPAN;
  }

  captureException(_input: CaptureExceptionInput): void {
    /* noop */
  }

  setUserContext(_input: { userId?: string | null; teamId?: string | null }): void {
    /* noop */
  }
}
