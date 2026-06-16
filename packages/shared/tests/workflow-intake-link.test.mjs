import test from "node:test";
import assert from "node:assert/strict";

import {
  WORKFLOW_INTAKE_SESSION_STATUSES,
  WORKFLOW_INTAKE_TOKEN_VERSION,
  WORKFLOW_INTAKE_TOKEN_RANDOM_BYTES,
  WorkflowIntakeConsentSnapshotSchema,
  canTransitionWorkflowIntakeSession,
  formatWorkflowIntakeTokenWireValue,
  isAnonymousWorkflowIntakeMode,
  isTerminalWorkflowIntakeSessionStatus,
  parseWorkflowIntakeTokenShape,
  WORKFLOW_INTAKE_MODES,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Intake modes
// -----------------------------------------------------------------------------

test("intake modes now include the four external variants", () => {
  for (const mode of [
    "EXTERNAL_ONE_TIME",
    "EXTERNAL_REUSABLE",
    "EXTERNAL_ANONYMOUS",
    "EXTERNAL_PSEUDONYMOUS",
  ]) {
    assert.ok(
      WORKFLOW_INTAKE_MODES.includes(mode),
      `expected intake mode ${mode} to be defined`,
    );
  }
});

test("isAnonymousWorkflowIntakeMode flags only anonymous + pseudonymous", () => {
  assert.equal(isAnonymousWorkflowIntakeMode("EXTERNAL_ANONYMOUS"), true);
  assert.equal(isAnonymousWorkflowIntakeMode("EXTERNAL_PSEUDONYMOUS"), true);
  assert.equal(isAnonymousWorkflowIntakeMode("EXTERNAL_ONE_TIME"), false);
  assert.equal(isAnonymousWorkflowIntakeMode("EXTERNAL_REUSABLE"), false);
  assert.equal(isAnonymousWorkflowIntakeMode("AUTHENTICATED_STANDARD"), false);
  assert.equal(isAnonymousWorkflowIntakeMode(null), false);
});

// -----------------------------------------------------------------------------
// Token wire format
// -----------------------------------------------------------------------------

test("formatWorkflowIntakeTokenWireValue uses the canonical prefix and version", () => {
  const wire = formatWorkflowIntakeTokenWireValue("abcdefghijklmnopqrstuv");
  assert.equal(wire, `pwi_v${WORKFLOW_INTAKE_TOKEN_VERSION}_abcdefghijklmnopqrstuv`);
});

test("parseWorkflowIntakeTokenShape accepts a valid token", () => {
  const wire = formatWorkflowIntakeTokenWireValue("abcdefghijklmnopqrstuv");
  const shape = parseWorkflowIntakeTokenShape(wire);
  assert.ok(shape);
  assert.equal(shape.version, 1);
  assert.equal(shape.body, "abcdefghijklmnopqrstuv");
});

test("parseWorkflowIntakeTokenShape rejects malformed tokens", () => {
  assert.equal(parseWorkflowIntakeTokenShape(""), null);
  assert.equal(parseWorkflowIntakeTokenShape("nopfx_v1_xxxxxxxxxxxxxxxxxxxx"), null);
  assert.equal(parseWorkflowIntakeTokenShape("pwi_v1_short"), null);
  assert.equal(parseWorkflowIntakeTokenShape("pwi_v0_xxxxxxxxxxxxxxxxxxxxxxxx"), null);
  assert.equal(parseWorkflowIntakeTokenShape(null), null);
  assert.equal(parseWorkflowIntakeTokenShape(42), null);
});

test("WORKFLOW_INTAKE_TOKEN_RANDOM_BYTES is sized for 256-bit entropy", () => {
  assert.equal(WORKFLOW_INTAKE_TOKEN_RANDOM_BYTES, 32);
});

// -----------------------------------------------------------------------------
// Session lifecycle state machine
// -----------------------------------------------------------------------------

test("session statuses cover the eight canonical states", () => {
  const expected = [
    "ABANDONED",
    "CREATED",
    "EXPIRED",
    "OPENED",
    "REVOKED",
    "SUBMITTED",
    "UPLOAD_COMPLETED",
    "UPLOAD_STARTED",
  ];
  assert.deepEqual([...WORKFLOW_INTAKE_SESSION_STATUSES].sort(), expected);
});

test("isTerminalWorkflowIntakeSessionStatus flags SUBMITTED / EXPIRED / REVOKED / ABANDONED", () => {
  for (const s of ["SUBMITTED", "EXPIRED", "REVOKED", "ABANDONED"]) {
    assert.equal(isTerminalWorkflowIntakeSessionStatus(s), true, s);
  }
  for (const s of [
    "CREATED",
    "OPENED",
    "UPLOAD_STARTED",
    "UPLOAD_COMPLETED",
  ]) {
    assert.equal(isTerminalWorkflowIntakeSessionStatus(s), false, s);
  }
});

test("happy-path transitions are allowed", () => {
  const happyPath = [
    ["CREATED", "OPENED"],
    ["OPENED", "UPLOAD_STARTED"],
    ["UPLOAD_STARTED", "UPLOAD_COMPLETED"],
    ["UPLOAD_COMPLETED", "SUBMITTED"],
  ];
  for (const [from, to] of happyPath) {
    const r = canTransitionWorkflowIntakeSession(from, to);
    assert.equal(r.ok, true, `expected ${from} -> ${to} to be allowed`);
  }
});

test("OPENED can directly submit a zero-file session", () => {
  const r = canTransitionWorkflowIntakeSession("OPENED", "SUBMITTED");
  assert.equal(r.ok, true);
});

test("UPLOAD_STARTED can submit directly — public flow never visits UPLOAD_COMPLETED (regression: prod 409 0500d474-…)", () => {
  // Forensic P0 bugfix. The contributor flow goes:
  //   open link → "Add files" (bumps OPENED → UPLOAD_STARTED) →
  //   PUT to S3 → "Submit Evidence"
  // Nothing in that flow sets UPLOAD_COMPLETED, so submit MUST be
  // allowed straight from UPLOAD_STARTED. Without this, every
  // upload-then-submit returned 409 transition_not_allowed.
  const r = canTransitionWorkflowIntakeSession("UPLOAD_STARTED", "SUBMITTED");
  assert.equal(
    r.ok,
    true,
    "UPLOAD_STARTED -> SUBMITTED must be allowed; the public flow doesn't visit UPLOAD_COMPLETED",
  );
});

test("submitting from a true terminal state is still rejected (state machine invariant intact)", () => {
  // Sanity check — broadening UPLOAD_STARTED's allowed list must
  // NOT let terminal states submit.
  for (const from of ["SUBMITTED", "EXPIRED", "REVOKED", "ABANDONED"]) {
    const r = canTransitionWorkflowIntakeSession(from, "SUBMITTED");
    assert.equal(r.ok, false, `${from} -> SUBMITTED must remain disallowed`);
  }
});

test("EXPIRED and REVOKED are reachable from every non-terminal state", () => {
  for (const from of [
    "CREATED",
    "OPENED",
    "UPLOAD_STARTED",
    "UPLOAD_COMPLETED",
  ]) {
    for (const to of ["EXPIRED", "REVOKED"]) {
      const r = canTransitionWorkflowIntakeSession(from, to);
      assert.equal(r.ok, true, `${from} -> ${to}`);
    }
  }
});

test("ABANDONED is reachable from OPENED / UPLOAD_STARTED / UPLOAD_COMPLETED only", () => {
  for (const from of ["OPENED", "UPLOAD_STARTED", "UPLOAD_COMPLETED"]) {
    assert.equal(canTransitionWorkflowIntakeSession(from, "ABANDONED").ok, true);
  }
  // CREATED -> ABANDONED is disallowed (nothing was opened).
  assert.equal(
    canTransitionWorkflowIntakeSession("CREATED", "ABANDONED").ok,
    false,
  );
});

test("transitions out of terminal states are rejected", () => {
  for (const from of ["SUBMITTED", "EXPIRED", "REVOKED", "ABANDONED"]) {
    for (const to of [
      "OPENED",
      "UPLOAD_STARTED",
      "UPLOAD_COMPLETED",
      "SUBMITTED",
    ]) {
      const r = canTransitionWorkflowIntakeSession(from, to);
      assert.equal(r.ok, false, `${from} -> ${to} must be rejected`);
      assert.equal(r.reason, "terminal_from_status");
    }
  }
});

test("backward transitions are rejected", () => {
  const backward = [
    ["OPENED", "CREATED"],
    ["UPLOAD_STARTED", "OPENED"],
    ["UPLOAD_COMPLETED", "UPLOAD_STARTED"],
  ];
  for (const [from, to] of backward) {
    const r = canTransitionWorkflowIntakeSession(from, to);
    assert.equal(r.ok, false, `${from} -> ${to} must be rejected`);
    assert.equal(r.reason, "transition_not_allowed");
  }
});

test("unknown from-statuses fail safely without throwing", () => {
  const r = canTransitionWorkflowIntakeSession("FAKE_STATUS", "OPENED");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown_from_status");
});

// -----------------------------------------------------------------------------
// Consent snapshot schema
// -----------------------------------------------------------------------------

const validConsent = {
  acceptedAtUtc: "2026-05-16T10:00:00.000Z",
  policyVersion: "2026-05-A",
  disclosureTextHash:
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  termsAcknowledged: true,
  identityDisclosed: false,
  ipHash:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  userAgent: "Mozilla/5.0",
};

test("consent snapshot accepts a well-formed payload", () => {
  const parsed = WorkflowIntakeConsentSnapshotSchema.safeParse(validConsent);
  assert.equal(parsed.success, true);
});

test("consent snapshot rejects a malformed disclosure hash", () => {
  const bad = { ...validConsent, disclosureTextHash: "not-hex" };
  const parsed = WorkflowIntakeConsentSnapshotSchema.safeParse(bad);
  assert.equal(parsed.success, false);
});

test("consent snapshot allows null ipHash and userAgent", () => {
  const parsed = WorkflowIntakeConsentSnapshotSchema.safeParse({
    ...validConsent,
    ipHash: null,
    userAgent: null,
  });
  assert.equal(parsed.success, true);
});

test("consent snapshot rejects missing required fields", () => {
  const missing = { ...validConsent };
  delete missing.policyVersion;
  const parsed = WorkflowIntakeConsentSnapshotSchema.safeParse(missing);
  assert.equal(parsed.success, false);
});

test("consent snapshot rejects non-datetime acceptedAtUtc", () => {
  const bad = { ...validConsent, acceptedAtUtc: "yesterday" };
  const parsed = WorkflowIntakeConsentSnapshotSchema.safeParse(bad);
  assert.equal(parsed.success, false);
});
