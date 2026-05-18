import test from "node:test";
import assert from "node:assert/strict";

// Pure mirrors of the retry / privacy logic that lives in
// services/api/src/services/notifications/index.ts. Keeps a runnable
// contract test for the behavior without spinning up the DB.

import {
  NOTIFICATION_RETRY_MAX_ATTEMPTS,
  classifyNotificationProviderError,
  notificationRetryDelaySeconds,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Retry eligibility — mirrors processDueNotificationRetries selection
// criteria.
// -----------------------------------------------------------------------------

function isRetryEligible(row, now) {
  if (row.status !== "RETRY_SCHEDULED") return false;
  if (row.channel !== "EMAIL") return false;
  if (row.provider !== "RESEND") return false;
  if (row.retryCount >= NOTIFICATION_RETRY_MAX_ATTEMPTS) return false;
  if (!row.nextAttemptAtUtc) return false;
  return new Date(row.nextAttemptAtUtc).getTime() <= now.getTime();
}

function rowDecision({ classification, currentRetryCount }) {
  const retriable =
    classification === "transient" &&
    currentRetryCount + 1 < NOTIFICATION_RETRY_MAX_ATTEMPTS;
  return retriable ? "RETRY_SCHEDULED" : "FAILED";
}

test("retry eligibility — picks up due RETRY_SCHEDULED rows", () => {
  const now = new Date("2026-05-17T10:00:00Z");
  const row = {
    status: "RETRY_SCHEDULED",
    channel: "EMAIL",
    provider: "RESEND",
    retryCount: 1,
    nextAttemptAtUtc: "2026-05-17T09:59:00Z",
  };
  assert.equal(isRetryEligible(row, now), true);
});

test("retry eligibility — skips future nextAttemptAtUtc", () => {
  const now = new Date("2026-05-17T10:00:00Z");
  const row = {
    status: "RETRY_SCHEDULED",
    channel: "EMAIL",
    provider: "RESEND",
    retryCount: 1,
    nextAttemptAtUtc: "2026-05-17T10:01:00Z",
  };
  assert.equal(isRetryEligible(row, now), false);
});

test("retry eligibility — skips when retryCount hit the max", () => {
  const now = new Date("2026-05-17T10:00:00Z");
  const row = {
    status: "RETRY_SCHEDULED",
    channel: "EMAIL",
    provider: "RESEND",
    retryCount: NOTIFICATION_RETRY_MAX_ATTEMPTS,
    nextAttemptAtUtc: "2026-05-17T09:00:00Z",
  };
  assert.equal(isRetryEligible(row, now), false);
});

test("retry eligibility — skips non-RETRY_SCHEDULED rows", () => {
  const now = new Date("2026-05-17T10:00:00Z");
  for (const status of ["PENDING", "SENT", "DELIVERED", "FAILED", "CANCELLED", "SKIPPED"]) {
    const row = {
      status,
      channel: "EMAIL",
      provider: "RESEND",
      retryCount: 0,
      nextAttemptAtUtc: "2026-05-17T09:00:00Z",
    };
    assert.equal(isRetryEligible(row, now), false, status);
  }
});

test("retry eligibility — skips other channels (Phase 8.5 only processes EMAIL/RESEND)", () => {
  const now = new Date("2026-05-17T10:00:00Z");
  const row = {
    status: "RETRY_SCHEDULED",
    channel: "SMS",
    provider: "RESEND",
    retryCount: 0,
    nextAttemptAtUtc: "2026-05-17T09:00:00Z",
  };
  assert.equal(isRetryEligible(row, now), false);
});

test("row decision — transient before max retries → RETRY_SCHEDULED", () => {
  const decision = rowDecision({
    classification: "transient",
    currentRetryCount: 1,
  });
  assert.equal(decision, "RETRY_SCHEDULED");
});

test("row decision — transient at max-minus-one becomes FAILED", () => {
  const decision = rowDecision({
    classification: "transient",
    currentRetryCount: NOTIFICATION_RETRY_MAX_ATTEMPTS - 1,
  });
  assert.equal(decision, "FAILED");
});

test("row decision — permanent always becomes FAILED", () => {
  const decision = rowDecision({
    classification: "permanent",
    currentRetryCount: 0,
  });
  assert.equal(decision, "FAILED");
});

test("classification + delay together drive a bounded retry ladder", () => {
  // A row that ETIMEDOUTs 5 times in sequence eventually FAILs because the
  // attempt counter passes the max.
  let row = { status: "RETRY_SCHEDULED", retryCount: 0 };
  let attemptHistory = [];
  for (let i = 0; i < 6; i++) {
    const classification = classifyNotificationProviderError(null, "ETIMEDOUT");
    const decision = rowDecision({
      classification,
      currentRetryCount: row.retryCount,
    });
    const delay = notificationRetryDelaySeconds(row.retryCount + 2);
    attemptHistory.push({ status: decision, retryCount: row.retryCount, delay });
    if (decision === "FAILED") break;
    row = { ...row, retryCount: row.retryCount + 1 };
  }
  const lastEntry = attemptHistory[attemptHistory.length - 1];
  assert.equal(lastEntry.status, "FAILED", "must terminate at FAILED");
  assert.ok(attemptHistory.length <= NOTIFICATION_RETRY_MAX_ATTEMPTS);
});

// -----------------------------------------------------------------------------
// Manual resend — mirror of the allowed-status policy
// -----------------------------------------------------------------------------

function isResendAllowed(status, force) {
  if (status === "CANCELLED") return false; // skipped_terminal
  if ((status === "SENT" || status === "DELIVERED") && !force) return false;
  return true;
}

test("resend policy — FAILED is allowed", () => {
  assert.equal(isResendAllowed("FAILED", false), true);
});

test("resend policy — RETRY_SCHEDULED is allowed (operator forces immediate retry)", () => {
  assert.equal(isResendAllowed("RETRY_SCHEDULED", false), true);
});

test("resend policy — SKIPPED is allowed (feature turned back on)", () => {
  assert.equal(isResendAllowed("SKIPPED", false), true);
});

test("resend policy — SENT requires force=true", () => {
  assert.equal(isResendAllowed("SENT", false), false);
  assert.equal(isResendAllowed("SENT", true), true);
});

test("resend policy — DELIVERED requires force=true", () => {
  assert.equal(isResendAllowed("DELIVERED", false), false);
  assert.equal(isResendAllowed("DELIVERED", true), true);
});

test("resend policy — CANCELLED is never resent", () => {
  assert.equal(isResendAllowed("CANCELLED", false), false);
  assert.equal(isResendAllowed("CANCELLED", true), false);
});

// -----------------------------------------------------------------------------
// Reminder cooldown — mirror of the reminder-scheduler dedup gate
// -----------------------------------------------------------------------------

function shouldSendReminder({ request, lastReminderAt, cooldownMs, now }) {
  if (!["OPEN", "SENT", "VIEWED", "IN_PROGRESS"].includes(request.status)) {
    return false;
  }
  if (!request.recipientEmail) return false;
  if (request.recipientMode !== "EXTERNAL_CONTRIBUTOR") return false;
  if (!request.dueAtUtc) return false;
  if (lastReminderAt) {
    if (now.getTime() - lastReminderAt.getTime() < cooldownMs) return false;
  }
  return true;
}

test("reminder — skips CLOSED requests", () => {
  const r = shouldSendReminder({
    request: {
      status: "CLOSED",
      recipientEmail: "x@y.com",
      recipientMode: "EXTERNAL_CONTRIBUTOR",
      dueAtUtc: new Date(),
    },
    lastReminderAt: null,
    cooldownMs: 24 * 3600 * 1000,
    now: new Date(),
  });
  assert.equal(r, false);
});

test("reminder — skips CANCELLED requests", () => {
  const r = shouldSendReminder({
    request: {
      status: "CANCELLED",
      recipientEmail: "x@y.com",
      recipientMode: "EXTERNAL_CONTRIBUTOR",
      dueAtUtc: new Date(),
    },
    lastReminderAt: null,
    cooldownMs: 24 * 3600 * 1000,
    now: new Date(),
  });
  assert.equal(r, false);
});

test("reminder — skips FULFILLED requests", () => {
  const r = shouldSendReminder({
    request: {
      status: "FULFILLED",
      recipientEmail: "x@y.com",
      recipientMode: "EXTERNAL_CONTRIBUTOR",
      dueAtUtc: new Date(),
    },
    lastReminderAt: null,
    cooldownMs: 24 * 3600 * 1000,
    now: new Date(),
  });
  assert.equal(r, false);
});

test("reminder — skips when no email", () => {
  const r = shouldSendReminder({
    request: {
      status: "SENT",
      recipientEmail: null,
      recipientMode: "EXTERNAL_CONTRIBUTOR",
      dueAtUtc: new Date(),
    },
    lastReminderAt: null,
    cooldownMs: 24 * 3600 * 1000,
    now: new Date(),
  });
  assert.equal(r, false);
});

test("reminder — skips ANONYMOUS_SOURCE (no destination)", () => {
  const r = shouldSendReminder({
    request: {
      status: "SENT",
      recipientEmail: "x@y.com",
      recipientMode: "ANONYMOUS_SOURCE",
      dueAtUtc: new Date(),
    },
    lastReminderAt: null,
    cooldownMs: 24 * 3600 * 1000,
    now: new Date(),
  });
  assert.equal(r, false);
});

test("reminder — skips when a reminder was sent within the cooldown", () => {
  const now = new Date("2026-05-17T10:00:00Z");
  const r = shouldSendReminder({
    request: {
      status: "SENT",
      recipientEmail: "x@y.com",
      recipientMode: "EXTERNAL_CONTRIBUTOR",
      dueAtUtc: new Date(),
    },
    lastReminderAt: new Date("2026-05-17T05:00:00Z"),
    cooldownMs: 24 * 3600 * 1000,
    now,
  });
  assert.equal(r, false);
});

test("reminder — sends when cooldown has passed", () => {
  const now = new Date("2026-05-18T10:00:00Z");
  const r = shouldSendReminder({
    request: {
      status: "SENT",
      recipientEmail: "x@y.com",
      recipientMode: "EXTERNAL_CONTRIBUTOR",
      dueAtUtc: new Date(),
    },
    lastReminderAt: new Date("2026-05-17T05:00:00Z"),
    cooldownMs: 24 * 3600 * 1000,
    now,
  });
  assert.equal(r, true);
});

test("reminder — sends when no prior reminder exists", () => {
  const r = shouldSendReminder({
    request: {
      status: "SENT",
      recipientEmail: "x@y.com",
      recipientMode: "EXTERNAL_CONTRIBUTOR",
      dueAtUtc: new Date(),
    },
    lastReminderAt: null,
    cooldownMs: 24 * 3600 * 1000,
    now: new Date(),
  });
  assert.equal(r, true);
});

// -----------------------------------------------------------------------------
// Projection privacy — mirror of projectNotificationDelivery's
// surface-level allowlist
// -----------------------------------------------------------------------------

const PROJECTED_FIELDS = [
  "id",
  "eventType",
  "channel",
  "provider",
  "recipient",
  "recipientName",
  "status",
  "subject",
  "templateKey",
  "renderedPreview",
  "providerMessageId",
  "errorCode",
  "errorMessage",
  "retryCount",
  "nextAttemptAtUtc",
  "sentAtUtc",
  "deliveredAtUtc",
  "failedAtUtc",
  "evidenceRequestId",
  "evidenceId",
  "intakeLinkId",
  "initiatedByUserId",
  "createdAt",
  "updatedAt",
];

const FORBIDDEN_FIELDS = [
  "templateContextJson", // payload with intake URL — only for internal retry
  "metadata", // may contain operator-only context
  "teamId", // workspace identifier — scope is enforced by route, not data
  "recipientUserId", // joined via separate query if needed
];

test("projection allowlist covers every safe-to-display field", () => {
  // Snapshot — any change to PROJECTED_FIELDS must update this list AND
  // the service file together.
  assert.equal(PROJECTED_FIELDS.length, 24);
});

test("forbidden fields are never in the allowlist", () => {
  for (const f of FORBIDDEN_FIELDS) {
    assert.equal(PROJECTED_FIELDS.includes(f), false, f);
  }
});

test("masking — email partial mask keeps the domain", () => {
  function maskEmail(value) {
    if (!value.includes("@")) return value;
    const [local, domain] = value.split("@");
    if (!local || !domain) return value;
    const head = local.slice(0, 2);
    return `${head}${"*".repeat(Math.max(0, local.length - 2))}@${domain}`;
  }
  assert.equal(maskEmail("jane.smith@example.com"), "ja********@example.com");
  assert.equal(maskEmail("ab@example.com"), "ab@example.com");
  assert.equal(maskEmail("notanemail"), "notanemail");
});
