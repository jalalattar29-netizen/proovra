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
export class NoopMessagingProvider {
    provider = "NOOP";
    reason;
    constructor(reason) {
        this.reason = reason;
    }
    isConfigured() {
        return false;
    }
    unconfiguredReason() {
        return this.reason;
    }
    async sendSms(_input) {
        return this.failure("SMS");
    }
    async sendWhatsApp(_input) {
        return this.failure("WHATSAPP");
    }
    async startVerification(_input) {
        return {
            ok: false,
            provider: "NOOP",
            reason: "provider_unconfigured",
            errorCode: "noop_provider",
            errorMessage: this.reason,
        };
    }
    async checkVerification(_input) {
        return {
            ok: false,
            provider: "NOOP",
            reason: "provider_unconfigured",
            errorCode: "noop_provider",
            errorMessage: this.reason,
        };
    }
    verifyWebhookSignature(_input) {
        // Noop provider has no shared secret to validate against; refuse
        // every callback so an attacker cannot get a "valid signature"
        // response when communications are disabled.
        return false;
    }
    parseDeliveryWebhook(_input) {
        return { kind: "ignored", reason: "noop_provider" };
    }
    failure(channel) {
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
