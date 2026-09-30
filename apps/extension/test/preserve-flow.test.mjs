/**
 * UC-ARCH-009 / UC-EXT-005 / UC-EXT-008 / UC-EXT-010 — the capture
 * orchestration's outcome is FACTUAL about the user's work.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError, NetworkError } from "./dist/api-client.js";
import { runPreserveFlow } from "./dist/preserve-flow.js";

const HEX = "a".repeat(64);
const REQ = { mode: "VIEWPORT", teamId: "t1", caseId: null, tabId: 1, windowId: 1, evidenceType: "PHOTO" };

function capture() {
  return {
    artifacts: [
      { role: "viewport_screenshot", blob: new Blob(["png"], { type: "image/png" }), mediaType: "image/png", sha256: HEX },
    ],
    pageInfo: { url: "https://example.com/", title: "Example", viewportW: 1280, viewportH: 800, devicePixelRatio: 1 },
    pageMutatedDuringCapture: false,
    limitations: [],
    domSnapshotMissing: true,
    notes: [],
  };
}

function harness(overrides = {}) {
  const calls = [];
  const api = {
    openWebSession: async (_t, teamId, caseId) => {
      calls.push(["open", teamId, caseId]);
      return { session: { captureSessionId: "11111111-1111-4111-8111-111111111111", expiresAtUtc: "" } };
    },
    reserveEvidence: async () => {
      calls.push(["reserve"]);
      return { evidence: { evidenceId: "ev-1" } };
    },
    createPart: async (_t, _e, input) => {
      calls.push(["part", input.partIndex]);
      return { upload: { bucket: "b", key: "k", putUrl: "http://s3.local/put" } };
    },
    putBytes: async () => {
      calls.push(["put"]);
    },
    declarePart: async () => {
      calls.push(["declare"]);
    },
    webComplete: async () => {
      calls.push(["seal"]);
      return { result: { evidenceId: "ev-1", bound: true, manifestPartIndex: 1 } };
    },
    discardSession: async () => {
      calls.push(["discard"]);
      return { result: { discarded: true } };
    },
    ...overrides,
  };
  let cleared = false;
  const deps = {
    api,
    getToken: async () => "tok",
    clearToken: async () => {
      cleared = true;
    },
    prepare: async () => undefined,
    capture: async () => capture(),
    sha256Hex: async () => HEX,
    progress: () => undefined,
    browser: { name: "Chrome", versionBucket: "153", os: "Windows" },
    extensionVersion: "test",
  };
  return { deps, calls, wasCleared: () => cleared };
}

test("success seals and reports the evidence id; a missing DOM makes the record PARTIAL", async () => {
  const h = harness();
  const r = await runPreserveFlow(h.deps, REQ, new AbortController().signal);
  assert.equal(r.status, "SUCCEEDED");
  assert.equal(r.evidenceId, "ev-1");
  assert.equal(r.completeness, "PARTIAL");
  assert.equal(h.calls.some((c) => c[0] === "discard"), false);
});

test("UC-ARCH-009: a failing upload discards the opened session", async () => {
  const h = harness({
    putBytes: async () => {
      throw new ApiError(403, null, "PUT object -> 403");
    },
  });
  const r = await runPreserveFlow(h.deps, REQ, new AbortController().signal);
  assert.equal(r.status, "FAILED");
  assert.equal(r.outcome, "NOTHING_SAVED");
  assert.ok(h.calls.some((c) => c[0] === "discard"), "the reserved record is released, not left for the reaper");
});

test("UC-EXT-005: a seal with no answer is UNKNOWN when the discard cannot settle it", async () => {
  const h = harness({
    webComplete: async () => {
      throw new NetworkError("POST /web-complete failed: TimeoutError");
    },
    discardSession: async () => {
      throw new NetworkError("POST /discard failed: TypeError");
    },
  });
  const r = await runPreserveFlow(h.deps, REQ, new AbortController().signal);
  assert.equal(r.status, "FAILED");
  assert.equal(r.outcome, "UNKNOWN");
  assert.equal(r.evidenceId, "ev-1");
});

test("a seal with no answer that the discard finds SEALED is reported as saved", async () => {
  const h = harness({
    webComplete: async () => {
      throw new NetworkError("timeout");
    },
    discardSession: async () => {
      throw new ApiError(409, "EVIDENCE_ALREADY_FINALIZED", "POST discard -> 409");
    },
  });
  const r = await runPreserveFlow(h.deps, REQ, new AbortController().signal);
  assert.equal(r.status, "SUCCEEDED");
  assert.equal(r.evidenceId, "ev-1");
});

test("a seal with no answer that the discard releases is NOTHING_SAVED", async () => {
  const h = harness({
    webComplete: async () => {
      throw new ApiError(502, null, "POST web-complete -> 502");
    },
  });
  const r = await runPreserveFlow(h.deps, REQ, new AbortController().signal);
  assert.equal(r.outcome, "NOTHING_SAVED");
});

test("UC-EXT-008: a 401 mid-capture is SIGNED_OUT and clears the token", async () => {
  const h = harness({
    reserveEvidence: async () => {
      throw new ApiError(401, null, "POST evidence -> 401");
    },
  });
  const r = await runPreserveFlow(h.deps, REQ, new AbortController().signal);
  assert.equal(r.reason, "SIGNED_OUT");
  assert.equal(r.outcome, "NOTHING_SAVED");
  assert.equal(h.wasCleared(), true);
});

test("no stored token is SIGNED_OUT before anything is captured", async () => {
  const h = harness();
  h.deps.getToken = async () => null;
  const r = await runPreserveFlow(h.deps, REQ, new AbortController().signal);
  assert.equal(r.reason, "SIGNED_OUT");
  assert.equal(h.calls.length, 0);
});

test("cancel after the session opened discards it", async () => {
  const ac = new AbortController();
  const h = harness({
    reserveEvidence: async () => {
      ac.abort();
      return { evidence: { evidenceId: "ev-2" } };
    },
  });
  const r = await runPreserveFlow(h.deps, REQ, ac.signal);
  assert.equal(r.reason, "CANCELLED");
  assert.equal(r.outcome, "NOTHING_SAVED");
  assert.ok(h.calls.some((c) => c[0] === "discard"));
});

test("UC-EXT-010: the chosen case is sent on session open; no case sends none", async () => {
  const h = harness();
  await runPreserveFlow(h.deps, { ...REQ, caseId: "case-1" }, new AbortController().signal);
  assert.deepEqual(h.calls[0], ["open", "t1", "case-1"]);
  const h2 = harness();
  await runPreserveFlow(h2.deps, REQ, new AbortController().signal);
  assert.deepEqual(h2.calls[0], ["open", "t1", null]);
});

test("a server refusal keeps its bounded denial code", async () => {
  const h = harness({
    openWebSession: async () => {
      throw new ApiError(402, "EVIDENCE_RECORD_LIMIT_REACHED", "POST -> 402");
    },
  });
  const r = await runPreserveFlow(h.deps, REQ, new AbortController().signal);
  assert.equal(r.reason, "DENIED");
  assert.equal(r.denial, "EVIDENCE_RECORD_LIMIT_REACHED");
  assert.equal(r.outcome, "NOTHING_SAVED");
});
