/**
 * Phase 18 — Noop messaging provider.
 *
 * Used when:
 *   - COMMUNICATIONS_ENABLED is not "true"
 *   - Twilio configuration is incomplete (any of the required env vars
 *     missing or blank)
 *
 * Every send returns a structured "skipped" failure with the reason so
 * the calling flow can audit the attempt and continue without ever
 * receiving a vendor exception. The Noop provider is also used by tests
 * that do not want to hit Twilio.
 */

import type {
  CommunicationProvider as ProviderEnum,
} from "@proovra/shared";

import type {
  MessagingProvider,
  ParsedWebhook,
  ProviderSendResult,
  ProviderVerifyCheckResult,
  ProviderVerifyStartResult,
} from "./provider.js";

export class NoopMessagingProvider implements MessagingProvider {
  readonly provider: ProviderEnum = "NOOP";

  private readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  isConfigured(): boolean {
    return false;
  }

  unconfiguredReason(): string | null {
    return this.reason;
  }

  async sendSms(): Promise<ProviderSendResult> {
    return this.failure("SMS");
  }

  async sendWhatsApp(): Promise<ProviderSendResult> {
    return this.failure("WHATSAPP");
  }

  async startVerification(): Promise<ProviderVerifyStartResult> {
    return {
      ok: false,
      provider: "NOOP",
      reason: "provider_unconfigured",
      errorCode: "noop_provider",
      errorMessage: this.reason,
    };
  }

  async checkVerification(): Promise<ProviderVerifyCheckResult> {
    return {
      ok: false,
      provider: "NOOP",
      reason: "provider_unconfigured",
      errorCode: "noop_provider",
      errorMessage: this.reason,
    };
  }

  verifyWebhookSignature(): boolean {
    // Noop provider has no shared secret to validate against; refuse
    // every callback so an attacker cannot get a "valid signature"
    // response when communications are disabled.
    return false;
  }

  parseDeliveryWebhook(): ParsedWebhook {
    return { kind: "ignored", reason: "noop_provider" };
  }

  private failure(channel: "SMS" | "WHATSAPP"): ProviderSendResult {
    return {
      ok: false,
      provider: "NOOP",
      channel,
      reason: "provider_unconfigured",
      errorCode: "noop_provider",
      errorMessage: this.reason,
    };
  }
}
