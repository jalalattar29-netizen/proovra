/**
 * Phase 18 — Provider registry.
 *
 * Resolves the active MessagingProvider once per process. The selection
 * is deterministic and read at first use:
 *
 *   MESSAGING_TRANSPORT=recording        → RecordingMessagingProvider (PHASE 13,
 *                                          non-production processes ONLY; a
 *                                          production process asking for it
 *                                          throws rather than being served)
 *   COMMUNICATIONS_ENABLED !== "true"   → NoopMessagingProvider("feature_disabled")
 *   Twilio env incomplete                → NoopMessagingProvider("<reason>")
 *   else                                 → TwilioMessagingProvider
 *
 * With `MESSAGING_TRANSPORT` unset the last three lines are the whole table,
 * which is exactly the resolution this registry has always had.
 *
 * Tests may inject a provider via `setMessagingProviderForTests`. The
 * registry is intentionally simple — no DI container, no per-team
 * overrides in Phase 18 (per-team provider routing is deferred).
 */

import type { MessagingProvider } from "./provider.js";
import { NoopMessagingProvider } from "./noop-provider.js";
import {
  RecordingMessagingProvider,
  RecordingProviderNotPermittedError,
  isProductionRuntime,
} from "./recording-provider.js";
import {
  TwilioMessagingProvider,
  readTwilioConfigFromEnv,
} from "./twilio-provider.js";

const COMMS_FLAG_ENV = "COMMUNICATIONS_ENABLED";
const TRANSPORT_ENV = "MESSAGING_TRANSPORT";

let cached: MessagingProvider | null = null;

export function isCommunicationsFeatureEnabled(): boolean {
  return process.env[COMMS_FLAG_ENV] === "true";
}

/**
 * WHICH vendor boundary this process sends through.
 *
 * PHASE 13. Modelled directly on `resolveEmailTransportProvider` in
 * `@proovra/shared-runtime`: the ENVIRONMENT names the transport, and this
 * function only reads the name. There is no scenario-name matching, no URL
 * sniffing, and no inference from NODE_ENV about which transport is WANTED.
 *
 * NODE_ENV appears here for exactly one purpose — a REFUSAL. The recording
 * transport stores one-time codes in a local file; selecting it in a deployment
 * would silently swallow real security codes, so a production-shaped process
 * that is asked for it fails loudly at resolution rather than quietly serving
 * a provider that eats the codes. Failing loud is the correct trade: the only
 * way to reach this throw is for a deployment to have explicitly set
 * `MESSAGING_TRANSPORT=recording`, and a boot failure is strictly better than
 * an OTP that never arrives and no one notices.
 *
 * OMISSION CHANGES NOTHING. An unset — or unrecognised — value resolves to
 * `twilio`, which is precisely the resolution this registry has always had.
 */
export type MessagingTransport = "twilio" | "recording";

export function resolveMessagingTransport(): MessagingTransport {
  const raw = (process.env[TRANSPORT_ENV] ?? "").trim().toLowerCase();
  if (raw !== "recording") return "twilio";
  if (isProductionRuntime()) {
    throw new RecordingProviderNotPermittedError(`${TRANSPORT_ENV}=recording`);
  }
  return "recording";
}

export function getMessagingProvider(): MessagingProvider {
  if (cached) return cached;
  // The transport selection is read FIRST, and deliberately so — the same shape
  // `EMAIL_TRANSPORT=recording` has, where naming the recorder is sufficient
  // and no second flag is consulted.
  //
  // `COMMUNICATIONS_ENABLED` exists to say whether a VENDOR boundary is wired
  // for this deployment; it is the reason the Twilio branch below can assume it
  // is allowed to reach a network. An explicit `MESSAGING_TRANSPORT=recording`
  // is the stronger and more specific statement — "this process's messaging
  // boundary IS the local recorder" — and it can only ever be made by a
  // non-production process, because the resolver refuses it anywhere else. So
  // there is no deployment in which this ordering can switch a vendor on.
  if (resolveMessagingTransport() === "recording") {
    cached = new RecordingMessagingProvider();
    return cached;
  }
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
  /**
   * `INTERNAL` is the PHASE 13 recording provider. It is reported honestly
   * rather than folded into `TWILIO`: an operator surface that showed a
   * recording run as a configured Twilio deployment would be the one lie this
   * snapshot exists to prevent.
   */
  provider: "TWILIO" | "NOOP" | "INTERNAL";
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
  if (provider.provider === "INTERNAL") {
    return {
      communicationsEnabled: enabled,
      provider: "INTERNAL",
      configured: true,
      unconfiguredReason: null,
      capabilities: { sms: true, whatsapp: true, verify: true },
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
