/**
 * Phase 8 — Notification canonical types.
 *
 * Operational, transactional notification primitives. NOT a marketing
 * system, NOT a chat system, NOT a campaign manager.
 *
 * The types here are provider-agnostic. The Resend / Twilio / webhook
 * adapters live in the API package. Business code calls
 * `notificationService.send*` and never touches a provider directly.
 *
 * Legally-safe wording rule: every NotificationEventType's label / subject
 * must avoid claims of authenticity, legal admissibility, factual truth,
 * or evidence verification. Notifications are operational coordination,
 * not assertions about the evidence content.
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Channels (extensible — only EMAIL is implemented in Phase 8)
// -----------------------------------------------------------------------------

export const NOTIFICATION_CHANNELS = [
  "EMAIL",
  "SMS",
  "WEBHOOK",
  "PUSH",
  "IN_APP",
] as const;
export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

// -----------------------------------------------------------------------------
// Providers (extensible — only RESEND is implemented in Phase 8)
// -----------------------------------------------------------------------------

export const NOTIFICATION_PROVIDERS = [
  "RESEND",
  "TWILIO",
  "WEBHOOK_HTTP",
  "INTERNAL",
] as const;
export const NotificationProviderSchema = z.enum(NOTIFICATION_PROVIDERS);
export type NotificationProvider = z.infer<typeof NotificationProviderSchema>;

// -----------------------------------------------------------------------------
// Delivery status
// -----------------------------------------------------------------------------

export const NOTIFICATION_DELIVERY_STATUSES = [
  "PENDING",
  "SENT",
  "DELIVERED",
  "FAILED",
  "RETRY_SCHEDULED",
  "CANCELLED",
  "SKIPPED",
] as const;
export const NotificationDeliveryStatusSchema = z.enum(
  NOTIFICATION_DELIVERY_STATUSES,
);
export type NotificationDeliveryStatus = z.infer<
  typeof NotificationDeliveryStatusSchema
>;

const TERMINAL_DELIVERY_STATUSES: ReadonlyArray<NotificationDeliveryStatus> = [
  "DELIVERED",
  "FAILED",
  "CANCELLED",
  "SKIPPED",
];

export function isTerminalNotificationDeliveryStatus(
  status: NotificationDeliveryStatus,
): boolean {
  return TERMINAL_DELIVERY_STATUSES.includes(status);
}

// -----------------------------------------------------------------------------
// Notification event types
//
// Adding one requires (1) a template renderer, (2) at least one business
// trigger, and (3) a privacy-safe subject line. Operators must never see
// an event type whose payload could leak workspace internals.
// -----------------------------------------------------------------------------

export const NOTIFICATION_EVENT_TYPES = [
  // Evidence requests
  "EVIDENCE_REQUEST_SENT",
  "EVIDENCE_REQUEST_REMINDER",
  "EVIDENCE_REQUEST_RESPONSE_RECEIVED",
  "EVIDENCE_REQUEST_NEEDS_MORE_INFO",
  "EVIDENCE_REQUEST_FULFILLED",
  "EVIDENCE_REQUEST_CANCELLED",
  "EVIDENCE_REQUEST_CLOSED",
  // Reviewer assignment
  "REVIEW_REQUEST_ASSIGNED",
  // Phase 13 — enterprise review operations notifications. Bodies
  // never include internal review notes, rejection reasons, or
  // workspace-only metadata — only the operator-visible action.
  "REVIEW_REASSIGNED",
  "REVIEW_ESCALATED",
  "REVIEW_OVERDUE_REMINDER",
  "REVIEW_NEEDS_MORE_INFO",
  "REVIEW_RESPONSE_RECEIVED",
  // Phase 16 — collaboration notifications. Internal-only; bodies
  // never include the message text or thread internals.
  "DISCUSSION_MENTION_RECEIVED",
  "DISCUSSION_REPLY_RECEIVED",
  "DISCUSSION_RESOLVED",
  "DISCUSSION_REOPENED",
  "CONTRIBUTOR_REPLY_RECEIVED",
  // Intake links (standalone — not bound to a request)
  "EXTERNAL_INTAKE_LINK_CREATED",
  "EXTERNAL_INTAKE_SUBMITTED",
  // Operations Center — scheduled digest of unread operational items.
  // Bodies contain ONLY item titles/categories the recipient was already
  // authorized to see when the item was surfaced — never raw content.
  "OPERATIONS_DIGEST",
] as const;
export const NotificationEventTypeSchema = z.enum(NOTIFICATION_EVENT_TYPES);
export type NotificationEventType = z.infer<typeof NotificationEventTypeSchema>;

// -----------------------------------------------------------------------------
// Retry policy
// -----------------------------------------------------------------------------

export const NOTIFICATION_RETRY_MAX_ATTEMPTS = 5;

/**
 * Exponential backoff between attempts (in seconds). Attempt 1 is the
 * initial send; attempts 2..5 are retries. Caller schedules its own
 * delays; this just returns the recommended interval.
 */
export function notificationRetryDelaySeconds(attempt: number): number {
  if (attempt <= 1) return 0;
  if (attempt > NOTIFICATION_RETRY_MAX_ATTEMPTS) {
    return 24 * 3600;
  }
  // 30s, 2m, 10m, 1h
  const ladder = [30, 120, 600, 3600];
  return ladder[attempt - 2] ?? 3600;
}

/**
 * Classify an arbitrary provider error string into either "transient" or
 * "permanent". Transient errors are retriable. Anything we can't classify
 * is conservatively treated as permanent so we don't retry-loop on a
 * structural failure (e.g. invalid recipient).
 */
export function classifyNotificationProviderError(
  errorCode: string | null | undefined,
  errorMessage: string | null | undefined,
): "transient" | "permanent" {
  const code = (errorCode ?? "").toLowerCase();
  const msg = (errorMessage ?? "").toLowerCase();
  const transientMarkers = [
    "timeout",
    "etimedout",
    "econnreset",
    "econnrefused",
    "connection reset",
    "connection refused",
    "rate_limit",
    "rate limit",
    "too_many_requests",
    "too many requests",
    "service_unavailable",
    "service unavailable",
    "5xx",
    "503",
    "504",
    "502",
    "internal_server_error",
    "internal server error",
  ];
  for (const marker of transientMarkers) {
    if (code.includes(marker) || msg.includes(marker)) return "transient";
  }
  return "permanent";
}
