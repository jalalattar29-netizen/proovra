/** UC-EXT-005 / UC-EXT-008 — the popup's sentences claim only what is proven. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { CAPTURE_FAILED, CAPTURE_UNKNOWN, SESSION_ENDED, statusLine } from "./dist/status-copy.js";

const base = {
  attemptId: "a",
  tabId: 1,
  mode: "VIEWPORT",
  teamId: "t",
  caseId: null,
  step: null,
  detail: null,
  outcome: null,
  reason: null,
  denial: null,
  evidenceId: null,
  cancelRequested: false,
  startedAtMs: 0,
  updatedAtMs: 0,
};

test("an unknown outcome never says nothing was saved", () => {
  const l = statusLine({ ...base, state: "FAILED", outcome: "UNKNOWN", reason: "ERROR" });
  assert.equal(l.text, CAPTURE_UNKNOWN);
  assert.equal(/nothing was saved/i.test(l.text), false);
  assert.match(l.text, /Evidence library/);
});

test("a provable failure says nothing was saved", () => {
  const l = statusLine({ ...base, state: "FAILED", outcome: "NOTHING_SAVED", reason: "ERROR" });
  assert.equal(l.text, CAPTURE_FAILED);
});

test("an ended sign-in is a sign-in state (UC-EXT-008)", () => {
  const l = statusLine({ ...base, state: "FAILED", outcome: "NOTHING_SAVED", reason: "SIGNED_OUT" });
  assert.equal(l.text, SESSION_ENDED);
  assert.equal(l.signedOut, true);
});

test("a running capture shows its step, and a refusal its written copy", () => {
  assert.match(statusLine({ ...base, state: "RUNNING", step: "uploading", detail: "artifact 2/3" }).text, /^Uploading — artifact 2\/3/);
  assert.match(
    statusLine({ ...base, state: "FAILED", outcome: "NOTHING_SAVED", reason: "DENIED", denial: "STORAGE_LIMIT_REACHED" }).text,
    /storage limit/,
  );
});
