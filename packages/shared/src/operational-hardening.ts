/**
 * Phase A3 — Operational hardening shared vocabularies.
 *
 * Bounded literal unions for the surfaces the A3 phase hardens:
 *
 *   * Analytics endpoint event allowlist (the only `eventType`
 *     values the `POST /v1/analytics/track` route accepts).
 *
 *   * Analytics rejection reason categories (for the rejection
 *     SecurityEvent + metric label).
 *
 *   * Webhook signature failure reason categories (for the webhook
 *     SecurityEvent payload + log).
 *
 *   * AI chat abuse reason categories (rate limit / payload / etc).
 *
 * Bounded vocabularies prevent free-form strings from leaking into
 * logs and metric labels — they're the operator-facing classification
 * surface, and they need to stay analyzable.
 */

// =============================================================================
// Analytics endpoint
// =============================================================================

/**
 * The ONLY event names `POST /v1/analytics/track` accepts from a browser.
 * Adding a value requires a code change. The route rejects unknown event
 * names with a 422 and bumps `analytics_rejected_total`.
 *
 * Naming convention: lower_snake_case describing a user-meaningful action.
 * NEVER PII-shaped (no user ids, no evidence ids in the name).
 *
 * THIS IS THE INGEST ALLOWLIST, NOT THE WHOLE VOCABULARY, AND THAT IS
 * DELIBERATE. `AnalyticsEvent.eventType` is a free-text column and the
 * product writes ~40 names into it, but nearly all of them are asserted by
 * the SERVER after it has done the thing — `billing_payment_succeeded`,
 * `evidence_created`, `login_completed`. A browser may not claim those: this
 * endpoint is reachable by anyone, so anything listed here is something an
 * untrusted client is allowed to assert about itself. Keeping the list to
 * what the client genuinely emits is what stops the ingest route from
 * becoming a way to forge billing or custody analytics.
 *
 * It previously held eight UPPER_SNAKE_CASE names — VERIFY_VIEW,
 * REPORT_DOWNLOAD, PACKAGE_DOWNLOAD, CAPTURE_STARTED, CAPTURE_COMPLETED,
 * AI_ASSISTANT_OPENED, PUBLIC_VERIFY_OPENED, REVIEW_SESSION_STARTED — and
 * every one of them was unreachable. Nothing in the repository ever emitted
 * one, and nothing downstream understood one: `classifyEventClass`,
 * `classifySeverity` and `humanizeEventType` key on the lower_snake_case
 * vocabulary, so such a row would have persisted as class "custom" and been
 * invisible to every dashboard, all of which filter on exact lowercase names.
 * The list described an intention; the product spoke a different language.
 * The one name the client actually sends was the one name missing, so real
 * page views were answered 422 while eight names nothing sent were welcome.
 */
export const ANALYTICS_EVENT_NAMES = ["page_view"] as const;
export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

/**
 * Bounded reason categories for an analytics rejection. The route
 * emits a SecurityEvent with `reason` set to one of these literals.
 */
export const ANALYTICS_REJECTION_REASONS = [
  "invalid_event_name",
  "payload_too_large",
  "schema_invalid",
  "rate_limited_ip",
  "rate_limited_visitor",
  "metadata_too_deep",
  "metadata_too_large",
] as const;
export type AnalyticsRejectionReason =
  (typeof ANALYTICS_REJECTION_REASONS)[number];

/**
 * Hard caps the route enforces. These are deliberately tight — the
 * platform does not need flexible analytics input shapes.
 */
export const ANALYTICS_LIMITS = {
  /** Total JSON body bytes after parsing. */
  MAX_BODY_BYTES: 4 * 1024,
  /** Max string length for `path` / `referrer` / `entityId` etc. */
  MAX_STRING: 256,
  /** Max number of top-level metadata keys. */
  MAX_METADATA_KEYS: 8,
  /** Max nesting depth in metadata. */
  MAX_METADATA_DEPTH: 2,
  /** Per-IP requests per window. */
  RATE_LIMIT_IP_PER_MIN: 30,
  /** Per-visitorId requests per window. */
  RATE_LIMIT_VISITOR_PER_MIN: 60,
} as const;

// =============================================================================
// AI chat
// =============================================================================

export const AI_CHAT_ABUSE_REASONS = [
  "rate_limited_user",
  "rate_limited_ip",
  "payload_too_large",
  "timeout",
  "cost_guard_exceeded",
] as const;
export type AiChatAbuseReason = (typeof AI_CHAT_ABUSE_REASONS)[number];

export const AI_CHAT_LIMITS = {
  /** Per-user requests per window. The platform expects ~few chat
   *  exchanges per minute under legitimate use; 5 is the bounded
   *  allowance ahead of the existing daily cost guard. */
  RATE_LIMIT_USER_PER_MIN: 5,
  /** Per-IP fallback to defend against credential stuffing across
   *  multiple compromised accounts. Generous; the per-user limit is
   *  the primary gate. */
  RATE_LIMIT_IP_PER_MIN: 30,
  /** Hard timeout for the upstream AI call. Bounded so a hung
   *  provider does not turn into an operational dependency. */
  REQUEST_TIMEOUT_MS: 30_000,
} as const;

// =============================================================================
// Webhook signature failures
// =============================================================================

export const WEBHOOK_SIGNATURE_FAILURE_REASONS = [
  "missing_signature",
  "invalid_signature",
  "timestamp_out_of_range",
  "replay_detected",
  "malformed_payload",
  "secret_misconfigured",
] as const;
export type WebhookSignatureFailureReason =
  (typeof WEBHOOK_SIGNATURE_FAILURE_REASONS)[number];

export const WEBHOOK_PROVIDERS = ["stripe", "paypal", "twilio"] as const;
export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

// =============================================================================
// Public verify VERIFY_VIEWED debounce
// =============================================================================

export const VERIFY_VIEWED_LIMITS = {
  /**
   * Debounce window. A new `VERIFY_VIEWED` custody event is
   * appended at MOST once per evidence per window. Refresh
   * storms and bot scans inside the window are recorded only on
   * the analytics surface (`lastPublicVerifyViewAtUtc` +
   * `VerificationView` rows), never as forensic custody noise.
   */
  DEBOUNCE_WINDOW_MS: 24 * 60 * 60 * 1000, // 24 hours
} as const;
