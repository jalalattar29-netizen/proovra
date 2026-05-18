import test from "node:test";
import assert from "node:assert/strict";

import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_PROVIDERS,
  NOTIFICATION_RETRY_MAX_ATTEMPTS,
  NotificationChannelSchema,
  NotificationDeliveryStatusSchema,
  NotificationEventTypeSchema,
  NotificationProviderSchema,
  classifyNotificationProviderError,
  isTerminalNotificationDeliveryStatus,
  notificationRetryDelaySeconds,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Enum surfaces
// -----------------------------------------------------------------------------

test("notification channels include EMAIL plus future-proof variants", () => {
  assert.ok(NOTIFICATION_CHANNELS.includes("EMAIL"));
  assert.ok(NOTIFICATION_CHANNELS.includes("SMS"));
  assert.ok(NOTIFICATION_CHANNELS.includes("WEBHOOK"));
});

test("notification providers include RESEND", () => {
  assert.ok(NOTIFICATION_PROVIDERS.includes("RESEND"));
});

test("delivery statuses cover the documented lifecycle", () => {
  for (const expected of [
    "PENDING",
    "SENT",
    "DELIVERED",
    "FAILED",
    "RETRY_SCHEDULED",
    "CANCELLED",
    "SKIPPED",
  ]) {
    assert.ok(
      NOTIFICATION_DELIVERY_STATUSES.includes(expected),
      `missing: ${expected}`,
    );
  }
});

test("notification event types include the operational set", () => {
  for (const expected of [
    "EVIDENCE_REQUEST_SENT",
    "EVIDENCE_REQUEST_REMINDER",
    "EVIDENCE_REQUEST_RESPONSE_RECEIVED",
    "EVIDENCE_REQUEST_NEEDS_MORE_INFO",
    "REVIEW_REQUEST_ASSIGNED",
    "EXTERNAL_INTAKE_LINK_CREATED",
    "EXTERNAL_INTAKE_SUBMITTED",
  ]) {
    assert.ok(
      NOTIFICATION_EVENT_TYPES.includes(expected),
      `missing event: ${expected}`,
    );
  }
});

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

test("NotificationEventTypeSchema rejects unknown event types", () => {
  assert.equal(
    NotificationEventTypeSchema.safeParse("WEAPONIZED_PIGEON").success,
    false,
  );
  assert.equal(
    NotificationEventTypeSchema.safeParse("EVIDENCE_REQUEST_SENT").success,
    true,
  );
});

test("NotificationChannelSchema only accepts known channels", () => {
  for (const c of ["EMAIL", "SMS", "WEBHOOK", "PUSH", "IN_APP"]) {
    assert.equal(NotificationChannelSchema.safeParse(c).success, true);
  }
  assert.equal(NotificationChannelSchema.safeParse("FAX").success, false);
});

test("NotificationProviderSchema only accepts known providers", () => {
  assert.equal(NotificationProviderSchema.safeParse("RESEND").success, true);
  assert.equal(
    NotificationProviderSchema.safeParse("MAILGUN").success,
    false,
  );
});

test("NotificationDeliveryStatusSchema only accepts known statuses", () => {
  for (const s of NOTIFICATION_DELIVERY_STATUSES) {
    assert.equal(NotificationDeliveryStatusSchema.safeParse(s).success, true);
  }
  assert.equal(
    NotificationDeliveryStatusSchema.safeParse("DUNNO").success,
    false,
  );
});

// -----------------------------------------------------------------------------
// Predicates
// -----------------------------------------------------------------------------

test("isTerminalNotificationDeliveryStatus flags the right set", () => {
  for (const s of ["DELIVERED", "FAILED", "CANCELLED", "SKIPPED"]) {
    assert.equal(isTerminalNotificationDeliveryStatus(s), true, s);
  }
  for (const s of ["PENDING", "SENT", "RETRY_SCHEDULED"]) {
    assert.equal(isTerminalNotificationDeliveryStatus(s), false, s);
  }
});

// -----------------------------------------------------------------------------
// Retry policy
// -----------------------------------------------------------------------------

test("notificationRetryDelaySeconds returns 0 for the initial attempt", () => {
  assert.equal(notificationRetryDelaySeconds(1), 0);
});

test("notificationRetryDelaySeconds follows an exponential ladder", () => {
  assert.equal(notificationRetryDelaySeconds(2), 30);
  assert.equal(notificationRetryDelaySeconds(3), 120);
  assert.equal(notificationRetryDelaySeconds(4), 600);
  assert.equal(notificationRetryDelaySeconds(5), 3600);
});

test("notificationRetryDelaySeconds caps when over the max", () => {
  assert.equal(notificationRetryDelaySeconds(NOTIFICATION_RETRY_MAX_ATTEMPTS + 1), 24 * 3600);
});

// -----------------------------------------------------------------------------
// Error classification
// -----------------------------------------------------------------------------

test("classifyNotificationProviderError flags transient errors", () => {
  for (const msg of [
    "ETIMEDOUT",
    "Connection reset",
    "timeout exceeded",
    "rate_limit",
    "service_unavailable",
    "503 Service Unavailable",
    "Internal Server Error",
    "ECONNREFUSED",
  ]) {
    assert.equal(
      classifyNotificationProviderError(null, msg),
      "transient",
      `should be transient: ${msg}`,
    );
  }
});

test("classifyNotificationProviderError treats unknown errors as permanent", () => {
  assert.equal(
    classifyNotificationProviderError(null, "Invalid recipient"),
    "permanent",
  );
  assert.equal(
    classifyNotificationProviderError("INVALID_FROM", null),
    "permanent",
  );
  assert.equal(classifyNotificationProviderError(null, null), "permanent");
});

test("classifyNotificationProviderError accepts code over message", () => {
  assert.equal(
    classifyNotificationProviderError("ETIMEDOUT", "anything"),
    "transient",
  );
});
