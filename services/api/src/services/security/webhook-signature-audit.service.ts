/**
 * Phase A3 — Webhook signature failure auditing.
 *
 * Wraps webhook signature-verification calls so every failure
 * produces:
 *
 *   1. A `SecurityEvent` of type `webhook_signature_failure`
 *      (severity HIGH) with a bounded reason category + provider.
 *      The category vocabulary is the shared
 *      `WEBHOOK_SIGNATURE_FAILURE_REASONS`.
 *
 *   2. A bumped `webhook_signature_failures_total` counter so
 *      operators can detect floods + correlated attack patterns
 *      via metrics without scraping logs.
 *
 *   3. A bounded structured log line `webhook.signature.failed`
 *      with the same redacted shape. NEVER includes the secret,
 *      the raw signature, the payload bytes, or sensitive headers.
 *
 * The wrapper never re-throws — callers MUST check the result and
 * decide the response. The route layer typically returns 400 +
 * generic message. The wrapper deliberately does NOT consult the
 * payload structure; signature verification is the FIRST gate.
 */

import type { FastifyRequest } from "fastify";

import type {
  WebhookProvider,
  WebhookSignatureFailureReason,
} from "@proovra/shared";
import { safeEmitSecurityEvent } from "./security-event.service.js";

export type WebhookSignatureCheckOk = {
  ok: true;
};

export type WebhookSignatureCheckFailure = {
  ok: false;
  reason: WebhookSignatureFailureReason;
  errMessage: string;
};

export type WebhookSignatureCheckResult =
  | WebhookSignatureCheckOk
  | WebhookSignatureCheckFailure;

async function bumpWebhookFailureMetric(): Promise<void> {
  try {
    const mod = await import("@proovra/shared-runtime/ops");
    mod.bump("webhook_signature_failures_total");
  } catch {
    /* best-effort */
  }
}

async function bumpReplayRejectionMetric(): Promise<void> {
  try {
    const mod = await import("@proovra/shared-runtime/ops");
    mod.bump("webhook_replay_rejections_total");
  } catch {
    /* best-effort */
  }
}

/**
 * Classify a thrown error from a provider-specific signature
 * verifier into our bounded category. The verifiers all throw
 * `Error`; we inspect the message text. Free-form classification is
 * acceptable because operators see only the bounded category
 * downstream — the original message is logged with the security
 * event for forensic correlation.
 */
function classifyError(err: unknown): WebhookSignatureFailureReason {
  if (!(err instanceof Error)) return "invalid_signature";
  const m = err.message.toLowerCase();
  if (m.includes("missing") || m.includes("not set")) {
    return "missing_signature";
  }
  if (
    m.includes("timestamp") ||
    m.includes("expired") ||
    m.includes("clock")
  ) {
    return "timestamp_out_of_range";
  }
  if (m.includes("replay")) return "replay_detected";
  if (m.includes("malformed") || m.includes("parse")) {
    return "malformed_payload";
  }
  if (m.includes("secret")) return "secret_misconfigured";
  return "invalid_signature";
}

/**
 * Run a signature verifier inside the audit wrapper. The verifier
 * is whatever synchronous or async closure the route layer has
 * (e.g. a thunk that calls `verifyStripeSignature`). If it throws,
 * we emit the SecurityEvent + bump the metric + log a bounded
 * line, then return `{ ok: false, ... }` so the route can choose
 * its 4xx response.
 */
export async function auditWebhookSignatureVerification(input: {
  provider: WebhookProvider;
  request: FastifyRequest;
  /**
   * Closure that runs the provider-specific verifier. Must throw
   * on failure. Return value (if any) is ignored.
   */
  verify: () => Promise<unknown> | unknown;
  /**
   * Optional pre-check. Used by routes that need to detect a
   * missing-header case BEFORE calling the verifier (Stripe needs
   * `stripe-signature`, etc.). When `presentSignature` is `false`
   * the wrapper short-circuits to `missing_signature`.
   */
  presentSignature?: boolean;
}): Promise<WebhookSignatureCheckResult> {
  if (input.presentSignature === false) {
    await bumpWebhookFailureMetric();
    safeEmitSecurityEvent({
      teamId: null,
      eventType: "webhook_signature_failure",
      severity: "HIGH",
      details: {
        provider: input.provider,
        reason: "missing_signature" satisfies WebhookSignatureFailureReason,
        requestId: input.request.id,
      },
    });
    input.request.log.warn(
      {
        provider: input.provider,
        reason: "missing_signature",
      },
      "webhook.signature.failed",
    );
    return {
      ok: false,
      reason: "missing_signature",
      errMessage: "Missing signature header",
    };
  }

  try {
    await Promise.resolve(input.verify());
    return { ok: true };
  } catch (err) {
    const reason = classifyError(err);
    await bumpWebhookFailureMetric();
    if (reason === "replay_detected") {
      await bumpReplayRejectionMetric();
    }
    const errMessage =
      err instanceof Error ? err.message.slice(0, 200) : "unknown_error";

    safeEmitSecurityEvent({
      teamId: null,
      eventType: "webhook_signature_failure",
      severity: "HIGH",
      details: {
        provider: input.provider,
        reason,
        requestId: input.request.id,
        // Bounded original message preview so an operator can
        // disambiguate within the bounded category. NEVER includes
        // the secret or the payload bytes.
        errMessagePreview: errMessage.slice(0, 120),
      },
    });
    input.request.log.warn(
      {
        provider: input.provider,
        reason,
        errMessagePreview: errMessage.slice(0, 120),
      },
      "webhook.signature.failed",
    );

    return { ok: false, reason, errMessage };
  }
}
