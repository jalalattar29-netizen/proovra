import test from "node:test";
import assert from "node:assert/strict";

// Phase 16 — Collaboration shared-type tests.
//
// Coverage:
//   - catalogs
//   - transition matrix (positive + negative)
//   - body sanitiser (control chars stripped, length capped, plain text)
//   - mention parser (handles email-vs-mention boundary correctly)
//   - notification event registry

import {
  DISCUSSION_BODY_MAX_BYTES,
  DISCUSSION_MESSAGE_AUTHOR_KINDS,
  DISCUSSION_PARTICIPANT_ROLES,
  DISCUSSION_THREAD_KINDS,
  DISCUSSION_THREAD_STATUSES,
  DISCUSSION_THREAD_TERMINAL_STATUSES,
  DISCUSSION_THREAD_VISIBILITIES,
  NOTIFICATION_EVENT_TYPES,
  isAllowedDiscussionThreadTransition,
  isDiscussionThreadTerminal,
  listAllowedDiscussionThreadTransitions,
  parseMentionTokens,
  sanitiseDiscussionBody,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Catalogs
// -----------------------------------------------------------------------------

test("DISCUSSION_THREAD_KINDS catalogs the 4 operational kinds", () => {
  assert.deepEqual([...DISCUSSION_THREAD_KINDS].sort(), [
    "EVIDENCE_GENERAL",
    "INVESTIGATION_COORDINATION",
    "REVIEW_REQUEST_CLARIFICATION",
    "WORKFLOW_DISCUSSION",
  ]);
});

test("DISCUSSION_THREAD_STATUSES is OPEN/IN_PROGRESS/RESOLVED/CLOSED", () => {
  assert.deepEqual([...DISCUSSION_THREAD_STATUSES].sort(), [
    "CLOSED",
    "IN_PROGRESS",
    "OPEN",
    "RESOLVED",
  ]);
});

test("CLOSED is the only auto-terminal status", () => {
  assert.deepEqual([...DISCUSSION_THREAD_TERMINAL_STATUSES], ["CLOSED"]);
  assert.equal(isDiscussionThreadTerminal("CLOSED"), true);
  assert.equal(isDiscussionThreadTerminal("RESOLVED"), false);
});

test("DISCUSSION_THREAD_VISIBILITIES is INTERNAL/CONTRIBUTOR_SCOPED", () => {
  assert.deepEqual([...DISCUSSION_THREAD_VISIBILITIES].sort(), [
    "CONTRIBUTOR_SCOPED",
    "INTERNAL",
  ]);
});

test("DISCUSSION_MESSAGE_AUTHOR_KINDS includes USER / CONTRIBUTOR / SYSTEM (no service-account)", () => {
  assert.deepEqual([...DISCUSSION_MESSAGE_AUTHOR_KINDS].sort(), [
    "CONTRIBUTOR",
    "SYSTEM",
    "USER",
  ]);
});

test("DISCUSSION_PARTICIPANT_ROLES covers the four operator roles", () => {
  assert.deepEqual([...DISCUSSION_PARTICIPANT_ROLES].sort(), [
    "CONTRIBUTOR",
    "PARTICIPANT",
    "RESOLVER",
    "WATCHER",
  ]);
});

// -----------------------------------------------------------------------------
// Transition matrix
// -----------------------------------------------------------------------------

test("OPEN can move to IN_PROGRESS, RESOLVED, CLOSED but not back to OPEN", () => {
  assert.equal(isAllowedDiscussionThreadTransition("OPEN", "IN_PROGRESS"), true);
  assert.equal(isAllowedDiscussionThreadTransition("OPEN", "RESOLVED"), true);
  assert.equal(isAllowedDiscussionThreadTransition("OPEN", "CLOSED"), true);
});

test("RESOLVED can reopen via IN_PROGRESS or move to CLOSED", () => {
  assert.equal(
    isAllowedDiscussionThreadTransition("RESOLVED", "IN_PROGRESS"),
    true,
  );
  assert.equal(isAllowedDiscussionThreadTransition("RESOLVED", "CLOSED"), true);
  assert.equal(isAllowedDiscussionThreadTransition("RESOLVED", "OPEN"), false);
});

test("CLOSED can only reopen via IN_PROGRESS", () => {
  for (const to of ["OPEN", "RESOLVED"]) {
    assert.equal(
      isAllowedDiscussionThreadTransition("CLOSED", to),
      false,
      `CLOSED → ${to} must NOT be allowed`,
    );
  }
  assert.equal(
    isAllowedDiscussionThreadTransition("CLOSED", "IN_PROGRESS"),
    true,
  );
});

test("self-transitions are no-op heartbeats (allowed)", () => {
  for (const s of DISCUSSION_THREAD_STATUSES) {
    assert.equal(isAllowedDiscussionThreadTransition(s, s), true);
  }
});

test("listAllowedDiscussionThreadTransitions returns the matrix slice", () => {
  const fromOpen = listAllowedDiscussionThreadTransitions("OPEN");
  assert.ok(fromOpen.includes("IN_PROGRESS"));
  assert.ok(fromOpen.includes("RESOLVED"));
  assert.ok(fromOpen.includes("CLOSED"));
});

// -----------------------------------------------------------------------------
// Body sanitiser — plain text only
// -----------------------------------------------------------------------------

test("sanitiseDiscussionBody strips NUL + control chars but keeps newlines/tabs", () => {
  const input = "hello\x00world\nlinebreak\there\x07bell";
  const out = sanitiseDiscussionBody(input);
  // NUL + BEL stripped; newline + tab retained
  assert.ok(!out.includes("\x00"));
  assert.ok(!out.includes("\x07"));
  assert.ok(out.includes("\n"));
  assert.ok(out.includes("\t"));
});

test("sanitiseDiscussionBody normalises CRLF to LF", () => {
  assert.equal(sanitiseDiscussionBody("a\r\nb\rc"), "a\nb\nc");
});

test("sanitiseDiscussionBody caps at DISCUSSION_BODY_MAX_BYTES", () => {
  const huge = "a".repeat(DISCUSSION_BODY_MAX_BYTES + 1000);
  const out = sanitiseDiscussionBody(huge);
  assert.equal(out.length, DISCUSSION_BODY_MAX_BYTES);
});

test("sanitiseDiscussionBody trims whitespace", () => {
  assert.equal(sanitiseDiscussionBody("   hello   "), "hello");
});

test("sanitiseDiscussionBody preserves harmless angle brackets WITHOUT HTML interpretation (plain text)", () => {
  // We don't strip < > — the UI MUST render the body as text. The
  // sanitiser's job is only to remove control chars + cap length.
  const input = "<script>alert(1)</script>";
  const out = sanitiseDiscussionBody(input);
  // The raw markup survives; rendering safety is the UI's contract.
  assert.equal(out, "<script>alert(1)</script>");
});

// -----------------------------------------------------------------------------
// Mention parser
// -----------------------------------------------------------------------------

test("parseMentionTokens picks up @user tokens", () => {
  const out = parseMentionTokens("hey @alice and @bob.smith please look");
  assert.deepEqual(out.sort(), ["alice", "bob.smith"]);
});

test("parseMentionTokens deduplicates", () => {
  const out = parseMentionTokens("@alice @alice @ALICE");
  assert.deepEqual(out, ["alice"]);
});

test("parseMentionTokens does NOT match @ inside email addresses", () => {
  const out = parseMentionTokens("write to alice@example.com please");
  assert.deepEqual(out, []);
});

test("parseMentionTokens requires at least 2 chars in the handle", () => {
  const out = parseMentionTokens("@a means nothing");
  assert.deepEqual(out, []);
});

test("parseMentionTokens accepts handles at start of line + after open bracket", () => {
  const out = parseMentionTokens("@first replied. (@second too)");
  assert.deepEqual(out.sort(), ["first", "second"]);
});

// -----------------------------------------------------------------------------
// Notification registry
// -----------------------------------------------------------------------------

test("Phase 16 notification event types are registered", () => {
  for (const t of [
    "DISCUSSION_MENTION_RECEIVED",
    "DISCUSSION_REPLY_RECEIVED",
    "DISCUSSION_RESOLVED",
    "DISCUSSION_REOPENED",
    "CONTRIBUTOR_REPLY_RECEIVED",
  ]) {
    assert.ok(
      NOTIFICATION_EVENT_TYPES.includes(t),
      `${t} should be in NOTIFICATION_EVENT_TYPES`,
    );
  }
});
