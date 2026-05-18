import test from "node:test";
import assert from "node:assert/strict";

// Phase 26.75 — Enterprise Identity Runtime shared contract tests.
//
// Coverage:
//   - Privileged action catalog covers the brief's enforcement surfaces
//   - PRIVILEGED_ACTION_REQUIRES_FRESH_AUTH_HOURS bounded per action
//   - privilegedActionRequiresFreshAuth: per-action window honoured
//   - privilegedActionRequiresFreshAuth: bounded by max session age
//   - Quarantine reason catalog + max-hours bounds
//   - Geo provider catalog + timeout bounds
//   - isSessionDueForRiskRecompute: first-time + within-window + past-window
//   - computeTrustDecay: stale penalty + risky increment + cap at 100
//   - isForcedReauthAllowed: cooldown enforced

import {
  FORCED_REAUTH_COOLDOWN_DEFAULT_MINUTES,
  GEO_LOOKUP_DEFAULT_TIMEOUT_MS,
  GEO_LOOKUP_MAX_TIMEOUT_MS,
  GEO_PROVIDERS,
  HIGH_RISK_INCIDENT_DEFAULT_THRESHOLD,
  PRIVILEGED_ACTIONS,
  PRIVILEGED_ACTION_REQUIRES_FRESH_AUTH_HOURS,
  PRIVILEGED_SESSION_MAX_AGE_DEFAULT_HOURS,
  PrivilegedActionSchema,
  RUNTIME_RISK_RECOMPUTE_DEFAULT_MINUTES,
  SESSION_QUARANTINE_DEFAULT_HOURS,
  SESSION_QUARANTINE_MAX_HOURS,
  SESSION_QUARANTINE_REASONS,
  SessionQuarantineReasonSchema,
  TRUST_DECAY_DEFAULT_MAX,
  TRUST_DECAY_STALE_DAYS,
  computeTrustDecay,
  isForcedReauthAllowed,
  isSessionDueForRiskRecompute,
  privilegedActionRequiresFreshAuth,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Privileged action catalog
// -----------------------------------------------------------------------------

test("PRIVILEGED_ACTIONS catalog covers the brief's enforcement surfaces", () => {
  for (const a of [
    "REVIEWER_APPROVE",
    "REVIEWER_REJECT",
    "REVIEWER_BULK",
    "REVIEW_ESCALATION_RESOLVE",
    "REVIEW_ESCALATION_SUPPRESS",
    "EXPORT_GENERATE_PACKAGE",
    "EXPORT_GENERATE_REPORT",
    "ORIGINAL_EVIDENCE_DOWNLOAD",
    "RETENTION_POLICY_UPDATE",
    "LEGAL_HOLD_PLACE",
    "LEGAL_HOLD_RELEASE",
    "SCIM_TOKEN_CREATE",
    "SCIM_TOKEN_REVOKE",
    "SERVICE_ACCOUNT_CREATE",
    "SERVICE_ACCOUNT_ROTATE",
    "SSO_CONNECTION_CREATE",
    "SSO_CONNECTION_REVOKE",
    "ORG_SECURITY_POLICY_UPDATE",
    "WORKSPACE_GOVERNANCE_UPDATE",
    "API_CREDENTIAL_CREATE",
    "WEBHOOK_SECRET_ROTATE",
    "RBAC_TEMPORARY_ELEVATION",
    "DELEGATED_SCOPE_GRANT",
    "DELEGATED_SCOPE_REVOKE",
    "MEMBER_SUSPEND",
    "MEMBER_REVOKE",
    "MEMBER_ROLE_CHANGE",
  ]) {
    assert.equal(
      PRIVILEGED_ACTIONS.includes(a),
      true,
      `missing action ${a}`,
    );
    assert.equal(PrivilegedActionSchema.safeParse(a).success, true);
  }
});

test("PRIVILEGED_ACTION_REQUIRES_FRESH_AUTH_HOURS bounded per action", () => {
  for (const a of PRIVILEGED_ACTIONS) {
    const hrs = PRIVILEGED_ACTION_REQUIRES_FRESH_AUTH_HOURS[a];
    assert.equal(typeof hrs, "number");
    assert.equal(hrs > 0, true);
    assert.equal(hrs <= PRIVILEGED_SESSION_MAX_AGE_DEFAULT_HOURS, true);
  }
});

const NOW = new Date("2026-06-05T12:00:00Z").getTime();

test("privilegedActionRequiresFreshAuth: fresh session → no reauth", () => {
  const result = privilegedActionRequiresFreshAuth({
    sessionIssuedAtUtc: new Date(NOW - 30 * 60_000), // 30 min ago
    action: "REVIEWER_APPROVE", // 8h window
    nowUtc: new Date(NOW),
  });
  assert.equal(result, false);
});

test("privilegedActionRequiresFreshAuth: past per-action window → reauth", () => {
  const result = privilegedActionRequiresFreshAuth({
    sessionIssuedAtUtc: new Date(NOW - 10 * 3600_000), // 10h ago
    action: "REVIEWER_APPROVE", // 8h window
    nowUtc: new Date(NOW),
  });
  assert.equal(result, true);
});

test("privilegedActionRequiresFreshAuth: short-window action triggers earlier", () => {
  const result = privilegedActionRequiresFreshAuth({
    sessionIssuedAtUtc: new Date(NOW - 2 * 3600_000), // 2h ago
    action: "ORIGINAL_EVIDENCE_DOWNLOAD", // 1h window
    nowUtc: new Date(NOW),
  });
  assert.equal(result, true);
});

test("privilegedActionRequiresFreshAuth: respects maxAgeHours override", () => {
  const result = privilegedActionRequiresFreshAuth({
    sessionIssuedAtUtc: new Date(NOW - 6 * 3600_000),
    action: "REVIEWER_APPROVE", // 8h
    maxAgeHours: 4, // narrower override
    nowUtc: new Date(NOW),
  });
  assert.equal(result, true);
});

// -----------------------------------------------------------------------------
// Quarantine catalog
// -----------------------------------------------------------------------------

test("SESSION_QUARANTINE_REASONS catalog matches the brief", () => {
  for (const r of [
    "MANUAL_OPERATOR",
    "SUSPICIOUS_SESSION_AUTO",
    "REPEATED_REPLAY",
    "GEO_ANOMALY",
    "PRIVILEGED_SESSION_AGED",
    "SUSPICIOUS_REVIEWER_ACTIVITY",
    "SUSPICIOUS_ADMIN_ACTIVITY",
    "EMERGENCY_ORG_WIDE",
  ]) {
    assert.equal(SESSION_QUARANTINE_REASONS.includes(r), true);
    assert.equal(SessionQuarantineReasonSchema.safeParse(r).success, true);
  }
});

test("Quarantine duration bounded (default ≤ max)", () => {
  assert.equal(SESSION_QUARANTINE_DEFAULT_HOURS > 0, true);
  assert.equal(
    SESSION_QUARANTINE_DEFAULT_HOURS <= SESSION_QUARANTINE_MAX_HOURS,
    true,
  );
  assert.equal(SESSION_QUARANTINE_MAX_HOURS <= 24, true);
});

// -----------------------------------------------------------------------------
// Geo
// -----------------------------------------------------------------------------

test("GEO_PROVIDERS catalog includes the brief's targets", () => {
  for (const p of ["OFFLINE_DB", "MAXMIND", "IP2LOCATION", "STUB"]) {
    assert.equal(GEO_PROVIDERS.includes(p), true);
  }
});

test("Geo lookup timeout bounded", () => {
  assert.equal(GEO_LOOKUP_DEFAULT_TIMEOUT_MS > 0, true);
  assert.equal(GEO_LOOKUP_DEFAULT_TIMEOUT_MS <= GEO_LOOKUP_MAX_TIMEOUT_MS, true);
  assert.equal(GEO_LOOKUP_MAX_TIMEOUT_MS <= 5000, true);
});

// -----------------------------------------------------------------------------
// Runtime risk recompute
// -----------------------------------------------------------------------------

test("isSessionDueForRiskRecompute: null lastRecomputed → due", () => {
  assert.equal(
    isSessionDueForRiskRecompute({ lastRiskRecomputedAtUtc: null }),
    true,
  );
});

test("isSessionDueForRiskRecompute: within window → skip", () => {
  const now = new Date("2026-06-05T12:00:00Z");
  const recent = new Date(now.getTime() - 5 * 60_000); // 5 min ago
  assert.equal(
    isSessionDueForRiskRecompute({
      lastRiskRecomputedAtUtc: recent,
      nowUtc: now,
      recomputeWindowMinutes: 15,
    }),
    false,
  );
});

test("isSessionDueForRiskRecompute: past window → due", () => {
  const now = new Date("2026-06-05T12:00:00Z");
  const old = new Date(now.getTime() - 30 * 60_000); // 30 min ago
  assert.equal(
    isSessionDueForRiskRecompute({
      lastRiskRecomputedAtUtc: old,
      nowUtc: now,
      recomputeWindowMinutes: 15,
    }),
    true,
  );
});

test("RUNTIME_RISK_RECOMPUTE_DEFAULT_MINUTES is 15", () => {
  assert.equal(RUNTIME_RISK_RECOMPUTE_DEFAULT_MINUTES, 15);
});

// -----------------------------------------------------------------------------
// Trust decay
// -----------------------------------------------------------------------------

test("computeTrustDecay: fresh device → no decay", () => {
  const result = computeTrustDecay({
    lastSeenAtUtc: new Date(NOW - 60_000),
    currentDecay: 0,
    nowUtc: new Date(NOW),
  });
  assert.equal(result, 0);
});

test("computeTrustDecay: stale device beyond threshold → penalty", () => {
  const result = computeTrustDecay({
    lastSeenAtUtc: new Date(NOW - (TRUST_DECAY_STALE_DAYS + 10) * 86400_000),
    currentDecay: 0,
    nowUtc: new Date(NOW),
  });
  assert.equal(result > 0, true);
});

test("computeTrustDecay: risky increment compounds with stale penalty", () => {
  const result = computeTrustDecay({
    lastSeenAtUtc: new Date(NOW - 30 * 86400_000),
    currentDecay: 10,
    riskyIncrement: 25,
    nowUtc: new Date(NOW),
  });
  assert.equal(result > 35, true);
});

test("computeTrustDecay: caps at 100", () => {
  const result = computeTrustDecay({
    lastSeenAtUtc: new Date(NOW - 200 * 86400_000),
    currentDecay: 80,
    riskyIncrement: 50,
    nowUtc: new Date(NOW),
  });
  assert.equal(result, TRUST_DECAY_DEFAULT_MAX);
});

test("TRUST_DECAY_DEFAULT_MAX is 100", () => {
  assert.equal(TRUST_DECAY_DEFAULT_MAX, 100);
});

// -----------------------------------------------------------------------------
// Forced reauth cooldown
// -----------------------------------------------------------------------------

test("isForcedReauthAllowed: never reauth'd → allowed", () => {
  assert.equal(
    isForcedReauthAllowed({ lastForcedReauthAtUtc: null }),
    true,
  );
});

test("isForcedReauthAllowed: within cooldown → blocked", () => {
  const now = new Date("2026-06-05T12:00:00Z");
  const recent = new Date(now.getTime() - 5 * 60_000);
  assert.equal(
    isForcedReauthAllowed({
      lastForcedReauthAtUtc: recent,
      nowUtc: now,
      cooldownMinutes: FORCED_REAUTH_COOLDOWN_DEFAULT_MINUTES,
    }),
    false,
  );
});

test("isForcedReauthAllowed: past cooldown → allowed", () => {
  const now = new Date("2026-06-05T12:00:00Z");
  const old = new Date(now.getTime() - 45 * 60_000);
  assert.equal(
    isForcedReauthAllowed({
      lastForcedReauthAtUtc: old,
      nowUtc: now,
      cooldownMinutes: 30,
    }),
    true,
  );
});

test("HIGH_RISK_INCIDENT_DEFAULT_THRESHOLD is 5", () => {
  assert.equal(HIGH_RISK_INCIDENT_DEFAULT_THRESHOLD, 5);
});
