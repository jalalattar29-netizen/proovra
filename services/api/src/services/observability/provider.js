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
export {};
