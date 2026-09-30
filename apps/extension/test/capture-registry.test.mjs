/**
 * UC-EXT-005 — the background owns capture state: one in-flight capture per
 * tab, an attempt id per capture, and a persisted status a reopened popup reads.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createCaptureRegistry } from "./dist/capture-registry.js";

function memoryStore() {
  let data = {};
  return {
    read: async () => data,
    write: async (all) => {
      data = all;
    },
    peek: () => data,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

const REQ = { mode: "FULL_PAGE", teamId: "t1", caseId: null, tabId: 7, windowId: 1, evidenceType: "PHOTO" };

test("a second PRESERVE for the same tab while the first runs is refused", async () => {
  const gate = deferred();
  let runs = 0;
  let n = 0;
  const reg = createCaptureRegistry({
    store: memoryStore(),
    newId: () => `a${++n}`,
    run: async () => {
      runs += 1;
      await gate.promise;
      return { status: "SUCCEEDED", evidenceId: "e1", limitations: [], completeness: "CAPTURED" };
    },
  });
  const [first, second] = await Promise.all([reg.start(REQ), reg.start(REQ)]);
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "ALREADY_RUNNING");
  // A different tab is independent.
  const other = await reg.start({ ...REQ, tabId: 8 });
  assert.equal(other.accepted, true);
  gate.resolve();
  await first.done;
  await other.done;
  assert.equal(runs, 2);
});

test("a reopened popup reads the running step, then the result, from the persisted status", async () => {
  const gate = deferred();
  const store = memoryStore();
  const reg = createCaptureRegistry({
    store,
    newId: () => "attempt-1",
    run: async (_req, _signal, attemptId) => {
      await reg.progress(7, attemptId, "uploading", "artifact 2/5");
      await gate.promise;
      return { status: "SUCCEEDED", evidenceId: "ev-9", limitations: [], completeness: "CAPTURED" };
    },
  });
  const started = await reg.start(REQ);
  await new Promise((r) => setTimeout(r, 5));
  const mid = await reg.status(7);
  assert.equal(mid.state, "RUNNING");
  assert.equal(mid.step, "uploading");
  assert.equal(mid.attemptId, "attempt-1");
  gate.resolve();
  await started.done;
  const end = await reg.status(7);
  assert.equal(end.state, "SUCCEEDED");
  assert.equal(end.evidenceId, "ev-9");
  // Persisted (chrome.storage.session in production), keyed by tab.
  assert.equal(store.peek()["7"].state, "SUCCEEDED");
});

test("a RUNNING status with no live attempt (service worker restarted) reads as UNKNOWN, never 'nothing saved'", async () => {
  const store = memoryStore();
  await store.write({
    7: {
      attemptId: "old",
      tabId: 7,
      mode: "VIEWPORT",
      teamId: "t1",
      caseId: null,
      state: "RUNNING",
      step: "sealing",
      detail: null,
      outcome: null,
      reason: null,
      denial: null,
      evidenceId: "ev-1",
      cancelRequested: false,
      startedAtMs: Date.now(),
      updatedAtMs: Date.now(),
    },
  });
  const reg = createCaptureRegistry({
    store,
    newId: () => "x",
    run: async () => {
      throw new Error("unused");
    },
  });
  const s = await reg.status(7);
  assert.equal(s.state, "FAILED");
  assert.equal(s.outcome, "UNKNOWN");
  assert.equal(s.reason, "INTERRUPTED");
});

test("cancel aborts the running attempt's signal", async () => {
  let seen = null;
  const reg = createCaptureRegistry({
    store: memoryStore(),
    newId: () => "c1",
    run: async (_req, signal) => {
      await new Promise((r) => signal.addEventListener("abort", r, { once: true }));
      seen = signal.aborted;
      return { status: "FAILED", outcome: "NOTHING_SAVED", reason: "CANCELLED", denial: null, evidenceId: null, detail: "" };
    },
  });
  const started = await reg.start(REQ);
  assert.equal(await reg.cancel(7), true);
  const final = await started.done;
  assert.equal(seen, true);
  assert.equal(final.reason, "CANCELLED");
  assert.equal(await reg.cancel(7), false, "nothing left to cancel");
});

test("after a result, the same tab can capture again (retry)", async () => {
  let n = 0;
  const reg = createCaptureRegistry({
    store: memoryStore(),
    newId: () => `r${++n}`,
    run: async () => ({ status: "FAILED", outcome: "NOTHING_SAVED", reason: "ERROR", denial: null, evidenceId: null, detail: "" }),
  });
  const a = await reg.start(REQ);
  await a.done;
  const b = await reg.start(REQ);
  assert.equal(b.accepted, true);
  assert.notEqual(b.attemptId, a.attemptId);
  await b.done;
});
