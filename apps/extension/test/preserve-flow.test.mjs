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
    openWebSession: async (_t, teamId, caseId, attemptId) => {
      calls.push(["open", teamId, caseId, attemptId]);
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
    attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    tabUrl: "https://example.com/",
    sleep: async () => undefined,
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
  assert.deepEqual(h.calls[0], ["open", "t1", "case-1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
  const h2 = harness();
  await runPreserveFlow(h2.deps, REQ, new AbortController().signal);
  assert.deepEqual(h2.calls[0], ["open", "t1", null, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
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

// ---------------------------------------------------------------------------
// AUD-026 — interrupted uploads resume; retries never mint a second capture.
// ---------------------------------------------------------------------------
const SID = "11111111-1111-4111-8111-111111111111";

/** A fake server with the REAL idempotency rules of the direct-capture routes. */
function idempotentServer({ dropFirstResponseOf = new Set(), offlineFor = {} } = {}) {
  const state = { sessions: new Map(), records: 0, puts: 0, declared: new Map(), sealed: false, opens: 0 };
  const flaky = (name) => {
    if ((offlineFor[name] ?? 0) > 0) {
      offlineFor[name] -= 1;
      throw new NetworkError(`${name} failed: TypeError (offline)`);
    }
  };
  const lost = (name) => {
    if (dropFirstResponseOf.has(name)) {
      dropFirstResponseOf.delete(name);
      return true;
    }
    return false;
  };
  const api = {
    openWebSession: async (_t, _team, _case, attemptId) => {
      flaky("open");
      state.opens += 1;
      let s = state.sessions.get(attemptId);
      if (!s) {
        s = { id: SID, reserved: null };
        state.sessions.set(attemptId, s);
      }
      const answer = { session: { captureSessionId: s.id, expiresAtUtc: "", reservedEvidenceId: s.reserved } };
      if (lost("open")) throw new NetworkError("open: response lost");
      return answer;
    },
    reserveEvidence: async () => {
      flaky("reserve");
      const s = [...state.sessions.values()][0];
      if (s.reserved) throw new ApiError(409, "SESSION_ALREADY_RESERVED", "POST evidence -> 409");
      state.records += 1;
      s.reserved = "ev-1";
      if (lost("reserve")) throw new NetworkError("reserve: response lost");
      return { evidence: { evidenceId: "ev-1" } };
    },
    createPart: async () => {
      flaky("part");
      return { upload: { bucket: "b", key: "k", putUrl: "http://s3.local/put" } };
    },
    putBytes: async () => {
      flaky("put");
      state.puts += 1;
    },
    declarePart: async (_t, _s, i, input) => {
      flaky("declare");
      const prior = state.declared.get(i);
      if (prior && prior !== input.sha256) throw new ApiError(409, "PART_ALREADY_DECLARED", "declare -> 409");
      state.declared.set(i, input.sha256);
    },
    webComplete: async () => {
      flaky("seal");
      state.sealed = true;
      if (lost("seal")) throw new NetworkError("seal: response lost");
      return { result: { evidenceId: "ev-1", bound: true, manifestPartIndex: 1 } };
    },
    discardSession: async () => {
      if (state.sealed) throw new ApiError(409, "EVIDENCE_ALREADY_FINALIZED", "discard -> 409");
      return { result: { discarded: true } };
    },
  };
  return { api, state };
}

test("AUD-026: an offline interruption mid-upload is retried and the capture resumes to a seal", async () => {
  const server = idempotentServer({ offlineFor: { put: 2, declare: 1 } });
  const h = harness(server.api);
  const steps = [];
  let waited = 0;
  h.deps.progress = (step, detail) => steps.push([step, detail]);
  h.deps.waitForOnline = async () => {
    waited += 1;
  };
  const r = await runPreserveFlow(h.deps, REQ, new AbortController().signal);
  assert.equal(r.status, "SUCCEEDED");
  assert.equal(server.state.records, 1);
  assert.equal(server.state.sealed, true);
  assert.equal(waited, 3, "every retry first waits for the browser to be online");
  assert.ok(steps.some(([s]) => s === "retrying"));
});

test("AUD-026: a lost open response is retried with the SAME attempt id — one session, one record", async () => {
  const server = idempotentServer({ dropFirstResponseOf: new Set(["open"]) });
  const h = harness(server.api);
  const r = await runPreserveFlow(h.deps, REQ, new AbortController().signal);
  assert.equal(r.status, "SUCCEEDED");
  assert.equal(server.state.sessions.size, 1);
  assert.equal(server.state.records, 1);
});

test("AUD-026: a lost reserve response resumes on the record already reserved (no second record)", async () => {
  const server = idempotentServer({ dropFirstResponseOf: new Set(["reserve"]) });
  const h = harness(server.api);
  const r = await runPreserveFlow(h.deps, REQ, new AbortController().signal);
  assert.equal(r.status, "SUCCEEDED");
  assert.equal(r.evidenceId, "ev-1");
  assert.equal(server.state.records, 1);
});

test("AUD-026: a lost seal response is retried; the re-seal of a sealed session is success", async () => {
  const server = idempotentServer({ dropFirstResponseOf: new Set(["seal"]) });
  const h = harness(server.api);
  const r = await runPreserveFlow(h.deps, REQ, new AbortController().signal);
  assert.equal(r.status, "SUCCEEDED");
  assert.equal(server.state.records, 1);
});

test("AUD-026: a definite 4xx refusal is never retried", async () => {
  let puts = 0;
  const h = harness({
    putBytes: async () => {
      puts += 1;
      throw new ApiError(403, null, "PUT object -> 403");
    },
  });
  const r = await runPreserveFlow(h.deps, REQ, new AbortController().signal);
  assert.equal(r.status, "FAILED");
  assert.equal(puts, 1);
});

test("AUD-026: retries are bounded — a network that never returns ends FAILED and discards", async () => {
  let puts = 0;
  const h = harness({
    putBytes: async () => {
      puts += 1;
      throw new NetworkError("offline");
    },
  });
  const r = await runPreserveFlow(h.deps, REQ, new AbortController().signal);
  assert.equal(r.status, "FAILED");
  assert.equal(r.outcome, "NOTHING_SAVED");
  assert.equal(puts, 4);
  assert.ok(h.calls.some((c) => c[0] === "discard"));
});

test("AUD-026: cancel during a retry wait stops the upload and discards the session", async () => {
  const controller = new AbortController();
  const h = harness({
    putBytes: async () => {
      throw new NetworkError("offline");
    },
  });
  h.deps.sleep = async () => controller.abort();
  const r = await runPreserveFlow(h.deps, REQ, controller.signal);
  assert.equal(r.status, "FAILED");
  assert.equal(r.reason, "CANCELLED");
  assert.ok(h.calls.some((c) => c[0] === "discard"));
});

test("AUD-026: cancel requested during the seal does not undo a seal that happened", async () => {
  const controller = new AbortController();
  const h = harness({
    webComplete: async () => {
      controller.abort();
      return { result: { evidenceId: "ev-1", bound: true, manifestPartIndex: 1 } };
    },
  });
  const r = await runPreserveFlow(h.deps, REQ, controller.signal);
  assert.equal(r.status, "SUCCEEDED");
  assert.equal(h.calls.some((c) => c[0] === "discard"), false);
});

test("AUD-026: a restricted page is refused before anything is captured or opened", async () => {
  for (const url of ["chrome://settings/", "edge://extensions/", "https://chromewebstore.google.com/detail/x", "https://microsoftedge.microsoft.com/addons/detail/x", "file:///C:/x.html"]) {
    const h = harness();
    let captured = false;
    h.deps.tabUrl = url;
    h.deps.capture = async () => {
      captured = true;
      return capture();
    };
    const r = await runPreserveFlow(h.deps, REQ, new AbortController().signal);
    assert.equal(r.status, "FAILED", url);
    assert.equal(r.reason, "RESTRICTED_PAGE", url);
    assert.equal(r.outcome, "NOTHING_SAVED");
    assert.equal(captured, false);
    assert.equal(h.calls.length, 0, "no server call");
  }
});

test("AUD-026: a scripting refusal the URL could not foresee is RESTRICTED_PAGE, not a generic error", async () => {
  const h = harness();
  h.deps.tabUrl = null;
  h.deps.prepare = async () => {
    throw new Error("Cannot access a chrome:// URL");
  };
  const r = await runPreserveFlow(h.deps, REQ, new AbortController().signal);
  assert.equal(r.reason, "RESTRICTED_PAGE");
  assert.equal(h.calls.length, 0);
});

test("AUD-026: a tab switch or navigation reported by the capture keeps its stable reason", async () => {
  const { CaptureInterruptedError } = await import("./dist/capture.js");
  for (const code of ["TAB_CHANGED", "PAGE_NAVIGATED"]) {
    const h = harness();
    h.deps.capture = async () => {
      throw new CaptureInterruptedError(code);
    };
    const r = await runPreserveFlow(h.deps, REQ, new AbortController().signal);
    assert.equal(r.reason, code);
    assert.equal(r.outcome, "NOTHING_SAVED");
  }
});

test("AUD-026: the attempt id is sent on every open", async () => {
  const h = harness();
  await runPreserveFlow(h.deps, REQ, new AbortController().signal);
  assert.deepEqual(h.calls.find((c) => c[0] === "open")?.[3], "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
});
