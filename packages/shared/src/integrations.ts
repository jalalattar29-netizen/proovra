/**
 * Phase 10 — Integration platform canonical types.
 *
 * Provider-agnostic event types + delivery status enums + helpers for
 * the integration API and webhook layer. Browser-safe (no Prisma).
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Webhook event types
//
// Adding one requires: (1) a dispatcher trigger, (2) a safe projector,
// (3) documentation. Every event MUST be safe-to-leave-the-workspace —
// reviewer notes, token hashes, IP/UA, legal hold reasons are forbidden
// in any payload.
// -----------------------------------------------------------------------------

export const WEBHOOK_EVENT_TYPES = [
  "evidence.created",
  "evidence.completed",
  "evidence.report_generated",
  "evidence.package_generated",
  "evidence_request.created",
  "evidence_request.sent",
  "evidence_request.response_received",
  "external_intake.submitted",
  "notification.failed",
  "governance.legal_hold_placed",
  "governance.export_blocked",
] as const;
export const WebhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);
export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;

// -----------------------------------------------------------------------------
// Delivery + endpoint status enums
// -----------------------------------------------------------------------------

export const WEBHOOK_DELIVERY_STATUSES = [
  "PENDING",
  "SENT",
  "FAILED",
  "RETRY_SCHEDULED",
  "CANCELLED",
] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const WEBHOOK_ENDPOINT_STATUSES = ["ACTIVE", "DISABLED"] as const;
export type WebhookEndpointStatus = (typeof WEBHOOK_ENDPOINT_STATUSES)[number];

export const API_CREDENTIAL_STATUSES = ["ACTIVE", "REVOKED"] as const;
export type ApiCredentialStatus = (typeof API_CREDENTIAL_STATUSES)[number];

// -----------------------------------------------------------------------------
// API key format
//
// `pwk_v1_<base64url>` — the same shape as the Phase 4 intake token but
// prefixed `pwk` to distinguish "PROOVRA Workspace Key". 32 random bytes
// of entropy, base64url-encoded.
// -----------------------------------------------------------------------------

export const API_KEY_PREFIX = "pwk";
export const API_KEY_VERSION = 1;
export const API_KEY_RANDOM_BYTES = 32;

const API_KEY_RE = /^pwk_v(\d+)_([A-Za-z0-9_-]+)$/;

export function parseApiKeyShape(
  raw: string,
): { version: number; body: string } | null {
  if (typeof raw !== "string") return null;
  const m = API_KEY_RE.exec(raw);
  if (!m) return null;
  const version = Number.parseInt(m[1], 10);
  if (!Number.isFinite(version) || version < 1) return null;
  if (m[2].length < 16) return null;
  return { version, body: m[2] };
}

export function formatApiKeyValue(body: string): string {
  return `${API_KEY_PREFIX}_v${API_KEY_VERSION}_${body}`;
}

/**
 * Operator-visible key prefix for an issued key. Used in the admin UI
 * so operators can identify keys without seeing the raw value.
 */
export function deriveApiKeyDisplayPrefix(rawKey: string): string {
  const shape = parseApiKeyShape(rawKey);
  if (!shape) return rawKey.slice(0, 12);
  return `${API_KEY_PREFIX}_v${shape.version}_${shape.body.slice(0, 8)}`;
}

// -----------------------------------------------------------------------------
// Webhook signature scheme
//
// HTTP request headers PROOVRA adds when delivering a webhook:
//   X-Proovra-Event:        the event type (e.g. evidence.completed)
//   X-Proovra-Event-Id:     unique id for the delivery (UUID)
//   X-Proovra-Timestamp:    integer unix milliseconds
//   X-Proovra-Signature:    v1=<hex hmac>
//                           where HMAC-SHA256 is computed over
//                           `${timestamp}.${body}` keyed by the
//                           endpoint's webhook secret.
//
// Receivers SHOULD: (1) verify the timestamp is recent (e.g., within
// 5 minutes); (2) recompute the HMAC over `${timestamp}.${raw_body}`;
// (3) compare in constant time.
// -----------------------------------------------------------------------------

export const WEBHOOK_HEADER_EVENT = "x-proovra-event";
export const WEBHOOK_HEADER_EVENT_ID = "x-proovra-event-id";
export const WEBHOOK_HEADER_TIMESTAMP = "x-proovra-timestamp";
export const WEBHOOK_HEADER_SIGNATURE = "x-proovra-signature";

export function buildWebhookSignatureBase(
  timestampMs: number,
  rawBody: string,
): string {
  return `${timestampMs}.${rawBody}`;
}

// -----------------------------------------------------------------------------
// Retry policy (mirrors notifications.ts shape)
// -----------------------------------------------------------------------------

export const WEBHOOK_RETRY_MAX_ATTEMPTS = 6;

export function webhookRetryDelaySeconds(attempt: number): number {
  if (attempt <= 1) return 0;
  if (attempt > WEBHOOK_RETRY_MAX_ATTEMPTS) return 24 * 3600;
  // 30s, 2m, 10m, 1h, 6h
  const ladder = [30, 120, 600, 3600, 6 * 3600];
  return ladder[attempt - 2] ?? 3600;
}

/**
 * Classify an HTTP status / error as transient (retry) or permanent
 * (give up). 2xx is success and never reaches this function.
 */
export function classifyWebhookHttpError(
  status: number | null,
  errorMessage: string | null,
): "transient" | "permanent" {
  if (typeof status === "number") {
    if (status >= 500 && status < 600) return "transient";
    if (status === 408 || status === 429) return "transient";
    // 4xx other than 408/429 are permanent (we can't fix wrong URL /
    // invalid endpoint state by retrying).
    if (status >= 400 && status < 500) return "permanent";
  }
  const msg = (errorMessage ?? "").toLowerCase();
  for (const marker of [
    "timeout",
    "etimedout",
    "econnreset",
    "econnrefused",
    "connection reset",
    "connection refused",
    "service unavailable",
    "internal server error",
  ]) {
    if (msg.includes(marker)) return "transient";
  }
  return "permanent";
}

// -----------------------------------------------------------------------------
// URL safety — reject localhost / private network destinations.
// -----------------------------------------------------------------------------

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^169\.254\./, // link-local (AWS / GCP metadata)
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // CGNAT 100.64/10
  /^::$/,
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
  // IPv4-mapped IPv6 (dot-quad form, e.g. ::ffff:127.0.0.1)
  /^::ffff:127\./i,
  /^::ffff:10\./i,
  /^::ffff:192\.168\./i,
  /^::ffff:172\.(1[6-9]|2[0-9]|3[0-1])\./i,
  /^::ffff:169\.254\./i,
  // IPv4-mapped IPv6 (hex form — Node's URL parser normalizes to this).
  // 127.0.0.0/8   → ::ffff:7f00–7fff:* (high group is always 4 hex
  //   digits because the leading nibble is `7`, never zero).
  /^::ffff:7f[0-9a-f]{2}:/i,
  // 10.0.0.0/8 → ::ffff:0a00–0aff:*. Node strips RFC 5952 leading
  // zeros from each group, so 10.x → ::ffff:a00..aff. We accept BOTH
  // the canonical (`0a`) form AND the normalised (`a`) form.
  /^::ffff:0?a[0-9a-f]{2}:/i,
  // 192.168.0.0/16 → ::ffff:c0a8:* (no leading-zero issue: c0a8 > 0xfff).
  /^::ffff:c0a8:/i,
  // 172.16.0.0/12  → ::ffff:ac10–ac1f:* (also > 0xfff, no zero strip).
  /^::ffff:ac1[0-9a-f]:/i,
  // 169.254.0.0/16 → ::ffff:a9fe:* (> 0xfff, no zero strip).
  /^::ffff:a9fe:/i,
];

export type WebhookUrlValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: string };

export function validateWebhookUrl(
  raw: string,
  opts: { allowPrivateNetworks?: boolean } = {},
): WebhookUrlValidation {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "https_required" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "credentials_in_url_not_allowed" };
  }
  // Node's URL parser returns IPv6 hostnames wrapped in brackets
  // (e.g. "[::1]"). Strip them for pattern matching.
  const rawHost = parsed.hostname.toLowerCase();
  if (!rawHost) return { ok: false, reason: "missing_host" };
  const host =
    rawHost.startsWith("[") && rawHost.endsWith("]")
      ? rawHost.slice(1, -1)
      : rawHost;
  if (!opts.allowPrivateNetworks) {
    for (const re of PRIVATE_HOST_PATTERNS) {
      if (re.test(host)) {
        return { ok: false, reason: "private_network_blocked" };
      }
    }
  }
  return { ok: true, normalized: parsed.toString() };
}
