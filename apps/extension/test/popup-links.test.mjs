/**
 * Free audit F-27b / F-11b — a quota refusal offers the plans page instead of
 * "Try again"; a preserved record can be opened. Only the configured web
 * origin, only two fixed paths.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { followUpLink, retryOffered, safeWebOrigin, VIEW_PLANS_LABEL, OPEN_RECORD_LABEL } from "./dist/popup-links.js";

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
const WEB = "https://www.proovra.test/";

test("F-27b: a Free limit refusal links to /billing and does not offer Try again", () => {
  const s = { ...base, state: "FAILED", outcome: "NOTHING_SAVED", reason: "DENIED", denial: "FREE_LIMIT_REACHED" };
  assert.deepEqual(followUpLink(s, WEB), { label: VIEW_PLANS_LABEL, url: "https://www.proovra.test/billing" });
  assert.equal(retryOffered(s, true), false);
  for (const denial of ["EVIDENCE_RECORD_LIMIT_REACHED", "INSUFFICIENT_EVIDENCE_CREDITS", "STORAGE_LIMIT_REACHED", "ENTITLEMENT_REQUIRED"]) {
    assert.equal(followUpLink({ ...s, denial }, WEB)?.url, "https://www.proovra.test/billing", denial);
  }
});

test("F-27b: a rate limit or a fault keeps Try again and has no plans link", () => {
  const rate = { ...base, state: "FAILED", outcome: "NOTHING_SAVED", reason: "DENIED", denial: "RATE_LIMITED" };
  assert.equal(followUpLink(rate, WEB), null);
  assert.equal(retryOffered(rate, true), true);
  const fault = { ...base, state: "FAILED", outcome: "NOTHING_SAVED", reason: "ERROR" };
  assert.equal(retryOffered(fault, true), true);
  assert.equal(retryOffered({ ...fault, reason: "SIGNED_OUT" }, true), false);
  assert.equal(retryOffered(fault, false), false);
});

test("F-11b: a success links to the record by its path-encoded id", () => {
  const s = { ...base, state: "SUCCEEDED", evidenceId: "ev/1?x" };
  assert.deepEqual(followUpLink(s, WEB), { label: OPEN_RECORD_LABEL, url: "https://www.proovra.test/evidence/ev%2F1%3Fx" });
  assert.equal(followUpLink({ ...s, evidenceId: null }, WEB), null);
});

test("no configured (or a non-http) web origin shows no link", () => {
  const s = { ...base, state: "SUCCEEDED", evidenceId: "ev-1" };
  assert.equal(followUpLink(s, ""), null);
  assert.equal(followUpLink(s, "javascript:alert(1)"), null);
  assert.equal(safeWebOrigin("https://www.proovra.test/some/path"), "https://www.proovra.test");
});
