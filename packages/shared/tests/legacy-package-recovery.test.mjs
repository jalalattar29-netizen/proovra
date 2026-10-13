import test from "node:test";
import assert from "node:assert/strict";
import {
  DEAD_LETTER_NEW_WINDOW_MS,
  buildVerificationMatrix,
  deadLetterNeedsAttention,
  deadLetterResolutionFromIncident,
  isDeadLetterQueue,
  readStoredTrustDecision,
  resolveOtsAnchoring,
  summarizeDeadLetterEntries,
  withShippedAnchoring,
} from "../dist/index.js";

import { REAL, upgradedProof } from "./helpers/ots-fixtures.mjs";

/**
 * (2026-10-13) The production incident in one record: a report stored before
 * the canonical OTS state carries a legacy anchoring `passed`, which a stored
 * snapshot reads as UNAVAILABLE; the package ships the record's proof, which
 * resolves ANCHORED. The package matrix must state what the package ships.
 */
const legacySnapshot = {
  score: 92,
  verdict: "STRONGLY_VERIFIED",
  signals: [
    { key: "core_integrity", label: "Core integrity", status: "passed", summary: "ok", detail: "" },
    { key: "bitcoin_anchoring", label: "Bitcoin anchoring", status: "passed", summary: "Anchored", detail: "txid recorded" },
  ],
};

const otsRowOf = (decision) =>
  buildVerificationMatrix({
    signals: decision.signals,
    identity: null,
    acquisitionMode: null,
    packageSeal: { kind: "SELF" },
    publication: { kind: "DOCUMENT" },
  }).rows.find((r) => r.key === "ots_anchoring");

test("a legacy stored anchoring pass reads UNAVAILABLE — the cause of the production contradiction", () => {
  const stored = readStoredTrustDecision(legacySnapshot);
  assert.equal(otsRowOf(stored).otsState, "UNAVAILABLE");
});

test("withShippedAnchoring: the matrix states the anchoring of the proof the package ships (real upgraded proof)", () => {
  const anchoring = resolveOtsAnchoring({
    status: "ANCHORED",
    proofBase64: upgradedProof().base64,
    fingerprintHash: REAL.boundFingerprintHash,
  });
  assert.equal(anchoring.state, "ANCHORED");
  const stored = readStoredTrustDecision(legacySnapshot);
  const shipped = withShippedAnchoring(stored, anchoring);
  assert.equal(otsRowOf(shipped).otsState, "ANCHORED");
  // Every other signal keeps the report's words.
  assert.deepEqual(
    shipped.signals.filter((s) => s.key !== "bitcoin_anchoring"),
    stored.signals.filter((s) => s.key !== "bitcoin_anchoring"),
  );
  // No score, no verdict survives.
  assert.equal("score" in shipped, false);
});

test("withShippedAnchoring never promotes: pending, foreign-digest and malformed proofs stay what they are", () => {
  const stored = readStoredTrustDecision(legacySnapshot);
  const pending = resolveOtsAnchoring({ status: "ANCHORED", proofBase64: REAL.boundProofBase64, fingerprintHash: REAL.boundFingerprintHash });
  assert.equal(otsRowOf(withShippedAnchoring(stored, pending)).otsState, "PENDING");
  const foreign = resolveOtsAnchoring({ status: "ANCHORED", proofBase64: upgradedProof().base64, fingerprintHash: "a".repeat(64) });
  assert.equal(otsRowOf(withShippedAnchoring(stored, foreign)).otsState, "FAILED");
  const malformed = resolveOtsAnchoring({ status: "ANCHORED", proofBase64: Buffer.from("nope").toString("base64"), fingerprintHash: REAL.boundFingerprintHash });
  assert.equal(otsRowOf(withShippedAnchoring(stored, malformed)).otsState, "FAILED");
  assert.equal(otsRowOf(withShippedAnchoring(stored, { state: "NOT_REQUESTED", anchoredAtUtc: null })).otsState, "NOT_REQUESTED");
});

test("withShippedAnchoring adds the anchoring signal to a decision that has none", () => {
  const stored = readStoredTrustDecision({ signals: [legacySnapshot.signals[0]] });
  const shipped = withShippedAnchoring(stored, { state: "PENDING", anchoredAtUtc: null });
  assert.equal(otsRowOf(shipped).otsState, "PENDING");
});

test("dead-letter sinks: retained history is not backlog; only unresolved entries need attention", () => {
  assert.equal(isDeadLetterQueue("report-dlq"), true);
  assert.equal(isDeadLetterQueue("report.dlq"), true);
  assert.equal(isDeadLetterQueue("media-intelligence-dlq"), true);
  assert.equal(isDeadLetterQueue("report"), false);

  const now = Date.parse("2026-10-13T12:00:00Z");
  const old = now - DEAD_LETTER_NEW_WINDOW_MS - 60_000;
  const s = summarizeDeadLetterEntries(
    [
      { addedAtMs: now - 60_000, resolution: "UNRESOLVED" },
      { addedAtMs: old, resolution: "UNRESOLVED" },
      { addedAtMs: old, resolution: "ACKNOWLEDGED" },
      ...Array.from({ length: 16 }, () => ({ addedAtMs: old, resolution: "RESOLVED" })),
    ],
    { nowMs: now, retained: 19 },
  );
  assert.deepEqual(s, {
    retained: 19,
    unresolvedNew: 1,
    unresolvedOlder: 1,
    acknowledged: 1,
    resolved: 16,
    oldestUnresolvedAgeSeconds: Math.floor((now - old) / 1000),
    truncated: false,
  });
  assert.equal(deadLetterNeedsAttention(s), true);

  // Production's 19 retained, all settled: no attention, no age.
  const settled = summarizeDeadLetterEntries(
    Array.from({ length: 19 }, () => ({ addedAtMs: old, resolution: "RESOLVED" })),
    { nowMs: now, retained: 19 },
  );
  assert.equal(deadLetterNeedsAttention(settled), false);
  assert.equal(settled.oldestUnresolvedAgeSeconds, null);
});

test("dead-letter resolution follows the canonical incident lifecycle", () => {
  assert.equal(deadLetterResolutionFromIncident("OPEN"), "UNRESOLVED");
  assert.equal(deadLetterResolutionFromIncident(null), "UNRESOLVED");
  assert.equal(deadLetterResolutionFromIncident("ACKNOWLEDGED"), "ACKNOWLEDGED");
  assert.equal(deadLetterResolutionFromIncident("RESOLVED"), "RESOLVED");
  assert.equal(deadLetterResolutionFromIncident("SUPPRESSED"), "RESOLVED");
});
