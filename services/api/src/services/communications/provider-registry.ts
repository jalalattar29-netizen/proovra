/**
 * Phase 18 — Provider registry.
 *
 * Resolves the active MessagingProvider once per process. The selection
 * is deterministic and read at first use:
 *
 *   COMMUNICATIONS_ENABLED !== "true"   → NoopMessagingProvider("feature_disabled")
 *   Twilio env incomplete                → NoopMessagingProvider("<reason>")
 *   else                                 → TwilioMessagingProvider
 *
 * Tests may inject a provider via `setMessagingProviderForTests`. The
 * registry is intentionally simple — no DI container, no per-team
 * overrides in Phase 18 (per-team provider routing is deferred).
 */

import type { MessagingProvider } from "./provider.js";
import { NoopMessagingProvider } from "./noop-provider.js";
import {
  TwilioMessagingProvider,
  readTwilioConfigFromEnv,
} from "./twilio-provider.js";

const COMMS_FLAG_ENV = "COMMUNICATIONS_ENABLED";

let cached: MessagingProvider | null = null;

export function isCommunicationsFeatureEnabled(): boolean {
  return process.env[COMMS_FLAG_ENV] === "true";
}

export function getMessagingProvider(): MessagingProvider {
  if (cached) return cached;
  if (!isCommunicationsFeatureEnabled()) {
    cached = new NoopMessagingProvider("feature_disabled");
    return cached;
  }
  const { config, reason } = readTwilioConfigFromEnv();
  if (!config) {
    cached = new NoopMessagingProvider(reason ?? "twilio_unconfigured");
    return cached;
  }
  cached = new TwilioMessagingProvider(config);
  return cached;
}

/**
 * Operator-facing health snapshot. Reports whether the provider is
 * configured WITHOUT exposing any secret values.
 */
export type ProviderHealthSnapshot = {
  communicationsEnabled: boolean;
  provider: "TWILIO" | "NOOP";
  configured: boolean;
  unconfiguredReason: string | null;
  capabilities: {
    sms: boolean;
    whatsapp: boolean;
    verify: boolean;
  };
};

export function buildProviderHealthSnapshot(): ProviderHealthSnapshot {
  const enabled = isCommunicationsFeatureEnabled();
  const provider = getMessagingProvider();
  if (provider.provider === "NOOP") {
    return {
      communicationsEnabled: enabled,
      provider: "NOOP",
      configured: false,
      unconfiguredReason: provider.unconfiguredReason(),
      capabilities: { sms: false, whatsapp: false, verify: false },
    };
  }
  const { config } = readTwilioConfigFromEnv();
  return {
    communicationsEnabled: enabled,
    provider: "TWILIO",
    configured: true,
    unconfiguredReason: null,
    capabilities: {
      sms: Boolean(config?.messagingServiceSid || config?.smsFromNumber),
      whatsapp: Boolean(config?.messagingServiceSid || config?.whatsappNumber),
      verify: Boolean(config?.verifyServiceSid),
    },
  };
}

// -----------------------------------------------------------------------------
// Test injection
// -----------------------------------------------------------------------------

export function setMessagingProviderForTests(
  provider: MessagingProvider | null,
): void {
  cached = provider;
}
