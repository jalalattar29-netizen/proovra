import test from "node:test";
import assert from "node:assert/strict";

import {
  ALERT_CATEGORIES,
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  REDACTED_KEY_SUBSTRINGS,
  clipSafeSummary,
  isAllowedIncidentStatusTransition,
  isSafeRequestId,
  isTerminalIncidentStatus,
  isValidIncidentFingerprint,
  shouldRedactKey,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Catalogs
// -----------------------------------------------------------------------------

test("incident severities cover INFO/WARNING/HIGH/CRITICAL", () => {
  assert.deepEqual([...INCIDENT_SEVERITIES].sort(), [
    "CRITICAL",
    "HIGH",
    "INFO",
    "WARNING",
  ]);
});

test("incident statuses cover the state machine", () => {
  assert.deepEqual([...INCIDENT_STATUSES].sort(), [
    "ACKNOWLEDGED",
    "OPEN",
    "RESOLVED",
    "SUPPRESSED",
  ]);
});

test("incident categories cover the documented domains", () => {
  for (const c of [
    "UPLOAD",
    "REPORT",
    "PACKAGE",
    "WEBHOOK",
    "COMMUNICATIONS",
    "IDENTITY_SECURITY",
    "GOVERNANCE",
    "STORAGE",
    "AI",
    "INTEGRATION",
    "DATABASE",
    "WORKER",
    "RECONCILIATION",
  ]) {
    assert.ok(INCIDENT_CATEGORIES.includes(c), c);
  }
});

test("alert categories cover the documented set", () => {
  for (const c of [
    "INCIDENT_CRITICAL_CREATED",
    "INCIDENT_HIGH_CREATED",
    "JOB_REPEATED_FAILURE",
    "PROVIDER_OUTAGE",
    "DB_READINESS_FAILURE",
    "WEBHOOK_INVALID_SIGNATURE_BURST",
    "IDENTITY_SECURITY_RISK_CRITICAL",
    "STORAGE_WRITE_FAILURE",
    "REPORT_BACKLOG_HIGH",
  ]) {
    assert.ok(ALERT_CATEGORIES.includes(c), c);
  }
});

// -----------------------------------------------------------------------------
// Status transitions
// -----------------------------------------------------------------------------

test("isTerminalIncidentStatus: RESOLVED + SUPPRESSED", () => {
  assert.equal(isTerminalIncidentStatus("RESOLVED"), true);
  assert.equal(isTerminalIncidentStatus("SUPPRESSED"), true);
  assert.equal(isTerminalIncidentStatus("OPEN"), false);
  assert.equal(isTerminalIncidentStatus("ACKNOWLEDGED"), false);
});

test("incident transitions: OPEN → ACKNOWLEDGED/RESOLVED/SUPPRESSED", () => {
  assert.equal(isAllowedIncidentStatusTransition("OPEN", "ACKNOWLEDGED"), true);
  assert.equal(isAllowedIncidentStatusTransition("OPEN", "RESOLVED"), true);
  assert.equal(isAllowedIncidentStatusTransition("OPEN", "SUPPRESSED"), true);
});

test("incident transitions: ACKNOWLEDGED can go back to OPEN", () => {
  assert.equal(
    isAllowedIncidentStatusTransition("ACKNOWLEDGED", "OPEN"),
    true,
  );
});

test("incident transitions: RESOLVED/SUPPRESSED can only re-open", () => {
  for (const next of ["ACKNOWLEDGED", "RESOLVED", "SUPPRESSED"]) {
    assert.equal(
      isAllowedIncidentStatusTransition("RESOLVED", next),
      false,
      `RESOLVED -> ${next}`,
    );
    assert.equal(
      isAllowedIncidentStatusTransition("SUPPRESSED", next),
      false,
      `SUPPRESSED -> ${next}`,
    );
  }
  assert.equal(isAllowedIncidentStatusTransition("RESOLVED", "OPEN"), true);
  assert.equal(isAllowedIncidentStatusTransition("SUPPRESSED", "OPEN"), true);
});

// -----------------------------------------------------------------------------
// Redaction key allowlist
// -----------------------------------------------------------------------------

test("REDACTED_KEY_SUBSTRINGS covers the documented secrets list", () => {
  for (const must of [
    "token",
    "secret",
    "password",
    "authorization",
    "cookie",
    "apikey",
    "jwt",
    "otp",
    "code",
  ]) {
    assert.ok(REDACTED_KEY_SUBSTRINGS.includes(must), must);
  }
});

test("shouldRedactKey: case-insensitive substring match", () => {
  for (const k of [
    "token",
    "TOKEN",
    "accessToken",
    "X-Auth-Token",
    "password",
    "secret_key",
    "Authorization",
    "Cookie",
    "apikey",
    "API_KEY",
    "jwt",
    "otp_code",
    "verification_sid",
    "session_id_hash",
    "device_id_hash",
    "key_hash",
  ]) {
    assert.equal(shouldRedactKey(k), true, k);
  }
});

test("shouldRedactKey: harmless keys pass through", () => {
  for (const k of [
    "name",
    "email",
    "createdAt",
    "id",
    "teamId",
    "userId",
    "status",
    "title",
  ]) {
    assert.equal(shouldRedactKey(k), false, k);
  }
});

// -----------------------------------------------------------------------------
// Request id validation
// -----------------------------------------------------------------------------

test("isSafeRequestId: well-formed UUIDs + ASCII tokens accepted", () => {
  assert.equal(
    isSafeRequestId("550e8400-e29b-41d4-a716-446655440000"),
    true,
  );
  assert.equal(isSafeRequestId("abc_123-XYZ"), true);
});

test("isSafeRequestId: rejects empty / oversized / non-ASCII", () => {
  assert.equal(isSafeRequestId(""), false);
  assert.equal(isSafeRequestId(null), false);
  assert.equal(isSafeRequestId(undefined), false);
  assert.equal(isSafeRequestId("a".repeat(200)), false);
  assert.equal(isSafeRequestId("contains spaces"), false);
  assert.equal(isSafeRequestId("evil/../"), false);
  assert.equal(isSafeRequestId("\x00\x01"), false);
});

// -----------------------------------------------------------------------------
// Safe summary clipping
// -----------------------------------------------------------------------------

test("clipSafeSummary: drops control characters + caps length", () => {
  assert.equal(
    clipSafeSummary("normal text"),
    "normal text",
  );
  assert.equal(
    clipSafeSummary("with\x00control\x1fchars"),
    "with control chars",
  );
  const long = "X".repeat(500);
  const clipped = clipSafeSummary(long);
  assert.equal(clipped.length, 400);
  assert.ok(clipped.endsWith("…"));
});

// -----------------------------------------------------------------------------
// Incident fingerprint validation
// -----------------------------------------------------------------------------

test("isValidIncidentFingerprint: accepts canonical fingerprints", () => {
  assert.equal(
    isValidIncidentFingerprint("webhook:security_event:invalid_signature"),
    true,
  );
  assert.equal(
    isValidIncidentFingerprint("communications.twilio.outage"),
    true,
  );
  assert.equal(
    isValidIncidentFingerprint("upload:stalled:evidence_uuid_prefix_8"),
    true,
  );
});

test("isValidIncidentFingerprint: rejects empty / oversized / unsafe", () => {
  assert.equal(isValidIncidentFingerprint(""), false);
  assert.equal(isValidIncidentFingerprint(null), false);
  assert.equal(isValidIncidentFingerprint(undefined), false);
  assert.equal(isValidIncidentFingerprint("a".repeat(250)), false);
  assert.equal(isValidIncidentFingerprint("with spaces"), false);
  assert.equal(isValidIncidentFingerprint("path/traversal"), false);
});
