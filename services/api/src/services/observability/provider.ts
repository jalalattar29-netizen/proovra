/**
 * Phase 21 — ObservabilityProvider interface.
 *
 * Single seam between PROOVRA code and any trace/error-reporting
 * backend (Sentry, OpenTelemetry, Datadog, ...). Routes and services
 * call this abstraction; they never import a vendor SDK directly.
 *
 * Phase 21 ships two implementations:
 *   - NoopObservabilityProvider — used when OBSERVABILITY_ENABLED is
 *     not "true". Every method returns immediately.
 *   - SentryObservabilityProvider — wraps the existing Sentry init
 *     from `services/api/src/observability/sentry.ts`. The Sentry
 *     SDK is already installed (`@sentry/node ^10.38.0`); we only add
 *     a thin wrap that exposes the observability surface uniformly.
 *
 * Adding an OpenTelemetry provider in a future phase means
 * implementing this interface and wiring it in `getObservabilityProvider`.
 * No callsite changes are needed.
 */

import type { IncidentSeverity } from "@proovra/shared";

// -----------------------------------------------------------------------------
// Surface
// -----------------------------------------------------------------------------

export type SpanAttributes = Record<string, string | number | boolean | null>;

export type ObservabilitySpan = {
  /** Add a structured event to the span. NEVER includes secrets. */
  addEvent(name: string, attributes?: SpanAttributes): void;
  /** Set a single attribute on the span. */
  setAttribute(key: string, value: string | number | boolean | null): void;
  /** Mark the span as failed with a structured exception. */
  recordException(err: unknown, context?: SpanAttributes): void;
  /** Mark span done. Caller must always call this (use try/finally). */
  end(): void;
};

export type CaptureExceptionInput = {
  err: unknown;
  /** Operator-supplied context. Sanitised + redacted by the provider. */
  context?: Record<string, unknown>;
  /** Request correlation. */
  requestId?: string | null;
  traceId?: string | null;
  userId?: string | null;
  teamId?: string | null;
  /** Operator-visible severity tier. Maps to Sentry level. */
  severity?: IncidentSeverity;
};

export interface ObservabilityProvider {
  readonly name: "noop" | "sentry" | "otel";

  /** True when the provider is configured + ready to receive events. */
  isReady(): boolean;

  /** Begin a span. Returns a span the caller MUST `end()`. */
  startSpan(name: string, attributes?: SpanAttributes): ObservabilitySpan;

  /** Report an exception out-of-band (no span needed). Never throws. */
  captureException(input: CaptureExceptionInput): void;

  /** Attach user/team context to the current scope. Never logs values. */
  setUserContext(input: { userId?: string | null; teamId?: string | null }): void;
}
