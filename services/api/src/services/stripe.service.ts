import crypto from "node:crypto";
// Phase P2.0 — STRIPE_SECRET_KEY is in the migrated set. The `must()`
// helper below now consults AWS Secrets Manager before falling back to
// env. Behaviour for non-migrated names is unchanged.
import {
  MIGRATED_SECRETS,
  requireSecret,
} from "../config/runtime-secrets.js";

type StripeEvent = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

function must(name: string): string {
  // For migrated secrets, prefer the runtime-secrets resolver so AWS
  // Secrets Manager values take precedence over env.
  if ((MIGRATED_SECRETS as readonly string[]).includes(name)) {
    return requireSecret(name);
  }
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function stripeApiBase() {
  return "https://api.stripe.com/v1";
}

export async function stripeRequest(path: string, body: URLSearchParams) {
  const res = await fetch(`${stripeApiBase()}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${must("STRIPE_SECRET_KEY")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stripe error: ${text}`);
  }

  return (await res.json()) as Record<string, unknown>;
}

export async function stripeRequestRaw(
  path: string,
  method: "POST" | "DELETE",
  body?: URLSearchParams
) {
  const res = await fetch(`${stripeApiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${must("STRIPE_SECRET_KEY")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stripe error: ${text}`);
  }

  return (await res.json()) as Record<string, unknown>;
}

/**
 * Phase O-blockers / A-4 — Stripe webhook signature with timestamp
 * tolerance. The Stripe-Signature header carries `t=<unix-seconds>` +
 * `v1=<hmac-sha256>`. Prior to this change the timestamp was parsed
 * but never compared against the receiver clock — a captured signed
 * payload remained valid indefinitely (replay attack). Stripe's
 * documented signing scheme requires receivers to enforce a
 * tolerance window; we follow the standard 5-minute window.
 *
 * Errors thrown here are caught by the webhook route which converts
 * them into HTTP 400 + a `WEBHOOK_REPLAY_BLOCKED` audit row (see
 * `webhooks.routes.ts`).
 */
export const STRIPE_SIGNATURE_TOLERANCE_SEC = 5 * 60;

export class StripeSignatureError extends Error {
  code:
    | "MISSING_FIELDS"
    | "TIMESTAMP_INVALID"
    | "TIMESTAMP_OUT_OF_TOLERANCE"
    | "BAD_SIGNATURE";
  constructor(
    message: string,
    code: StripeSignatureError["code"],
  ) {
    super(message);
    this.name = "StripeSignatureError";
    this.code = code;
  }
}

export function verifyStripeSignature(
  rawBody: Buffer,
  signature: string,
  options: { nowMs?: number } = {},
) {
  const secret = must("STRIPE_WEBHOOK_SECRET");
  const items = signature.split(",");
  const timestamp = items.find((item) => item.startsWith("t="))?.slice(2);
  const sig = items.find((item) => item.startsWith("v1="))?.slice(3);

  if (!timestamp || !sig) {
    throw new StripeSignatureError(
      "Invalid signature header",
      "MISSING_FIELDS",
    );
  }

  // Timestamp must be a positive integer of unix seconds. Reject
  // garbage early so the constant-time HMAC compare is never reached
  // with adversary-controlled length.
  const tsSec = Number.parseInt(timestamp, 10);
  if (
    !Number.isFinite(tsSec) ||
    !Number.isInteger(tsSec) ||
    tsSec <= 0 ||
    String(tsSec) !== timestamp.trim()
  ) {
    throw new StripeSignatureError(
      "Stripe signature timestamp is not a valid unix epoch.",
      "TIMESTAMP_INVALID",
    );
  }

  const nowMs = options.nowMs ?? Date.now();
  const tsMs = tsSec * 1000;
  const deltaSec = Math.abs(nowMs - tsMs) / 1000;
  if (deltaSec > STRIPE_SIGNATURE_TOLERANCE_SEC) {
    throw new StripeSignatureError(
      `Stripe signature timestamp is outside the ${STRIPE_SIGNATURE_TOLERANCE_SEC}s tolerance window (delta=${Math.round(deltaSec)}s).`,
      "TIMESTAMP_OUT_OF_TOLERANCE",
    );
  }

  const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");

  // timingSafeEqual requires equal-length buffers; reject mismatched
  // length BEFORE the compare so we don't leak length via the throw
  // path (defensive — Stripe's signature is always 64 hex chars).
  if (expected.length !== sig.length) {
    throw new StripeSignatureError(
      "Invalid webhook signature",
      "BAD_SIGNATURE",
    );
  }
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
    throw new StripeSignatureError(
      "Invalid webhook signature",
      "BAD_SIGNATURE",
    );
  }

  return true;
}

export function parseStripeEvent(rawBody: Buffer): StripeEvent {
  return JSON.parse(rawBody.toString("utf8")) as StripeEvent;
}

export async function stripeGet(path: string) {
  const res = await fetch(`${stripeApiBase()}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${must("STRIPE_SECRET_KEY")}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stripe error: ${text}`);
  }

  return (await res.json()) as Record<string, unknown>;
}