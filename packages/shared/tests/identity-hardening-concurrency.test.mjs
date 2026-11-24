import test from "node:test";
import assert from "node:assert/strict";

// T-025 — concurrent sessions count only when corroborated (different network,
// device or country). One person's own sessions from one device stay LOW.

import {
  CONCURRENT_RISKY_SESSIONS_MIN_CORROBORATED,
  SUSPICIOUS_SESSION_SIGNAL_WEIGHTS,
  computeSuspiciousSessionRisk,
  concurrentSessionsSignalApplies,
  countCorroboratedConcurrentSessions,
  sessionRiskLevel,
} from "../dist/index.js";

const here = { ipPreview: "203.0.113.x", deviceIdHash: null, countryCode: "DE" };

function levelFor(current, others) {
  const signals = concurrentSessionsSignalApplies(current, others)
    ? [{ kind: "CONCURRENT_RISKY_SESSIONS", weight: SUSPICIOUS_SESSION_SIGNAL_WEIGHTS.CONCURRENT_RISKY_SESSIONS, reason: "t" }]
    : [];
  return sessionRiskLevel(computeSuspiciousSessionRisk(signals));
}

test("five sessions from the same browser and network stay LOW", () => {
  const others = Array.from({ length: 5 }, () => ({ ...here }));
  assert.equal(countCorroboratedConcurrentSessions(here, others), 0);
  assert.equal(levelFor(here, others), "LOW");
});

test("sessions with no previews never read as a difference", () => {
  const others = Array.from({ length: 6 }, () => ({ ipPreview: null, deviceIdHash: null, countryCode: null }));
  assert.equal(countCorroboratedConcurrentSessions(here, others), 0);
  assert.equal(levelFor(here, others), "LOW");
});

test("same device hash on several sessions stays LOW", () => {
  const cur = { ipPreview: null, deviceIdHash: "dev-1", countryCode: null };
  const others = Array.from({ length: 4 }, () => ({ ipPreview: null, deviceIdHash: "dev-1", countryCode: null }));
  assert.equal(levelFor(cur, others), "LOW");
});

test("three or more sessions from distinct networks still raise MEDIUM", () => {
  const others = [
    { ipPreview: "198.51.100.x", deviceIdHash: null, countryCode: "DE" },
    { ipPreview: "192.0.2.x", deviceIdHash: null, countryCode: "DE" },
    { ipPreview: "100.64.0.x", deviceIdHash: null, countryCode: "DE" },
  ];
  assert.equal(countCorroboratedConcurrentSessions(here, others), 3);
  assert.equal(CONCURRENT_RISKY_SESSIONS_MIN_CORROBORATED, 3);
  assert.equal(levelFor(here, others), "MEDIUM");
});

test("a distinct device or country corroborates as well as a distinct network", () => {
  const cur = { ipPreview: "203.0.113.x", deviceIdHash: "dev-1", countryCode: "DE" };
  const others = [
    { ipPreview: "203.0.113.x", deviceIdHash: "dev-2", countryCode: "DE" },
    { ipPreview: "203.0.113.x", deviceIdHash: "dev-1", countryCode: "FR" },
    { ipPreview: "198.51.100.x", deviceIdHash: "dev-1", countryCode: "DE" },
    { ipPreview: "203.0.113.x", deviceIdHash: "dev-1", countryCode: "DE" },
  ];
  assert.equal(countCorroboratedConcurrentSessions(cur, others), 3);
  assert.equal(levelFor(cur, others), "MEDIUM");
});

test("two corroborated sessions are not enough", () => {
  const others = [
    { ipPreview: "198.51.100.x", deviceIdHash: null, countryCode: "DE" },
    { ipPreview: "192.0.2.x", deviceIdHash: null, countryCode: "DE" },
    { ...here },
    { ...here },
  ];
  assert.equal(levelFor(here, others), "LOW");
});
