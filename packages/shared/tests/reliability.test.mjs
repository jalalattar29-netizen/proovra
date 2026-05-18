import test from "node:test";
import assert from "node:assert/strict";

// Phase 12 — Reliability shared-type contract tests.
//
// Coverage:
//   - upload session status catalog
//   - terminal status set
//   - transition matrix (positive + negative cases)
//   - size / threshold defaults exist
//   - reliability event types live in SECURITY_EVENT_TYPES

import {
  DEFAULT_MAX_UPLOAD_FILE_SIZE_BYTES,
  DEFAULT_MULTIPART_PART_SIZE_BYTES,
  DEFAULT_MULTIPART_THRESHOLD_BYTES,
  DEFAULT_UPLOAD_ABANDONED_HOURS,
  DEFAULT_UPLOAD_STALLED_MINUTES,
  MULTIPART_PART_SIZE_MAX_BYTES,
  MULTIPART_PART_SIZE_MIN_BYTES,
  SECURITY_EVENT_TYPES,
  UPLOAD_SESSION_STATUSES,
  UPLOAD_SESSION_TERMINAL_STATUSES,
  isAllowedUploadSessionTransition,
  isTerminalUploadSessionStatus,
  listAllowedUploadSessionTransitions,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Catalog
// -----------------------------------------------------------------------------

test("UPLOAD_SESSION_STATUSES has the ten canonical states", () => {
  assert.deepEqual([...UPLOAD_SESSION_STATUSES].sort(), [
    "ABANDONED",
    "COMPLETED",
    "CREATED",
    "FAILED",
    "PARTIAL",
    "PRESIGNED",
    "REVIEW_REQUIRED",
    "STALLED",
    "UPLOADING",
    "VERIFYING",
  ]);
});

test("UPLOAD_SESSION_TERMINAL_STATUSES is COMPLETED/FAILED/ABANDONED", () => {
  assert.deepEqual([...UPLOAD_SESSION_TERMINAL_STATUSES].sort(), [
    "ABANDONED",
    "COMPLETED",
    "FAILED",
  ]);
});

test("STALLED and REVIEW_REQUIRED are NOT terminal", () => {
  assert.equal(isTerminalUploadSessionStatus("STALLED"), false);
  assert.equal(isTerminalUploadSessionStatus("REVIEW_REQUIRED"), false);
});

// -----------------------------------------------------------------------------
// Transition matrix
// -----------------------------------------------------------------------------

test("CREATED → PRESIGNED is allowed; CREATED → COMPLETED is NOT", () => {
  assert.equal(isAllowedUploadSessionTransition("CREATED", "PRESIGNED"), true);
  assert.equal(isAllowedUploadSessionTransition("CREATED", "COMPLETED"), false);
});

test("VERIFYING is the only on-ramp to COMPLETED", () => {
  for (const from of UPLOAD_SESSION_STATUSES) {
    // Self-transitions are intentional no-op heartbeats; skip COMPLETED.
    if (from === "VERIFYING" || from === "COMPLETED") continue;
    assert.equal(
      isAllowedUploadSessionTransition(from, "COMPLETED"),
      false,
      `unexpectedly allowed: ${from} -> COMPLETED`,
    );
  }
  assert.equal(isAllowedUploadSessionTransition("VERIFYING", "COMPLETED"), true);
});

test("STALLED is recoverable: STALLED → UPLOADING is allowed", () => {
  assert.equal(isAllowedUploadSessionTransition("STALLED", "UPLOADING"), true);
});

test("COMPLETED is terminal: no outgoing transitions (besides self-noop)", () => {
  for (const to of UPLOAD_SESSION_STATUSES) {
    if (to === "COMPLETED") continue;
    assert.equal(
      isAllowedUploadSessionTransition("COMPLETED", to),
      false,
      `unexpectedly allowed: COMPLETED -> ${to}`,
    );
  }
});

test("ABANDONED is terminal: no outgoing transitions (besides self-noop)", () => {
  for (const to of UPLOAD_SESSION_STATUSES) {
    if (to === "ABANDONED") continue;
    assert.equal(
      isAllowedUploadSessionTransition("ABANDONED", to),
      false,
      `unexpectedly allowed: ABANDONED -> ${to}`,
    );
  }
});

test("REVIEW_REQUIRED can roll forward to ABANDONED or recover to UPLOADING/VERIFYING", () => {
  assert.equal(
    isAllowedUploadSessionTransition("REVIEW_REQUIRED", "ABANDONED"),
    true,
  );
  assert.equal(
    isAllowedUploadSessionTransition("REVIEW_REQUIRED", "UPLOADING"),
    true,
  );
  assert.equal(
    isAllowedUploadSessionTransition("REVIEW_REQUIRED", "VERIFYING"),
    true,
  );
});

test("self-transitions are allowed (heartbeats are no-ops)", () => {
  assert.equal(
    isAllowedUploadSessionTransition("UPLOADING", "UPLOADING"),
    true,
  );
});

test("listAllowedUploadSessionTransitions surfaces the matrix", () => {
  const fromUploading = listAllowedUploadSessionTransitions("UPLOADING");
  assert.ok(fromUploading.includes("VERIFYING"));
  assert.ok(fromUploading.includes("STALLED"));
  assert.ok(!fromUploading.includes("COMPLETED"));
});

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

test("size + threshold defaults exist and are reasonable", () => {
  assert.equal(typeof DEFAULT_MAX_UPLOAD_FILE_SIZE_BYTES, "number");
  assert.ok(DEFAULT_MAX_UPLOAD_FILE_SIZE_BYTES > 1024 * 1024);
  assert.equal(typeof DEFAULT_MULTIPART_THRESHOLD_BYTES, "number");
  assert.ok(DEFAULT_MULTIPART_THRESHOLD_BYTES >= MULTIPART_PART_SIZE_MIN_BYTES);
  assert.equal(typeof DEFAULT_MULTIPART_PART_SIZE_BYTES, "number");
  assert.ok(DEFAULT_MULTIPART_PART_SIZE_BYTES >= MULTIPART_PART_SIZE_MIN_BYTES);
  assert.ok(DEFAULT_MULTIPART_PART_SIZE_BYTES <= MULTIPART_PART_SIZE_MAX_BYTES);
  assert.equal(typeof DEFAULT_UPLOAD_STALLED_MINUTES, "number");
  assert.ok(DEFAULT_UPLOAD_STALLED_MINUTES >= 5);
  assert.equal(typeof DEFAULT_UPLOAD_ABANDONED_HOURS, "number");
  assert.ok(DEFAULT_UPLOAD_ABANDONED_HOURS >= 1);
});

// -----------------------------------------------------------------------------
// Reliability event types are present in the security catalog
// -----------------------------------------------------------------------------

test("reliability event types live in SECURITY_EVENT_TYPES", () => {
  for (const t of [
    "upload_stalled",
    "upload_resumed",
    "upload_abandoned",
    "finalize_duplicate_detected",
    "reconciliation_triggered",
    "orphaned_upload_detected",
    "multipart_inconsistency_detected",
    "recovery_review_required",
  ]) {
    assert.ok(
      SECURITY_EVENT_TYPES.includes(t),
      `expected ${t} in SECURITY_EVENT_TYPES`,
    );
  }
});
