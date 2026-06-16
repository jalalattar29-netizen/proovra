/**
 * Phase 18 — Messaging provider abstraction.
 *
 * The communication service NEVER imports a vendor SDK directly. It
 * calls one of the provider implementations behind this interface:
 *
 *   - TwilioMessagingProvider — production provider (SMS / WhatsApp /
 *     Verify start+check / webhook signature validation + parsing).
 *   - NoopMessagingProvider   — used when COMMUNICATIONS_ENABLED is
 *     false OR Twilio configuration is incomplete. Returns structured
 *     "skipped" results so the calling flow can never receive a raw
 *     vendor exception.
 *
 * Provider failures are returned as structured `ProviderSendResult`
 * objects with `ok: false` and a `reason` enum — never thrown.
 *
 * Adding a second vendor (Vonage / MessageBird / Sinch) means
 * implementing this interface and wiring it in `resolveMessagingProvider`.
 * The communication service code does not change.
 */

import type {
  CommunicationChannel,
  CommunicationProvider,
  CommunicationStatus,
} from "@proovra/shared";

// -----------------------------------------------------------------------------
// Send input + result
// -----------------------------------------------------------------------------

export type ProviderSendInput = {
  /** Destination phone in strict E.164 form (caller normalises). */
  toE164: string;
  /** Operator-controlled body — caller composes via templates. */
  body: string;
  /** Per-message correlation hint sent to the provider's status callback. */
  externalId?: string;
  /** Where the provider should POST delivery status callbacks. */
  statusCallbackUrl?: string;
};

export type ProviderSendFailureReason =
  | "provider_unconfigured"
  | "provider_feature_disabled"
  | "provider_authentication_failed"
  | "provider_rate_limited"
  | "provider_unreachable"
  | "provider_rejected_recipient"
  | "provider_rejected_body"
  | "provider_internal_error"
  | "provider_unsupported_channel";

export type ProviderSendResult =
  | {
      ok: true;
      providerMessageId: string;
      provider: CommunicationProvider;
      channel: CommunicationChannel;
      // Initial status reported by the provider. Most vendors return a
      // queued/accepted state; we map to QUEUED or SENT here. DELIVERED
      // arrives only via the inbound status callback.
      status: Extract<CommunicationStatus, "QUEUED" | "SENT">;
      // Null when status is QUEUED — the provider hasn't actually
      // sent the message yet (e.g. Twilio's `accepted`/`sending`
      // intermediate states). Set to `new Date()` when status is
      // SENT (truly handed off). Webhooks subsequently set
      // `deliveredAtUtc` on the row.
      sentAtUtc: Date | null;
    }
  | {
      ok: false;
      provider: CommunicationProvider;
      channel: CommunicationChannel;
      reason: ProviderSendFailureReason;
      errorCode: string | null;
      errorMessage: string | null;
    };

// -----------------------------------------------------------------------------
// Verify (OTP) start + check
// -----------------------------------------------------------------------------

export type ProviderVerifyStartInput = {
  toE164: string;
  channel: Extract<CommunicationChannel, "SMS" | "WHATSAPP">;
};

export type ProviderVerifyStartResult =
  | {
      ok: true;
      provider: CommunicationProvider;
      providerVerificationSid: string;
      // Provider-reported lifecycle status (e.g. "pending"); normalised
      // into a 1-line status string for audit. NEVER the code.
      providerStatus: string;
    }
  | {
      ok: false;
      provider: CommunicationProvider;
      reason: ProviderSendFailureReason;
      errorCode: string | null;
      errorMessage: string | null;
    };

export type ProviderVerifyCheckInput = {
  toE164: string;
  code: string;
  providerVerificationSid?: string | null;
};

export type ProviderVerifyCheckResult =
  | {
      ok: true;
      provider: CommunicationProvider;
      // "approved" if the code matched; any other provider status (e.g.
      // "pending") maps to ok: false with reason: not_approved.
      providerStatus: "approved";
    }
  | {
      ok: false;
      provider: CommunicationProvider;
      reason:
        | "not_approved"
        | "verification_not_found"
        | "verification_expired"
        | "provider_unreachable"
        | "provider_unconfigured"
        | "provider_internal_error";
      errorCode: string | null;
      // Generic message safe for operator logs; NEVER includes the code.
      errorMessage: string | null;
    };

// -----------------------------------------------------------------------------
// Webhook parsing + signature validation
// -----------------------------------------------------------------------------

export type WebhookSignatureInput = {
  /** The full URL the provider POSTed to, including scheme + host. */
  url: string;
  /** Raw request body bytes if signed-body verification is needed. */
  rawBody: string;
  /** All form-encoded fields the provider sent, as a flat record. */
  fields: Record<string, string>;
  /** Provider-supplied signature header (e.g. X-Twilio-Signature). */
  signatureHeader: string | null;
};

export type DeliveryStatusEvent = {
  provider: CommunicationProvider;
  providerMessageId: string;
  status: CommunicationStatus;
  errorCode: string | null;
  errorMessage: string | null;
  occurredAtUtc: Date;
};

export type InboundMessageEvent = {
  provider: CommunicationProvider;
  channel: CommunicationChannel;
  fromE164: string | null;
  toE164: string | null;
  body: string | null;
  providerMessageId: string | null;
  occurredAtUtc: Date;
};

export type ParsedWebhook =
  | { kind: "status"; event: DeliveryStatusEvent }
  | { kind: "inbound"; event: InboundMessageEvent }
  | { kind: "ignored"; reason: string };

// -----------------------------------------------------------------------------
// Provider interface
// -----------------------------------------------------------------------------

export interface MessagingProvider {
  readonly provider: CommunicationProvider;

  /** True when this provider is wired and ready to attempt sends. */
  isConfigured(): boolean;

  /** Structured reason describing why the provider is unconfigured (or null). */
  unconfiguredReason(): string | null;

  sendSms(input: ProviderSendInput): Promise<ProviderSendResult>;
  sendWhatsApp(input: ProviderSendInput): Promise<ProviderSendResult>;

  startVerification(
    input: ProviderVerifyStartInput,
  ): Promise<ProviderVerifyStartResult>;

  checkVerification(
    input: ProviderVerifyCheckInput,
  ): Promise<ProviderVerifyCheckResult>;

  verifyWebhookSignature(input: WebhookSignatureInput): boolean;

  parseDeliveryWebhook(input: {
    fields: Record<string, string>;
  }): ParsedWebhook;
}
