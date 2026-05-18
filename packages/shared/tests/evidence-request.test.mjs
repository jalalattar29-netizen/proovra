import test from "node:test";
import assert from "node:assert/strict";

import {
  EVIDENCE_REQUEST_STATUSES,
  EVIDENCE_REQUEST_PRIORITIES,
  EVIDENCE_REQUEST_RECIPIENT_MODES,
  EVIDENCE_REQUEST_STATUS_LABEL,
  EvidenceRequestInputSchema,
  canTransitionEvidenceRequest,
  isExternalRecipientMode,
  isTerminalEvidenceRequestStatus,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Enum coverage
// -----------------------------------------------------------------------------

test("evidence-request statuses cover the documented 12-state lifecycle", () => {
  const expected = [
    "CANCELLED",
    "CLOSED",
    "DRAFT",
    "FULFILLED",
    "IN_PROGRESS",
    "NEEDS_MORE_INFO",
    "OPEN",
    "PARTIALLY_FULFILLED",
    "RESPONSE_RECEIVED",
    "SENT",
    "UNDER_REVIEW",
    "VIEWED",
  ];
  assert.deepEqual([...EVIDENCE_REQUEST_STATUSES].sort(), expected);
});

test("every status has a legally-safe label", () => {
  for (const status of EVIDENCE_REQUEST_STATUSES) {
    const label = EVIDENCE_REQUEST_STATUS_LABEL[status];
    assert.ok(typeof label === "string" && label.length > 0, status);
    // Forbidden truth-claim wording.
    const lower = label.toLowerCase();
    for (const banned of ["authentic", "admissible", "proven", "verified true"]) {
      assert.ok(!lower.includes(banned), `${status}: ${label}`);
    }
  }
});

test("priorities are LOW / NORMAL / HIGH / URGENT", () => {
  assert.deepEqual([...EVIDENCE_REQUEST_PRIORITIES], ["LOW", "NORMAL", "HIGH", "URGENT"]);
});

test("recipient modes include the four canonical values", () => {
  assert.deepEqual([...EVIDENCE_REQUEST_RECIPIENT_MODES].sort(), [
    "ANONYMOUS_SOURCE",
    "EXTERNAL_CONTRIBUTOR",
    "INTERNAL_USER",
    "PSEUDONYMOUS_SOURCE",
  ]);
});

// -----------------------------------------------------------------------------
// Predicates
// -----------------------------------------------------------------------------

test("isTerminalEvidenceRequestStatus flags CANCELLED + CLOSED only", () => {
  for (const s of ["CANCELLED", "CLOSED"]) {
    assert.equal(isTerminalEvidenceRequestStatus(s), true);
  }
  for (const s of ["DRAFT", "OPEN", "SENT", "RESPONSE_RECEIVED", "FULFILLED"]) {
    assert.equal(isTerminalEvidenceRequestStatus(s), false, s);
  }
});

test("isExternalRecipientMode flags the three external modes", () => {
  assert.equal(isExternalRecipientMode("EXTERNAL_CONTRIBUTOR"), true);
  assert.equal(isExternalRecipientMode("ANONYMOUS_SOURCE"), true);
  assert.equal(isExternalRecipientMode("PSEUDONYMOUS_SOURCE"), true);
  assert.equal(isExternalRecipientMode("INTERNAL_USER"), false);
});

// -----------------------------------------------------------------------------
// State machine
// -----------------------------------------------------------------------------

test("happy-path forward transitions are allowed", () => {
  const happy = [
    ["DRAFT", "OPEN"],
    ["OPEN", "SENT"],
    ["SENT", "VIEWED"],
    ["VIEWED", "IN_PROGRESS"],
    ["IN_PROGRESS", "RESPONSE_RECEIVED"],
    ["RESPONSE_RECEIVED", "UNDER_REVIEW"],
    ["UNDER_REVIEW", "FULFILLED"],
  ];
  for (const [from, to] of happy) {
    const r = canTransitionEvidenceRequest(from, to);
    assert.equal(r.ok, true, `${from} -> ${to}`);
  }
});

test("CANCELLED is reachable from any non-terminal state", () => {
  for (const from of [
    "DRAFT",
    "OPEN",
    "SENT",
    "VIEWED",
    "IN_PROGRESS",
    "RESPONSE_RECEIVED",
    "UNDER_REVIEW",
    "PARTIALLY_FULFILLED",
    "FULFILLED",
    "NEEDS_MORE_INFO",
  ]) {
    const r = canTransitionEvidenceRequest(from, "CANCELLED");
    assert.equal(r.ok, true, from);
  }
});

test("transitions out of CANCELLED / CLOSED are rejected", () => {
  for (const from of ["CANCELLED", "CLOSED"]) {
    for (const to of EVIDENCE_REQUEST_STATUSES) {
      const r = canTransitionEvidenceRequest(from, to);
      assert.equal(r.ok, false, `${from} -> ${to}`);
      assert.equal(r.reason, "terminal_from_status");
    }
  }
});

test("backward transitions are rejected", () => {
  const backward = [
    ["OPEN", "DRAFT"],
    ["SENT", "OPEN"],
    ["RESPONSE_RECEIVED", "VIEWED"],
    ["FULFILLED", "RESPONSE_RECEIVED"],
  ];
  for (const [from, to] of backward) {
    const r = canTransitionEvidenceRequest(from, to);
    assert.equal(r.ok, false, `${from} -> ${to}`);
    assert.equal(r.reason, "transition_not_allowed");
  }
});

test("NEEDS_MORE_INFO can re-enter RESPONSE_RECEIVED for a follow-up submission", () => {
  const r = canTransitionEvidenceRequest("NEEDS_MORE_INFO", "RESPONSE_RECEIVED");
  assert.equal(r.ok, true);
});

test("PARTIALLY_FULFILLED can advance to FULFILLED", () => {
  const r = canTransitionEvidenceRequest("PARTIALLY_FULFILLED", "FULFILLED");
  assert.equal(r.ok, true);
});

test("RESPONSE_RECEIVED can short-circuit to FULFILLED when all deliverables are satisfied", () => {
  const r = canTransitionEvidenceRequest("RESPONSE_RECEIVED", "FULFILLED");
  assert.equal(r.ok, true);
});

test("unknown from-status fails safely", () => {
  const r = canTransitionEvidenceRequest("NOT_A_REAL_STATUS", "OPEN");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown_from_status");
});

// -----------------------------------------------------------------------------
// Schema validation
// -----------------------------------------------------------------------------

const TEAM_ID = "550e8400-e29b-41d4-a716-446655440000";

test("EvidenceRequestInputSchema accepts a minimal valid payload", () => {
  const r = EvidenceRequestInputSchema.safeParse({
    teamId: TEAM_ID,
    requestType: "ADDITIONAL_EVIDENCE",
    title: "Need close-up of damage",
    recipientMode: "EXTERNAL_CONTRIBUTOR",
  });
  assert.equal(r.success, true);
});

test("EvidenceRequestInputSchema validates deliverables", () => {
  const r = EvidenceRequestInputSchema.safeParse({
    teamId: TEAM_ID,
    requestType: "ADDITIONAL_EVIDENCE",
    title: "Need close-up of damage",
    recipientMode: "EXTERNAL_CONTRIBUTOR",
    deliverables: [
      {
        title: "Close-up photo of bumper",
        acceptedKinds: ["PHOTO"],
      },
    ],
  });
  assert.equal(r.success, true);
});

test("EvidenceRequestInputSchema rejects unknown recipient mode", () => {
  const r = EvidenceRequestInputSchema.safeParse({
    teamId: TEAM_ID,
    requestType: "ADDITIONAL_EVIDENCE",
    title: "T",
    recipientMode: "WEAPONIZED_PIGEON",
  });
  assert.equal(r.success, false);
});

test("EvidenceRequestInputSchema rejects empty title", () => {
  const r = EvidenceRequestInputSchema.safeParse({
    teamId: TEAM_ID,
    requestType: "ADDITIONAL_EVIDENCE",
    title: "",
    recipientMode: "EXTERNAL_CONTRIBUTOR",
  });
  assert.equal(r.success, false);
});

test("EvidenceRequestInputSchema rejects deliverable with no acceptedKinds", () => {
  const r = EvidenceRequestInputSchema.safeParse({
    teamId: TEAM_ID,
    requestType: "ADDITIONAL_EVIDENCE",
    title: "T",
    recipientMode: "EXTERNAL_CONTRIBUTOR",
    deliverables: [{ title: "T", acceptedKinds: [] }],
  });
  assert.equal(r.success, false);
});
