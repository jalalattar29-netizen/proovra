import test from "node:test";
import assert from "node:assert/strict";

// Phase 26.5 — Enterprise Identity Hardening shared contract tests.
//
// Coverage:
//   - Suspicious session signal catalog + weights
//   - computeSuspiciousSessionRisk: additive, capped at 100, deterministic
//   - sessionRiskLevel thresholds
//   - evaluateAdaptiveAuth: CRITICAL → BLOCK, HIGH untrusted → REAUTH,
//     HIGH trusted → STEP_UP, MEDIUM → STEP_UP, LOW + privileged + policy
//     → STEP_UP, stale + privileged → REAUTH
//   - isSafeRedirectAfter: relative ok, // blocked, allowed-origin ok
//   - shouldWriteHeartbeat: first hit ok, within window skip, past window
//     ok
//   - isSessionStale: anchors on heartbeat OR lastSeen
//   - SsoCallbackAttempt status catalog
//   - SCIM Group schema requires SCIM 2.0 URI + displayName
//   - SCIM Group PATCH schema requires PatchOp URI
//   - SCIM_GROUP_MAPPED_ROLES bounded to ADMIN / MEMBER / VIEWER

import {
  ADAPTIVE_AUTH_DECISIONS,
  SCIM_GROUP_MAPPED_ROLES,
  SCIM_GROUP_SCHEMA_URI,
  SCIM_GROUP_STATUSES,
  SESSION_HEARTBEAT_DEFAULT_SAMPLE_SECONDS,
  SESSION_RISK_HIGH_THRESHOLD,
  SESSION_RISK_LEVELS,
  SESSION_RISK_MEDIUM_THRESHOLD,
  SESSION_STALE_DEFAULT_MINUTES,
  SSO_CALLBACK_ATTEMPT_STATUSES,
  SSO_CALLBACK_STATE_TTL_SECONDS,
  SUSPICIOUS_SESSION_SIGNAL_KINDS,
  SUSPICIOUS_SESSION_SIGNAL_WEIGHTS,
  ScimGroupPatchOpSchema,
  ScimGroupSchema,
  SuspiciousSessionSignalKindSchema,
  computeSuspiciousSessionRisk,
  evaluateAdaptiveAuth,
  isSafeRedirectAfter,
  isSessionStale,
  sessionRiskLevel,
  shouldWriteHeartbeat,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Suspicious session catalog + score
// -----------------------------------------------------------------------------

test("SUSPICIOUS_SESSION_SIGNAL_KINDS covers the brief", () => {
  for (const k of [
    "IMPOSSIBLE_TRAVEL",
    "RAPID_GEO_CHANGE",
    "CONCURRENT_RISKY_SESSIONS",
    "HIGH_RISK_IP_SHIFT",
    "UNKNOWN_DEVICE_ANOMALY",
    "REPEATED_FAILED_SSO_CALLBACKS",
    "ELEVATED_PRIVILEGE_ANOMALY",
    "SUSPICIOUS_REVIEWER_ACTIVITY",
    "TOKEN_REPLAY_INDICATOR",
  ]) {
    assert.equal(SUSPICIOUS_SESSION_SIGNAL_KINDS.includes(k), true);
    assert.equal(SuspiciousSessionSignalKindSchema.safeParse(k).success, true);
    assert.equal(typeof SUSPICIOUS_SESSION_SIGNAL_WEIGHTS[k], "number");
  }
});

test("computeSuspiciousSessionRisk: empty signals → 0", () => {
  assert.equal(computeSuspiciousSessionRisk([]), 0);
});

test("computeSuspiciousSessionRisk: caps at 100", () => {
  const big = [
    { kind: "TOKEN_REPLAY_INDICATOR", weight: 90, reason: "" },
    { kind: "IMPOSSIBLE_TRAVEL", weight: 80, reason: "" },
  ];
  assert.equal(computeSuspiciousSessionRisk(big), 100);
});

test("computeSuspiciousSessionRisk: additive + deterministic", () => {
  const a = [
    { kind: "RAPID_GEO_CHANGE", weight: 50, reason: "" },
    { kind: "CONCURRENT_RISKY_SESSIONS", weight: 35, reason: "" },
  ];
  const b = [...a].reverse();
  assert.equal(computeSuspiciousSessionRisk(a), 85);
  assert.equal(computeSuspiciousSessionRisk(a), computeSuspiciousSessionRisk(b));
});

test("sessionRiskLevel thresholds", () => {
  assert.equal(sessionRiskLevel(0), "LOW");
  assert.equal(sessionRiskLevel(SESSION_RISK_MEDIUM_THRESHOLD - 1), "LOW");
  assert.equal(sessionRiskLevel(SESSION_RISK_MEDIUM_THRESHOLD), "MEDIUM");
  assert.equal(sessionRiskLevel(SESSION_RISK_HIGH_THRESHOLD - 1), "MEDIUM");
  assert.equal(sessionRiskLevel(SESSION_RISK_HIGH_THRESHOLD), "HIGH");
  assert.equal(sessionRiskLevel(89), "HIGH");
  assert.equal(sessionRiskLevel(90), "CRITICAL");
  assert.equal(sessionRiskLevel(100), "CRITICAL");
});

test("SESSION_RISK_LEVELS contains 4 canonical levels", () => {
  assert.equal(SESSION_RISK_LEVELS.length, 4);
});

// -----------------------------------------------------------------------------
// Adaptive auth decision matrix
// -----------------------------------------------------------------------------

const NOW = new Date("2026-06-04T12:00:00Z").getTime();

test("ADAPTIVE_AUTH_DECISIONS catalog (ALLOW / STEP_UP / REAUTH / BLOCK)", () => {
  assert.deepEqual([...ADAPTIVE_AUTH_DECISIONS].sort(), [
    "ALLOW",
    "BLOCK",
    "REQUIRE_REAUTH",
    "REQUIRE_STEP_UP",
  ]);
});

test("evaluateAdaptiveAuth: CRITICAL risk → BLOCK", () => {
  const r = evaluateAdaptiveAuth({
    riskScore: 95,
    trustedDevice: true,
    highPrivilegeAction: false,
    workspaceRequiresStepUp: false,
    nowMs: NOW,
  });
  assert.equal(r.decision, "BLOCK");
});

test("evaluateAdaptiveAuth: HIGH risk + untrusted → REQUIRE_REAUTH", () => {
  const r = evaluateAdaptiveAuth({
    riskScore: 70,
    trustedDevice: false,
    highPrivilegeAction: false,
    workspaceRequiresStepUp: false,
    nowMs: NOW,
  });
  assert.equal(r.decision, "REQUIRE_REAUTH");
});

test("evaluateAdaptiveAuth: HIGH risk + trusted → REQUIRE_STEP_UP", () => {
  const r = evaluateAdaptiveAuth({
    riskScore: 70,
    trustedDevice: true,
    highPrivilegeAction: false,
    workspaceRequiresStepUp: false,
    nowMs: NOW,
  });
  assert.equal(r.decision, "REQUIRE_STEP_UP");
  assert.equal(r.stepUpPurpose, "SESSION_SANITY_CHECK");
});

test("evaluateAdaptiveAuth: MEDIUM risk → REQUIRE_STEP_UP", () => {
  const r = evaluateAdaptiveAuth({
    riskScore: 40,
    trustedDevice: false,
    highPrivilegeAction: false,
    workspaceRequiresStepUp: false,
    nowMs: NOW,
  });
  assert.equal(r.decision, "REQUIRE_STEP_UP");
});

test("evaluateAdaptiveAuth: LOW + privileged + workspace policy → STEP_UP", () => {
  const r = evaluateAdaptiveAuth({
    riskScore: 10,
    trustedDevice: true,
    highPrivilegeAction: true,
    workspaceRequiresStepUp: true,
    nowMs: NOW,
  });
  assert.equal(r.decision, "REQUIRE_STEP_UP");
});

test("evaluateAdaptiveAuth: LOW + non-privileged → ALLOW", () => {
  const r = evaluateAdaptiveAuth({
    riskScore: 5,
    trustedDevice: true,
    highPrivilegeAction: false,
    workspaceRequiresStepUp: true,
    nowMs: NOW,
  });
  assert.equal(r.decision, "ALLOW");
});

test("evaluateAdaptiveAuth: session > 24h + privileged → REQUIRE_REAUTH", () => {
  const r = evaluateAdaptiveAuth({
    riskScore: 5,
    trustedDevice: true,
    highPrivilegeAction: true,
    workspaceRequiresStepUp: false,
    sessionIssuedAtMs: NOW - 25 * 3600 * 1000,
    nowMs: NOW,
  });
  assert.equal(r.decision, "REQUIRE_REAUTH");
});

test("evaluateAdaptiveAuth: stale-but-non-privileged → ALLOW", () => {
  const r = evaluateAdaptiveAuth({
    riskScore: 5,
    trustedDevice: true,
    highPrivilegeAction: false,
    workspaceRequiresStepUp: false,
    sessionIssuedAtMs: NOW - 48 * 3600 * 1000,
    nowMs: NOW,
  });
  assert.equal(r.decision, "ALLOW");
});

// -----------------------------------------------------------------------------
// Open-redirect protection
// -----------------------------------------------------------------------------

test("isSafeRedirectAfter: empty / null → allowed", () => {
  assert.equal(isSafeRedirectAfter(null), true);
  assert.equal(isSafeRedirectAfter(""), true);
});

test("isSafeRedirectAfter: relative (/foo) → allowed", () => {
  assert.equal(isSafeRedirectAfter("/home"), true);
  assert.equal(isSafeRedirectAfter("/reviewer-ops"), true);
});

test("isSafeRedirectAfter: protocol-relative (//) → blocked", () => {
  assert.equal(isSafeRedirectAfter("//evil.com/path"), false);
});

test("isSafeRedirectAfter: absolute http(s) requires allowed origin", () => {
  assert.equal(
    isSafeRedirectAfter("https://evil.com/path"),
    false,
  );
  assert.equal(
    isSafeRedirectAfter("https://app.proovra.com/home", [
      "https://app.proovra.com",
    ]),
    true,
  );
});

test("isSafeRedirectAfter: javascript: → blocked", () => {
  assert.equal(isSafeRedirectAfter("javascript:alert(1)"), false);
});

// -----------------------------------------------------------------------------
// Heartbeat sampling
// -----------------------------------------------------------------------------

test("shouldWriteHeartbeat: first heartbeat (null lastHeartbeat) → write", () => {
  assert.equal(
    shouldWriteHeartbeat({ lastHeartbeatAtUtc: null }),
    true,
  );
});

test("shouldWriteHeartbeat: within sample window → skip", () => {
  const now = new Date("2026-06-04T12:00:00Z");
  const recent = new Date(now.getTime() - 10_000); // 10s ago
  assert.equal(
    shouldWriteHeartbeat({
      lastHeartbeatAtUtc: recent,
      nowUtc: now,
      sampleWindowSeconds: 60,
    }),
    false,
  );
});

test("shouldWriteHeartbeat: past sample window → write", () => {
  const now = new Date("2026-06-04T12:00:00Z");
  const old = new Date(now.getTime() - 120_000); // 2 min ago
  assert.equal(
    shouldWriteHeartbeat({
      lastHeartbeatAtUtc: old,
      nowUtc: now,
      sampleWindowSeconds: 60,
    }),
    true,
  );
});

test("SESSION_HEARTBEAT_DEFAULT_SAMPLE_SECONDS is 60", () => {
  assert.equal(SESSION_HEARTBEAT_DEFAULT_SAMPLE_SECONDS, 60);
});

// -----------------------------------------------------------------------------
// Stale session detection
// -----------------------------------------------------------------------------

test("isSessionStale: fresh heartbeat → not stale", () => {
  const now = new Date("2026-06-04T12:00:00Z");
  assert.equal(
    isSessionStale({
      lastHeartbeatAtUtc: new Date(now.getTime() - 60_000),
      lastSeenAtUtc: new Date(now.getTime() - 60_000),
      nowUtc: now,
      staleMinutes: 30,
    }),
    false,
  );
});

test("isSessionStale: stale heartbeat → stale", () => {
  const now = new Date("2026-06-04T12:00:00Z");
  assert.equal(
    isSessionStale({
      lastHeartbeatAtUtc: new Date(now.getTime() - 45 * 60_000),
      lastSeenAtUtc: new Date(now.getTime() - 60_000),
      nowUtc: now,
      staleMinutes: 30,
    }),
    true,
  );
});

test("isSessionStale: falls back to lastSeenAtUtc when heartbeat null", () => {
  const now = new Date("2026-06-04T12:00:00Z");
  assert.equal(
    isSessionStale({
      lastHeartbeatAtUtc: null,
      lastSeenAtUtc: new Date(now.getTime() - 60 * 60_000),
      nowUtc: now,
      staleMinutes: 30,
    }),
    true,
  );
});

test("SESSION_STALE_DEFAULT_MINUTES is 30", () => {
  assert.equal(SESSION_STALE_DEFAULT_MINUTES, 30);
});

// -----------------------------------------------------------------------------
// SSO callback attempt catalog
// -----------------------------------------------------------------------------

test("SSO_CALLBACK_ATTEMPT_STATUSES catalog (PENDING/CONSUMED/EXPIRED/REPLAYED/FAILED)", () => {
  assert.deepEqual([...SSO_CALLBACK_ATTEMPT_STATUSES].sort(), [
    "CONSUMED",
    "EXPIRED",
    "FAILED",
    "PENDING",
    "REPLAYED",
  ]);
});

test("SSO_CALLBACK_STATE_TTL_SECONDS is 10 minutes", () => {
  assert.equal(SSO_CALLBACK_STATE_TTL_SECONDS, 600);
});

// -----------------------------------------------------------------------------
// SCIM Group schemas
// -----------------------------------------------------------------------------

test("SCIM_GROUP_STATUSES (ACTIVE / ARCHIVED)", () => {
  assert.deepEqual([...SCIM_GROUP_STATUSES].sort(), ["ACTIVE", "ARCHIVED"]);
});

test("SCIM_GROUP_MAPPED_ROLES (ADMIN / MEMBER / VIEWER)", () => {
  assert.deepEqual([...SCIM_GROUP_MAPPED_ROLES].sort(), [
    "ADMIN",
    "MEMBER",
    "VIEWER",
  ]);
});

test("ScimGroupSchema accepts a valid Group", () => {
  const r = ScimGroupSchema.safeParse({
    schemas: [SCIM_GROUP_SCHEMA_URI],
    displayName: "Engineering",
    mappedRole: "MEMBER",
  });
  assert.equal(r.success, true);
});

test("ScimGroupSchema requires the Group schema URI", () => {
  const r = ScimGroupSchema.safeParse({
    schemas: ["bogus"],
    displayName: "Engineering",
  });
  assert.equal(r.success, false);
});

test("ScimGroupSchema enforces mappedRole catalog", () => {
  const r = ScimGroupSchema.safeParse({
    schemas: [SCIM_GROUP_SCHEMA_URI],
    displayName: "Engineering",
    mappedRole: "GOD",
  });
  assert.equal(r.success, false);
});

test("ScimGroupPatchOpSchema requires PatchOp URI + Operations", () => {
  const valid = ScimGroupPatchOpSchema.safeParse({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "add", path: "members", value: [{ value: "u-1" }] }],
  });
  assert.equal(valid.success, true);

  const noOps = ScimGroupPatchOpSchema.safeParse({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [],
  });
  assert.equal(noOps.success, false);
});
