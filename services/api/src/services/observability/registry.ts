/**
 * Phase 21 — Observability provider registry.
 *
 * Resolves the active ObservabilityProvider once per process:
 *
 *   OBSERVABILITY_ENABLED !== "true"                   → Noop
 *   SENTRY_ENABLED === "true" && SENTRY_DSN present    → Sentry
 *   else                                               → Noop
 *
 * Tests inject via `setObservabilityProviderForTests`.
 */

import { bump } from "../ops/metrics.service.js";

import { NoopObservabilityProvider } from "./noop-provider.js";
import type { ObservabilityProvider } from "./provider.js";
import { SentryObservabilityProvider } from "./sentry-provider.js";

let cached: ObservabilityProvider | null = null;

export function isObservabilityFeatureEnabled(): boolean {
  return process.env.OBSERVABILITY_ENABLED === "true";
}

export function getObservabilityProvider(): ObservabilityProvider {
  if (cached) return cached;
  if (!isObservabilityFeatureEnabled()) {
    cached = new NoopObservabilityProvider();
    return cached;
  }
  const sentryOn = process.env.SENTRY_ENABLED === "true";
  const sentryDsn = (process.env.SENTRY_DSN ?? "").trim();
  if (sentryOn && sentryDsn.length > 0) {
    cached = new SentryObservabilityProvider();
    if (cached.isReady()) {
      bump("observability_provider_init");
    }
    return cached;
  }
  cached = new NoopObservabilityProvider();
  return cached;
}

export type ObservabilityProviderHealth = {
  enabled: boolean;
  provider: "noop" | "sentry" | "otel";
  ready: boolean;
};

export function buildObservabilityHealth(): ObservabilityProviderHealth {
  const enabled = isObservabilityFeatureEnabled();
  const p = getObservabilityProvider();
  return {
    enabled,
    provider: p.name,
    ready: p.isReady(),
  };
}

export function setObservabilityProviderForTests(
  provider: ObservabilityProvider | null,
): void {
  cached = provider;
}
