/**
 * Phase 18 — Twilio messaging provider.
 *
 * Hand-rolled HTTPS client (no vendor SDK dependency). Talks to the
 * Twilio REST API using API Key + API Secret (preferred over Auth
 * Token). Uses:
 *
 *   - Messaging Service SID for SMS / WhatsApp sends when configured
 *   - SMS from number / WhatsApp number as fallback / WhatsApp prefix
 *   - Verify Service SID for OTP start + check
 *
 * Signature validation follows the documented Twilio algorithm:
 *
 *   HMAC-SHA1(authToken, fullUrl + sortedFormFields.concat())
 *
 * For the API-Key / API-Secret deployment we use the API Secret as the
 * HMAC key — this matches the documented "API key webhook validation"
 * recipe. Operators with classic Auth Token can still use that path
 * via TWILIO_AUTH_TOKEN if set; the validator falls back automatically.
 *
 * Privacy:
 *   - The provider NEVER logs message bodies.
 *   - OTP codes are NEVER stored or logged.
 *   - All errors are mapped to structured failure reasons; raw vendor
 *     exception strings are truncated to 400 chars before surfacing.
 */

import { createHmac } from "node:crypto";

import type { CommunicationChannel } from "@proovra/shared";

import type {
  DeliveryStatusEvent,
  InboundMessageEvent,
  MessagingProvider,
  ParsedWebhook,
  ProviderSendFailureReason,
  ProviderSendInput,
  ProviderSendResult,
  ProviderVerifyCheckInput,
  ProviderVerifyCheckResult,
  ProviderVerifyStartInput,
  ProviderVerifyStartResult,
  WebhookSignatureInput,
} from "./provider.js";

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
const TWILIO_VERIFY_BASE = "https://verify.twilio.com/v2";

const HTTP_TIMEOUT_MS = 15_000;
const MAX_ERROR_MESSAGE_CHARS = 400;

export type TwilioProviderConfig = {
  accountSid: string;
  apiKey: string;
  apiSecret: string;
  /** Optional — preferred over the from-number when present. */
  messagingServiceSid: string | null;
  verifyServiceSid: string | null;
  smsFromNumber: string | null;
  whatsappNumber: string | null;
  /** Fallback for signature validation when API key path is not available. */
  authToken: string | null;
};

export type TwilioProviderConfigReason =
  | "account_sid_missing"
  | "api_key_missing"
  | "api_secret_missing"
  | "no_send_target_configured"
  | "verify_service_sid_missing";

export function readTwilioConfigFromEnv(): {
  config: TwilioProviderConfig | null;
  reason: TwilioProviderConfigReason | null;
} {
  const accountSid = (process.env.TWILIO_ACCOUNT_SID ?? "").trim();
  const apiKey = (process.env.TWILIO_API_KEY ?? "").trim();
  const apiSecret = (process.env.TWILIO_API_SECRET ?? "").trim();
  if (!accountSid) return { config: null, reason: "account_sid_missing" };
  if (!apiKey) return { config: null, reason: "api_key_missing" };
  if (!apiSecret) return { config: null, reason: "api_secret_missing" };
  const messagingServiceSid =
    (process.env.TWILIO_MESSAGING_SERVICE_SID ?? "").trim() || null;
  const verifyServiceSid =
    (process.env.TWILIO_VERIFY_SERVICE_SID ?? "").trim() || null;
  const smsFromNumber = (process.env.TWILIO_SMS_FROM_NUMBER ?? "").trim() || null;
  const whatsappNumber =
    (process.env.TWILIO_WHATSAPP_NUMBER ?? "").trim() || null;
  const authToken = (process.env.TWILIO_AUTH_TOKEN ?? "").trim() || null;
  if (!messagingServiceSid && !smsFromNumber && !whatsappNumber) {
    return { config: null, reason: "no_send_target_configured" };
  }
  return {
    config: {
      accountSid,
      apiKey,
      apiSecret,
      messagingServiceSid,
      verifyServiceSid,
      smsFromNumber,
      whatsappNumber,
      authToken,
    },
    reason: null,
  };
}

export class TwilioMessagingProvider implements MessagingProvider {
  readonly provider = "TWILIO" as const;

  private readonly cfg: TwilioProviderConfig;

  constructor(config: TwilioProviderConfig) {
    this.cfg = config;
  }

  isConfigured(): boolean {
    return true;
  }

  unconfiguredReason(): string | null {
    return null;
  }

  async sendSms(input: ProviderSendInput): Promise<ProviderSendResult> {
    return this.sendMessage(input, "SMS");
  }

  async sendWhatsApp(input: ProviderSendInput): Promise<ProviderSendResult> {
    if (!this.cfg.whatsappNumber && !this.cfg.messagingServiceSid) {
      return this.failure(
        "WHATSAPP",
        "provider_unsupported_channel",
        "whatsapp_unconfigured",
        "TWILIO_WHATSAPP_NUMBER not configured.",
      );
    }
    return this.sendMessage(input, "WHATSAPP");
  }

  private async sendMessage(
    input: ProviderSendInput,
    channel: Extract<CommunicationChannel, "SMS" | "WHATSAPP">,
  ): Promise<ProviderSendResult> {
    const url = `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(this.cfg.accountSid)}/Messages.json`;
    const params = new URLSearchParams();
    const to =
      channel === "WHATSAPP" ? `whatsapp:${input.toE164}` : input.toE164;
    params.set("To", to);
    params.set("Body", input.body);

    if (this.cfg.messagingServiceSid) {
      params.set("MessagingServiceSid", this.cfg.messagingServiceSid);
    } else if (channel === "WHATSAPP" && this.cfg.whatsappNumber) {
      params.set("From", `whatsapp:${this.cfg.whatsappNumber}`);
    } else if (channel === "SMS" && this.cfg.smsFromNumber) {
      params.set("From", this.cfg.smsFromNumber);
    } else {
      return this.failure(
        channel,
        "provider_unconfigured",
        "no_send_target",
        "No MessagingServiceSid or from-number configured.",
      );
    }
    if (input.statusCallbackUrl) {
      params.set("StatusCallback", input.statusCallbackUrl);
    }

    const result = await this.postForm(url, params);
    if (!result.ok) {
      return this.failure(
        channel,
        mapTransportFailure(result),
        result.errorCode,
        result.errorMessage,
      );
    }
    const body = result.json as Record<string, unknown> | null;
    const sid = body && typeof body["sid"] === "string" ? (body["sid"] as string) : null;
    const status =
      body && typeof body["status"] === "string"
        ? (body["status"] as string)
        : "queued";
    if (!sid) {
      return this.failure(
        channel,
        "provider_internal_error",
        "missing_sid",
        "Twilio did not return a message SID.",
      );
    }
    // Intake-links P0 bugfix — truthful status mapping.
    // Twilio's POST /Messages.json returns one of:
    //   queued | accepted | sending | sent | delivered | undelivered | failed
    // Previously this collapsed ANYTHING non-`queued` to "SENT". That
    // included `accepted`, which is what Twilio returns when a WhatsApp
    // sandbox recipient hasn't joined yet — the row read "SENT" forever
    // and the recipient never received anything. Map precisely:
    //   queued | accepted | sending  → QUEUED  (provider has the job,
    //                                            has not handed off yet)
    //   sent | delivered              → SENT   (truly handed off / delivered;
    //                                            the StatusCallback webhook
    //                                            will upgrade to DELIVERED
    //                                            when the carrier confirms)
    //   undelivered | failed         → caller's failure path via .ok=false
    //                                  (we keep ok=true here because the
    //                                   API call itself succeeded — those
    //                                   states come back via webhook).
    const lower = status.toLowerCase();
    const mappedStatus: "QUEUED" | "SENT" =
      lower === "sent" || lower === "delivered" ? "SENT" : "QUEUED";
    return {
      ok: true,
      providerMessageId: sid,
      provider: "TWILIO",
      channel,
      status: mappedStatus,
      sentAtUtc: mappedStatus === "SENT" ? new Date() : null,
    };
  }

  async startVerification(
    input: ProviderVerifyStartInput,
  ): Promise<ProviderVerifyStartResult> {
    if (!this.cfg.verifyServiceSid) {
      return {
        ok: false,
        provider: "TWILIO",
        reason: "provider_unconfigured",
        errorCode: "verify_service_sid_missing",
        errorMessage: "TWILIO_VERIFY_SERVICE_SID not configured.",
      };
    }
    const url = `${TWILIO_VERIFY_BASE}/Services/${encodeURIComponent(this.cfg.verifyServiceSid)}/Verifications`;
    const params = new URLSearchParams();
    params.set("To", input.toE164);
    params.set("Channel", input.channel === "WHATSAPP" ? "whatsapp" : "sms");
    const result = await this.postForm(url, params);
    if (!result.ok) {
      return {
        ok: false,
        provider: "TWILIO",
        reason: mapTransportFailure(result),
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      };
    }
    const body = result.json as Record<string, unknown> | null;
    const sid =
      body && typeof body["sid"] === "string" ? (body["sid"] as string) : null;
    const status =
      body && typeof body["status"] === "string"
        ? (body["status"] as string)
        : "pending";
    if (!sid) {
      return {
        ok: false,
        provider: "TWILIO",
        reason: "provider_internal_error",
        errorCode: "missing_verification_sid",
        errorMessage: "Twilio did not return a verification SID.",
      };
    }
    return {
      ok: true,
      provider: "TWILIO",
      providerVerificationSid: sid,
      providerStatus: status,
    };
  }

  async checkVerification(
    input: ProviderVerifyCheckInput,
  ): Promise<ProviderVerifyCheckResult> {
    if (!this.cfg.verifyServiceSid) {
      return {
        ok: false,
        provider: "TWILIO",
        reason: "provider_unconfigured",
        errorCode: "verify_service_sid_missing",
        errorMessage: "TWILIO_VERIFY_SERVICE_SID not configured.",
      };
    }
    const url = `${TWILIO_VERIFY_BASE}/Services/${encodeURIComponent(this.cfg.verifyServiceSid)}/VerificationCheck`;
    const params = new URLSearchParams();
    params.set("To", input.toE164);
    // The "Code" param value is passed straight to Twilio — NEVER
    // persisted, NEVER logged. We deliberately do not capture the code
    // in any failure path.
    params.set("Code", input.code);
    if (input.providerVerificationSid) {
      params.set("VerificationSid", input.providerVerificationSid);
    }
    const result = await this.postForm(url, params);
    if (!result.ok) {
      // 404 from Verify means the verification didn't exist (typo'd
      // SID, expired). Map to a structured reason so route layer can
      // return a generic message without leaking which case happened.
      const reason =
        result.status === 404
          ? "verification_not_found"
          : mapTransportFailureForVerify(result);
      return {
        ok: false,
        provider: "TWILIO",
        reason,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      };
    }
    const body = result.json as Record<string, unknown> | null;
    const status =
      body && typeof body["status"] === "string"
        ? (body["status"] as string)
        : "pending";
    if (status === "approved") {
      return { ok: true, provider: "TWILIO", providerStatus: "approved" };
    }
    return {
      ok: false,
      provider: "TWILIO",
      reason: "not_approved",
      errorCode: status,
      errorMessage: null,
    };
  }

  /**
   * Twilio signature validation. The canonical algorithm:
   *
   *   1. Sort the application/x-www-form-urlencoded POST params by key.
   *   2. Concatenate them onto the full URL: url + (k1 + v1) + ...
   *   3. HMAC-SHA1 with the auth token (or API secret) as the key.
   *   4. Base64-encode the digest; compare to `X-Twilio-Signature` in
   *      constant time.
   *
   * We support BOTH key paths (API secret preferred; auth token
   * fallback). Routes pass the full URL exactly as Twilio called it.
   */
  verifyWebhookSignature(input: WebhookSignatureInput): boolean {
    if (!input.signatureHeader) return false;
    const sortedKeys = Object.keys(input.fields).sort();
    let payload = input.url;
    for (const k of sortedKeys) {
      payload += k + input.fields[k];
    }
    const keys: string[] = [];
    if (this.cfg.apiSecret) keys.push(this.cfg.apiSecret);
    if (this.cfg.authToken) keys.push(this.cfg.authToken);
    for (const key of keys) {
      const computed = createHmac("sha1", key).update(payload, "utf8").digest("base64");
      if (constantTimeStringEqual(computed, input.signatureHeader)) {
        return true;
      }
    }
    return false;
  }

  parseDeliveryWebhook(input: {
    fields: Record<string, string>;
  }): ParsedWebhook {
    const fields = input.fields;
    // Inbound message (vs delivery status) is distinguished by the
    // presence of `Body` and `From` without a `MessageStatus`. We err on
    // the side of caution: ignored when ambiguous.
    if (fields.MessageStatus || fields.SmsStatus) {
      const messageStatus = (fields.MessageStatus ?? fields.SmsStatus ?? "")
        .toLowerCase()
        .trim();
      const status = mapTwilioStatusToCommunication(messageStatus);
      if (!status) return { kind: "ignored", reason: "unknown_status" };
      const event: DeliveryStatusEvent = {
        provider: "TWILIO",
        providerMessageId: (fields.MessageSid ?? "").trim(),
        status,
        errorCode: fields.ErrorCode ? fields.ErrorCode.slice(0, 64) : null,
        errorMessage: fields.ErrorMessage
          ? fields.ErrorMessage.slice(0, MAX_ERROR_MESSAGE_CHARS)
          : null,
        occurredAtUtc: new Date(),
      };
      if (!event.providerMessageId) {
        return { kind: "ignored", reason: "missing_message_sid" };
      }
      return { kind: "status", event };
    }
    if (fields.Body || fields.From) {
      const from = (fields.From ?? "").trim();
      const to = (fields.To ?? "").trim();
      const channel: CommunicationChannel = from.startsWith("whatsapp:")
        ? "WHATSAPP"
        : "SMS";
      const event: InboundMessageEvent = {
        provider: "TWILIO",
        channel,
        fromE164: stripWhatsAppPrefix(from) || null,
        toE164: stripWhatsAppPrefix(to) || null,
        body: fields.Body ?? null,
        providerMessageId: (fields.MessageSid ?? "").trim() || null,
        occurredAtUtc: new Date(),
      };
      return { kind: "inbound", event };
    }
    return { kind: "ignored", reason: "unrecognised_payload" };
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  private async postForm(
    url: string,
    body: URLSearchParams,
  ): Promise<HttpResult> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
    try {
      const auth = Buffer.from(
        `${this.cfg.apiKey}:${this.cfg.apiSecret}`,
        "utf8",
      ).toString("base64");
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        signal: ac.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        const errMsg =
          (json &&
          typeof json === "object" &&
          "message" in json &&
          typeof (json as Record<string, unknown>)["message"] === "string"
            ? ((json as Record<string, unknown>)["message"] as string)
            : text
          ).slice(0, MAX_ERROR_MESSAGE_CHARS);
        const errCode =
          json &&
          typeof json === "object" &&
          "code" in json &&
          (typeof (json as Record<string, unknown>)["code"] === "number" ||
            typeof (json as Record<string, unknown>)["code"] === "string")
            ? String((json as Record<string, unknown>)["code"])
            : String(res.status);
        return {
          ok: false,
          status: res.status,
          errorCode: errCode,
          errorMessage: errMsg,
          json: null,
        };
      }
      return { ok: true, status: res.status, json, errorCode: null, errorMessage: null };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        status: 0,
        errorCode: aborted ? "timeout" : "transport_error",
        errorMessage:
          err instanceof Error
            ? err.message.slice(0, MAX_ERROR_MESSAGE_CHARS)
            : "transport error",
        json: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private failure(
    channel: Extract<CommunicationChannel, "SMS" | "WHATSAPP">,
    reason: ProviderSendFailureReason,
    errorCode: string | null,
    errorMessage: string | null,
  ): ProviderSendResult {
    return {
      ok: false,
      provider: "TWILIO",
      channel,
      reason,
      errorCode,
      errorMessage:
        errorMessage === null
          ? null
          : errorMessage.slice(0, MAX_ERROR_MESSAGE_CHARS),
    };
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type HttpResult =
  | { ok: true; status: number; json: unknown; errorCode: null; errorMessage: null }
  | {
      ok: false;
      status: number;
      json: null;
      errorCode: string;
      errorMessage: string;
    };

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function stripWhatsAppPrefix(value: string): string {
  if (!value) return value;
  return value.startsWith("whatsapp:") ? value.slice("whatsapp:".length) : value;
}

function mapTransportFailure(
  result: Extract<HttpResult, { ok: false }>,
): ProviderSendFailureReason {
  const code = result.errorCode.toLowerCase();
  if (code === "timeout" || code === "transport_error") return "provider_unreachable";
  if (result.status === 401 || result.status === 403)
    return "provider_authentication_failed";
  if (result.status === 429) return "provider_rate_limited";
  if (result.status >= 500) return "provider_unreachable";
  // 4xx with a body — Twilio returned a specific rejection. Most common
  // codes: 21211 (invalid To), 21610 (recipient unsubscribed). We don't
  // pattern-match every code; the caller surfaces errorCode for audit.
  if (code === "21610" || code === "21612" || code === "21614")
    return "provider_rejected_recipient";
  if (code === "21617" || code === "21618") return "provider_rejected_body";
  return "provider_internal_error";
}

function mapTransportFailureForVerify(
  result: Extract<HttpResult, { ok: false }>,
):
  | "verification_expired"
  | "provider_unreachable"
  | "provider_unconfigured"
  | "provider_internal_error" {
  if (result.errorCode === "timeout" || result.errorCode === "transport_error")
    return "provider_unreachable";
  if (result.status === 401 || result.status === 403)
    return "provider_unconfigured";
  if (result.status >= 500) return "provider_unreachable";
  return "provider_internal_error";
}

function mapTwilioStatusToCommunication(
  status: string,
):
  | "QUEUED"
  | "SENT"
  | "DELIVERED"
  | "FAILED"
  | "UNDELIVERED"
  | null {
  switch (status) {
    case "queued":
    case "accepted":
    case "scheduled":
      return "QUEUED";
    case "sending":
    case "sent":
      return "SENT";
    case "delivered":
    case "read":
      return "DELIVERED";
    case "failed":
      return "FAILED";
    case "undelivered":
      return "UNDELIVERED";
    default:
      return null;
  }
}
