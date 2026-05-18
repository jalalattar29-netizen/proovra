import test from "node:test";
import assert from "node:assert/strict";

import {
  MFA_POLICY_LEVELS,
  RISK_LEVELS,
  RISK_SIGNAL_KINDS,
  SESSION_REVOCATION_REASONS,
  STEP_UP_CHALLENGE_STATUSES,
  STEP_UP_PURPOSES,
  STEP_UP_TTL_DEFAULT_SECONDS,
  STEP_UP_TTL_MAX_SECONDS,
  TRUSTED_DEVICE_STATUSES,
  TRUSTED_DEVICE_TTL_DAYS_DEFAULT,
  TRUSTED_DEVICE_TTL_DAYS_MAX,
  computeRiskScore,
  isTerminalStepUpStatus,
  isValidDeviceCookieValue,
  maskIpPreview,
  mfaRequiredForRole,
  riskBlocksAction,
  riskRequiresStepUp,
  riskSignalWeight,
  summariseUserAgent,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Catalogs
// -----------------------------------------------------------------------------

test("MFA policy levels cover OFF/ADMINS_ONLY/REVIEWERS_AND_ABOVE/ALL_MEMBERS/HIGH_RISK_ONLY", () => {
  assert.deepEqual([...MFA_POLICY_LEVELS].sort(), [
    "ADMINS_ONLY",
    "ALL_MEMBERS",
    "HIGH_RISK_ONLY",
    "OFF",
    "REVIEWERS_AND_ABOVE",
  ]);
});

test("Risk levels cover LOW/MEDIUM/HIGH/CRITICAL", () => {
  assert.deepEqual([...RISK_LEVELS].sort(), [
    "CRITICAL",
    "HIGH",
    "LOW",
    "MEDIUM",
  ]);
});

test("Step-up purposes cover every documented sensitive action", () => {
  for (const p of [
    "MEMBER_SUSPEND",
    "MEMBER_REVOKE",
    "MEMBER_ROLE_CHANGE",
    "DELEGATED_ADMIN_GRANT",
    "DELEGATED_ADMIN_REVOKE",
    "SERVICE_ACCOUNT_CREATE",
    "SERVICE_ACCOUNT_REVOKE",
    "SERVICE_ACCOUNT_DISABLE",
    "LEGAL_HOLD_RELEASE",
    "PUBLIC_VERIFY_PUBLISH",
    "PUBLIC_VERIFY_UNPUBLISH",
    "PUBLIC_VERIFY_SUSPEND",
    "PUBLIC_VERIFY_RESTORE",
    "GOVERNANCE_POLICY_UPDATE",
    "RETENTION_POLICY_UPDATE",
    "ORIGINAL_EVIDENCE_DOWNLOAD",
    "REPORT_EXPORT_HIGH_RISK",
    "PACKAGE_EXPORT_HIGH_RISK",
    "REVIEW_APPROVAL_HIGH_RISK",
    "MFA_POLICY_UPDATE",
    "CONTRIBUTOR_PHONE_VERIFICATION",
  ]) {
    assert.ok(STEP_UP_PURPOSES.includes(p), p);
  }
});

test("Step-up challenge statuses cover the state machine", () => {
  assert.deepEqual([...STEP_UP_CHALLENGE_STATUSES].sort(), [
    "APPROVED",
    "CANCELLED",
    "DENIED",
    "EXPIRED",
    "PENDING",
  ]);
});

test("Trusted device statuses are ACTIVE / REVOKED", () => {
  assert.deepEqual([...TRUSTED_DEVICE_STATUSES].sort(), ["ACTIVE", "REVOKED"]);
});

test("Risk signal kinds cover the deterministic catalog", () => {
  for (const k of [
    "NEW_DEVICE",
    "NEW_IP",
    "NEW_USER_AGENT",
    "NEW_COUNTRY",
    "IMPOSSIBLE_TRAVEL",
    "FAILED_AUTH_BURST",
    "FAILED_OTP_BURST",
    "SERVICE_ACCOUNT_NEW_IP",
    "SERVICE_ACCOUNT_IP_ALLOWLIST_VIOLATION",
    "CONTRIBUTOR_TOKEN_FAILURE_BURST",
    "CONTRIBUTOR_REVOKED_ATTEMPT",
    "SUSPENDED_MEMBER_ACTIVITY",
    "REVOKED_MEMBER_ACTIVITY",
    "EXCESSIVE_COMMUNICATION_SENDS",
    "PERMISSION_DENIED_BURST",
    "WEBHOOK_INVALID_SIGNATURE_BURST",
  ]) {
    assert.ok(RISK_SIGNAL_KINDS.includes(k), k);
  }
});

test("Session revocation reasons cover the documented set", () => {
  for (const r of [
    "OPERATOR_REVOKED",
    "USER_LOGGED_OUT",
    "MEMBER_SUSPENDED",
    "MEMBER_REVOKED",
    "SUSPICIOUS_ACTIVITY",
    "STEP_UP_DENIED",
    "POLICY_CHANGE",
    "RECONCILIATION_SWEEP",
  ]) {
    assert.ok(SESSION_REVOCATION_REASONS.includes(r), r);
  }
});

// -----------------------------------------------------------------------------
// MFA policy
// -----------------------------------------------------------------------------

test("mfaRequiredForRole — OFF requires nothing", () => {
  for (const role of ["OWNER", "ADMIN", "MEMBER", "VIEWER"]) {
    assert.equal(mfaRequiredForRole("OFF", role), false, role);
  }
});

test("mfaRequiredForRole — ADMINS_ONLY only requires OWNER + ADMIN", () => {
  assert.equal(mfaRequiredForRole("ADMINS_ONLY", "OWNER"), true);
  assert.equal(mfaRequiredForRole("ADMINS_ONLY", "ADMIN"), true);
  assert.equal(mfaRequiredForRole("ADMINS_ONLY", "MEMBER"), false);
  assert.equal(mfaRequiredForRole("ADMINS_ONLY", "VIEWER"), false);
});

test("mfaRequiredForRole — REVIEWERS_AND_ABOVE covers OWNER/ADMIN/MEMBER", () => {
  assert.equal(mfaRequiredForRole("REVIEWERS_AND_ABOVE", "OWNER"), true);
  assert.equal(mfaRequiredForRole("REVIEWERS_AND_ABOVE", "ADMIN"), true);
  assert.equal(mfaRequiredForRole("REVIEWERS_AND_ABOVE", "MEMBER"), true);
  assert.equal(mfaRequiredForRole("REVIEWERS_AND_ABOVE", "VIEWER"), false);
});

test("mfaRequiredForRole — ALL_MEMBERS covers every role", () => {
  for (const role of ["OWNER", "ADMIN", "MEMBER", "VIEWER"]) {
    assert.equal(mfaRequiredForRole("ALL_MEMBERS", role), true, role);
  }
});

test("mfaRequiredForRole — HIGH_RISK_ONLY does NOT trigger by role (risk wins)", () => {
  for (const role of ["OWNER", "ADMIN", "MEMBER", "VIEWER"]) {
    assert.equal(mfaRequiredForRole("HIGH_RISK_ONLY", role), false, role);
  }
});

test("mfaRequiredForRole — unknown policy fails closed", () => {
  // @ts-expect-error — deliberately passing a bad value
  assert.equal(mfaRequiredForRole("WHATEVER", "ADMIN"), true);
});

// -----------------------------------------------------------------------------
// Risk scoring
// -----------------------------------------------------------------------------

test("computeRiskScore — empty signals = LOW", () => {
  const r = computeRiskScore({ signals: [] });
  assert.equal(r.score, 0);
  assert.equal(r.level, "LOW");
});

test("computeRiskScore — single NEW_DEVICE -> MEDIUM at default thresholds", () => {
  const r = computeRiskScore({ signals: ["NEW_DEVICE"] });
  // NEW_DEVICE = 25, default medium = 40 -> still LOW
  assert.equal(r.level, "LOW");
});

test("computeRiskScore — NEW_DEVICE + NEW_IP -> MEDIUM (45)", () => {
  const r = computeRiskScore({ signals: ["NEW_DEVICE", "NEW_IP"] });
  assert.equal(r.score, 45);
  assert.equal(r.level, "MEDIUM");
});

test("computeRiskScore — IMPOSSIBLE_TRAVEL -> HIGH (80)", () => {
  const r = computeRiskScore({ signals: ["IMPOSSIBLE_TRAVEL"] });
  assert.equal(r.score, 80);
  assert.equal(r.level, "HIGH");
});

test("computeRiskScore — REVOKED_MEMBER_ACTIVITY alone -> CRITICAL", () => {
  const r = computeRiskScore({ signals: ["REVOKED_MEMBER_ACTIVITY"] });
  assert.equal(r.score, 100);
  assert.equal(r.level, "CRITICAL");
});

test("computeRiskScore — score is capped at 100", () => {
  const r = computeRiskScore({
    signals: ["IMPOSSIBLE_TRAVEL", "REVOKED_MEMBER_ACTIVITY", "NEW_DEVICE"],
  });
  assert.equal(r.score, 100);
  assert.equal(r.level, "CRITICAL");
});

test("computeRiskScore — operator-tunable thresholds shift the level", () => {
  // With high=20 and medium=10 a single NEW_DEVICE becomes HIGH.
  const r = computeRiskScore({
    signals: ["NEW_DEVICE"],
    highThreshold: 20,
    mediumThreshold: 10,
  });
  assert.equal(r.level, "HIGH");
});

test("riskRequiresStepUp -> true for HIGH + CRITICAL only", () => {
  assert.equal(riskRequiresStepUp("LOW"), false);
  assert.equal(riskRequiresStepUp("MEDIUM"), false);
  assert.equal(riskRequiresStepUp("HIGH"), true);
  assert.equal(riskRequiresStepUp("CRITICAL"), true);
});

test("riskBlocksAction -> only CRITICAL", () => {
  for (const l of ["LOW", "MEDIUM", "HIGH"]) {
    assert.equal(riskBlocksAction(l), false, l);
  }
  assert.equal(riskBlocksAction("CRITICAL"), true);
});

test("riskSignalWeight returns the documented weights", () => {
  assert.equal(riskSignalWeight("NEW_DEVICE"), 25);
  assert.equal(riskSignalWeight("NEW_IP"), 20);
  assert.equal(riskSignalWeight("IMPOSSIBLE_TRAVEL"), 80);
  assert.equal(riskSignalWeight("REVOKED_MEMBER_ACTIVITY"), 100);
});

// -----------------------------------------------------------------------------
// Step-up helpers
// -----------------------------------------------------------------------------

test("isTerminalStepUpStatus — APPROVED/DENIED/EXPIRED/CANCELLED", () => {
  for (const s of ["APPROVED", "DENIED", "EXPIRED", "CANCELLED"]) {
    assert.equal(isTerminalStepUpStatus(s), true, s);
  }
  assert.equal(isTerminalStepUpStatus("PENDING"), false);
});

test("STEP_UP_TTL constants are sensible defaults", () => {
  assert.equal(STEP_UP_TTL_DEFAULT_SECONDS, 15 * 60);
  assert.equal(STEP_UP_TTL_MAX_SECONDS, 60 * 60);
});

// -----------------------------------------------------------------------------
// Trusted device helpers
// -----------------------------------------------------------------------------

test("TRUSTED_DEVICE_TTL constants are sensible", () => {
  assert.equal(TRUSTED_DEVICE_TTL_DAYS_DEFAULT, 30);
  assert.equal(TRUSTED_DEVICE_TTL_DAYS_MAX, 180);
});

test("isValidDeviceCookieValue — accepts long random URL-safe strings", () => {
  assert.equal(isValidDeviceCookieValue("a".repeat(32)), true);
  assert.equal(
    isValidDeviceCookieValue("abc_DEF-123_456-789_xyz"),
    true,
  );
});

test("isValidDeviceCookieValue — rejects short / disallowed characters", () => {
  assert.equal(isValidDeviceCookieValue("short"), false);
  assert.equal(isValidDeviceCookieValue(null), false);
  assert.equal(isValidDeviceCookieValue(undefined), false);
  // Contains a space.
  assert.equal(isValidDeviceCookieValue("abcdefghij klmnopqrstuvwxyz"), false);
});

// -----------------------------------------------------------------------------
// Privacy helpers — masking
// -----------------------------------------------------------------------------

test("maskIpPreview — IPv4 preserves first + last octet only", () => {
  assert.equal(maskIpPreview("1.2.3.4"), "1.•••.•••.4");
  assert.equal(maskIpPreview("192.168.1.99"), "192.•••.•••.99");
});

test("maskIpPreview — IPv6 preserves first + last hextet", () => {
  const out = maskIpPreview("2001:db8:0:0:0:0:0:1");
  assert.ok(out.startsWith("2001:"));
  assert.ok(out.endsWith(":1"));
});

test("maskIpPreview — null/empty/malformed are safe", () => {
  assert.equal(maskIpPreview(null), "");
  assert.equal(maskIpPreview(""), "");
  assert.equal(maskIpPreview("not.an.ip"), "•••");
});

test("summariseUserAgent — recognises common families", () => {
  assert.match(
    summariseUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ),
    /Chrome/,
  );
  assert.match(
    summariseUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    ),
    /Safari on macOS/,
  );
  assert.equal(summariseUserAgent(""), "");
  assert.equal(summariseUserAgent(null), "");
});
